import AVFoundation
import Foundation

enum StreamFailure: UInt {
    case outputWrite = 1
    case conversion = 2
    case handoffOverflow = 4
    case deviceChanged = 8
    case systemSleep = 16

    var exitCode: Int32 {
        switch self {
        case .outputWrite:
            return 74
        case .conversion:
            return 70
        case .handoffOverflow:
            return 75
        case .deviceChanged:
            return 76
        case .systemSleep:
            return 75
        }
    }

    var diagnostic: String {
        switch self {
        case .outputWrite:
            return "capture failed: pcm output closed"
        case .conversion:
            return "capture failed: pcm conversion"
        case .handoffOverflow:
            return "capture failed: audio handoff overflow"
        case .deviceChanged:
            return "capture failed: input device changed"
        case .systemSleep:
            return "capture failed: system sleep"
        }
    }

    static func select(from bits: UInt, authoritativeSleep: Bool = false) -> StreamFailure {
        let sleepCompatibleBits = StreamFailure.deviceChanged.rawValue
            | StreamFailure.systemSleep.rawValue
        if authoritativeSleep, bits & ~sleepCompatibleBits == 0 {
            return .systemSleep
        }
        let priority: [StreamFailure] = [
            .handoffOverflow,
            .outputWrite,
            .conversion,
            .deviceChanged,
            .systemSleep,
        ]
        return priority.first(where: { bits & $0.rawValue != 0 }) ?? .conversion
    }
}

enum PCMConversionError: Error {
    case unsupportedFormat
    case conversionFailed
    case missingOutput
}

final class PCMConverter {
    static let outputSampleRate = 16_000.0
    static let outputChannels: AVAudioChannelCount = 1

    let outputFormat: AVAudioFormat

    private let converter: AVAudioConverter

    init(inputFormat: AVAudioFormat) throws {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let outputFormat = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: Self.outputSampleRate,
                  channels: Self.outputChannels,
                  interleaved: true
              ),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        else {
            throw PCMConversionError.unsupportedFormat
        }
        self.outputFormat = outputFormat
        self.converter = converter
    }

    func convert(_ input: AVAudioPCMBuffer) throws -> Data {
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let estimatedFrames = ceil(Double(input.frameLength) * ratio) + 256
        guard estimatedFrames <= Double(UInt32.max),
              let output = AVAudioPCMBuffer(
                  pcmFormat: outputFormat,
                  frameCapacity: AVAudioFrameCount(estimatedFrames)
              )
        else {
            throw PCMConversionError.conversionFailed
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return input
        }

        guard conversionError == nil, status != .error else {
            throw PCMConversionError.conversionFailed
        }
        guard output.frameLength > 0 else {
            return Data()
        }

        let buffers = UnsafeMutableAudioBufferListPointer(output.mutableAudioBufferList)
        guard buffers.count == 1, let bytes = buffers[0].mData else {
            throw PCMConversionError.missingOutput
        }
        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        guard Int(buffers[0].mDataByteSize) >= byteCount else {
            throw PCMConversionError.missingOutput
        }
        return Data(bytes: bytes, count: byteCount)
    }
}

/// A single-producer/single-consumer ring. The audio tap only attempts an
/// immediate semaphore acquisition; a slow converter or pipe therefore fails
/// capture explicitly instead of blocking or silently dropping microphone data.
final class BoundedAudioHandoff {
    private let buffers: [AVAudioPCMBuffer]
    private let freeSlots: DispatchSemaphore
    private let readySlots = DispatchSemaphore(value: 0)
    private var readIndex = 0
    private var writeIndex = 0

    init?(format: AVAudioFormat, frameCapacity: AVAudioFrameCount, capacity: Int) {
        guard capacity > 0 else {
            return nil
        }
        var allocated: [AVAudioPCMBuffer] = []
        allocated.reserveCapacity(capacity)
        for _ in 0 ..< capacity {
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: frameCapacity
            ) else {
                return nil
            }
            allocated.append(buffer)
        }
        buffers = allocated
        freeSlots = DispatchSemaphore(value: capacity)
    }

    func offer(_ source: AVAudioPCMBuffer) -> Bool {
        guard freeSlots.wait(timeout: .now()) == .success else {
            return false
        }
        let destination = buffers[writeIndex]
        guard copy(source, to: destination) else {
            freeSlots.signal()
            return false
        }
        writeIndex = (writeIndex + 1) % buffers.count
        readySlots.signal()
        return true
    }

    func take() -> AVAudioPCMBuffer {
        readySlots.wait()
        return buffers[readIndex]
    }

    func release() {
        let buffer = buffers[readIndex]
        buffer.frameLength = 0
        readIndex = (readIndex + 1) % buffers.count
        freeSlots.signal()
    }

    private func copy(_ source: AVAudioPCMBuffer, to destination: AVAudioPCMBuffer) -> Bool {
        guard source.frameLength <= destination.frameCapacity else {
            return false
        }

        destination.frameLength = destination.frameCapacity
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(
            destination.mutableAudioBufferList
        )
        guard sourceBuffers.count == destinationBuffers.count else {
            destination.frameLength = 0
            return false
        }

        for index in sourceBuffers.indices {
            let sourceBuffer = sourceBuffers[index]
            let byteCount = Int(sourceBuffer.mDataByteSize)
            guard byteCount <= Int(destinationBuffers[index].mDataByteSize),
                  let sourceBytes = sourceBuffer.mData,
                  let destinationBytes = destinationBuffers[index].mData
            else {
                destination.frameLength = 0
                return false
            }
            memcpy(destinationBytes, sourceBytes, byteCount)
            destinationBuffers[index].mDataByteSize = sourceBuffer.mDataByteSize
        }
        destination.frameLength = source.frameLength
        return true
    }
}

final class PCMOutputWorker {
    private let converter: PCMConverter
    private let handoff: BoundedAudioHandoff
    private let failures: DispatchSourceUserDataOr
    private let queue = DispatchQueue(
        label: "io.openmurmur.capture.pcm-output",
        qos: .userInitiated
    )

    init(
        converter: PCMConverter,
        handoff: BoundedAudioHandoff,
        failures: DispatchSourceUserDataOr
    ) {
        self.converter = converter
        self.handoff = handoff
        self.failures = failures
    }

    func start() {
        queue.async { [converter, handoff, failures] in
            while true {
                let input = handoff.take()
                do {
                    let pcm = try converter.convert(input)
                    if !pcm.isEmpty {
                        try FileHandle.standardOutput.write(contentsOf: pcm)
                    }
                } catch is PCMConversionError {
                    failures.or(data: StreamFailure.conversion.rawValue)
                    return
                } catch {
                    failures.or(data: StreamFailure.outputWrite.rawValue)
                    return
                }
                handoff.release()
            }
        }
    }
}
