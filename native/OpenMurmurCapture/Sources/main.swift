import AppKit
import AVFoundation
import Darwin
import Foundation

private enum Exit {
    static let usage: Int32 = 64
    static let unavailable: Int32 = 69
    static let software: Int32 = 70
    static let notAuthorized: Int32 = 77
}

private func writeDiagnostic(_ message: String) {
    let bounded = String(message.prefix(480)) + "\n"
    FileHandle.standardError.write(Data(bounded.utf8))
}

private func terminate(_ code: Int32, _ diagnostic: String) -> Never {
    writeDiagnostic(diagnostic)
    Darwin.exit(code)
}

private func runAuthorization() -> Never {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    application.activate(ignoringOtherApps: true)

    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        terminate(0, "microphone authorization: granted")
    case .denied, .restricted:
        terminate(Exit.notAuthorized, "microphone authorization: denied")
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                if granted {
                    terminate(0, "microphone authorization: granted")
                }
                terminate(Exit.notAuthorized, "microphone authorization: denied")
            }
        }
        dispatchMain()
    @unknown default:
        terminate(Exit.notAuthorized, "microphone authorization: unavailable")
    }
}

private func runAuthorizationStatus() -> Never {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    let payload: String
    switch status {
    case .authorized:
        payload = "{\"authorized\":true,\"status\":\"authorized\"}\n"
    case .denied:
        payload = "{\"authorized\":false,\"status\":\"denied\"}\n"
    case .restricted:
        payload = "{\"authorized\":false,\"status\":\"restricted\"}\n"
    case .notDetermined:
        payload = "{\"authorized\":false,\"status\":\"not_determined\"}\n"
    @unknown default:
        payload = "{\"authorized\":false,\"status\":\"unavailable\"}\n"
    }
    FileHandle.standardOutput.write(Data(payload.utf8))
    Darwin.exit(status == .authorized ? 0 : Exit.notAuthorized)
}

private func runSourceDigest() -> Never {
    guard let digestURL = Bundle.main.url(
        forResource: "source",
        withExtension: "sha256"
    ),
        let data = try? Data(contentsOf: digestURL),
        data.count <= 128,
        let text = String(data: data, encoding: .utf8)
    else {
        terminate(Exit.software, "source digest unavailable")
    }
    let digest = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let isLowercaseSHA256 = digest.utf8.count == 64 && digest.utf8.allSatisfy {
        (48 ... 57).contains($0) || (97 ... 102).contains($0)
    }
    guard isLowercaseSHA256 else {
        terminate(Exit.software, "source digest invalid")
    }
    FileHandle.standardOutput.write(Data("\(digest)\n".utf8))
    Darwin.exit(0)
}

private func installSignalSource(
    _ signalNumber: Int32,
    handler: @escaping () -> Void
) -> DispatchSourceSignal {
    Darwin.signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler(handler: handler)
    source.resume()
    return source
}

private func runStream() -> Never {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        terminate(
            Exit.notAuthorized,
            "microphone authorization required: run --authorize from the GUI"
        )
    }

    Darwin.signal(SIGPIPE, SIG_IGN)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
        terminate(Exit.unavailable, "capture failed: no input device")
    }

    let converter: PCMConverter
    do {
        converter = try PCMConverter(inputFormat: inputFormat)
    } catch {
        terminate(Exit.software, "capture failed: unsupported input format")
    }

    let tapFrames: AVAudioFrameCount = 1_024
    guard let handoff = BoundedAudioHandoff(
        format: inputFormat,
        frameCapacity: tapFrames,
        capacity: 64
    ) else {
        terminate(Exit.software, "capture failed: audio buffer allocation")
    }

    let failures = DispatchSource.makeUserDataOrSource(queue: .main)
    var isTerminating = false
    failures.setEventHandler {
        guard !isTerminating else {
            return
        }
        isTerminating = true
        let failure = StreamFailure.select(from: failures.data)
        input.removeTap(onBus: 0)
        engine.stop()
        terminate(failure.exitCode, failure.diagnostic)
    }
    failures.resume()

    let worker = PCMOutputWorker(
        converter: converter,
        handoff: handoff,
        failures: failures
    )
    worker.start()

    input.installTap(onBus: 0, bufferSize: tapFrames, format: inputFormat) { buffer, _ in
        if !handoff.offer(buffer) {
            failures.or(data: StreamFailure.handoffOverflow.rawValue)
        }
    }

    do {
        engine.prepare()
        try engine.start()
    } catch {
        input.removeTap(onBus: 0)
        terminate(Exit.unavailable, "capture failed: input device unavailable")
    }

    // Some devices issue an engine-configuration notification as part of the
    // initial start. Arm failure monitoring only after that transition succeeds.
    let engineObserver = NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: engine,
        queue: nil
    ) { _ in
        failures.or(data: StreamFailure.deviceChanged.rawValue)
    }
    let sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.willSleepNotification,
        object: nil,
        queue: nil
    ) { _ in
        failures.or(data: StreamFailure.systemSleep.rawValue)
    }

    var signalSources: [DispatchSourceSignal] = []
    let stopNormally = {
        guard !isTerminating else {
            return
        }
        isTerminating = true
        input.removeTap(onBus: 0)
        engine.stop()
        Darwin.exit(0)
    }
    signalSources.append(installSignalSource(SIGTERM, handler: stopNormally))
    signalSources.append(installSignalSource(SIGINT, handler: stopNormally))

    if !engine.isRunning {
        failures.or(data: StreamFailure.deviceChanged.rawValue)
    }

    withExtendedLifetime((engineObserver, sleepObserver, signalSources, worker)) {
        dispatchMain()
    }
}

private func runSelfCheck() -> Never {
    guard let inputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 48_000,
        channels: 2,
        interleaved: false
    ),
        let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 4_800)
    else {
        terminate(Exit.software, "self-check failed: fixture allocation")
    }

    input.frameLength = input.frameCapacity
    guard let channels = input.floatChannelData else {
        terminate(Exit.software, "self-check failed: fixture format")
    }
    for channel in 0 ..< Int(inputFormat.channelCount) {
        for frame in 0 ..< Int(input.frameLength) {
            channels[channel][frame] = frame.isMultiple(of: 2) ? 0.25 : -0.25
        }
    }

    do {
        let converter = try PCMConverter(inputFormat: inputFormat)
        guard let handoff = BoundedAudioHandoff(
            format: inputFormat,
            frameCapacity: input.frameCapacity,
            capacity: 2
        ),
            handoff.offer(input),
            handoff.offer(input),
            !handoff.offer(input)
        else {
            terminate(Exit.software, "self-check failed: bounded handoff")
        }
        let captured = handoff.take()
        let output = try converter.convert(captured)
        handoff.release()
        guard handoff.offer(input) else {
            terminate(Exit.software, "self-check failed: handoff release")
        }
        for _ in 0 ..< 2 {
            _ = handoff.take()
            handoff.release()
        }
        guard converter.outputFormat.sampleRate == PCMConverter.outputSampleRate,
              converter.outputFormat.channelCount == PCMConverter.outputChannels,
              !output.isEmpty,
              output.count.isMultiple(of: MemoryLayout<Int16>.size),
              output.contains(where: { $0 != 0 })
        else {
            terminate(Exit.software, "self-check failed: pcm contract")
        }
    } catch {
        terminate(Exit.software, "self-check failed: pcm conversion")
    }
    terminate(0, "self-check: 16khz mono s16le conversion passed")
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1 else {
    terminate(
        Exit.usage,
        "usage: OpenMurmurCapture --authorize|--authorization-status|--source-digest|--stream|--self-check"
    )
}

switch arguments[0] {
case "--authorize":
    runAuthorization()
case "--authorization-status":
    runAuthorizationStatus()
case "--source-digest":
    runSourceDigest()
case "--stream":
    runStream()
case "--self-check":
    runSelfCheck()
default:
    terminate(
        Exit.usage,
        "usage: OpenMurmurCapture --authorize|--authorization-status|--source-digest|--stream|--self-check"
    )
}
