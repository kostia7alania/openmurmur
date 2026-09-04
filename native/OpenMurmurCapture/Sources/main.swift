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

private func runAuthorizationRequest() -> Never {
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

private func runAuthorization() -> Never {
    guard let executableURL = Bundle.main.executableURL else {
        terminate(Exit.software, "authorization launcher is unavailable")
    }

    let child = Process()
    child.executableURL = executableURL
    child.arguments = ["--request-authorization"]
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.standardOutput
    child.standardError = FileHandle.standardError
    do {
        try child.run()
        child.waitUntilExit()
    } catch {
        terminate(Exit.unavailable, "authorization launcher failed")
    }
    switch child.terminationReason {
    case .exit:
        Darwin.exit(child.terminationStatus)
    case .uncaughtSignal:
        Darwin.exit(128 + child.terminationStatus)
    @unknown default:
        Darwin.exit(Exit.software)
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

private func runDaemonSupervisor(_ arguments: [String]) -> Never {
    guard arguments.count == 3 else {
        terminate(
            Exit.usage,
            "usage: OpenMurmurCapture --supervise-daemon NODE MAIN STATE_ROOT"
        )
    }

    let nodePath = arguments[0]
    let mainPath = arguments[1]
    let stateRoot = arguments[2]
    let paths = [nodePath, mainPath, stateRoot]
    guard paths.allSatisfy({ path in
        path.hasPrefix("/")
            && path.utf8.count <= 4_096
            && URL(fileURLWithPath: path).standardizedFileURL.path == path
    }),
        FileManager.default.isExecutableFile(atPath: nodePath),
        FileManager.default.isReadableFile(atPath: mainPath)
    else {
        terminate(Exit.usage, "daemon supervisor paths are invalid")
    }

    let child = Process()
    child.executableURL = URL(fileURLWithPath: nodePath)
    child.arguments = [mainPath, "start", "--root", stateRoot]
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.standardOutput
    child.standardError = FileHandle.standardError

    child.terminationHandler = { process in
        switch process.terminationReason {
        case .exit:
            Darwin.exit(process.terminationStatus)
        case .uncaughtSignal:
            Darwin.exit(128 + process.terminationStatus)
        @unknown default:
            Darwin.exit(Exit.software)
        }
    }

    do {
        try child.run()
    } catch {
        terminate(Exit.unavailable, "daemon supervisor could not start Node")
    }

    let terminationSignal = installSignalSource(SIGTERM) {
        if child.isRunning {
            Darwin.kill(child.processIdentifier, SIGTERM)
        }
    }
    let interruptSignal = installSignalSource(SIGINT) {
        if child.isRunning {
            Darwin.kill(child.processIdentifier, SIGINT)
        }
    }
    withExtendedLifetime([terminationSignal, interruptSignal]) {
        dispatchMain()
    }
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
    let handoffFrameCapacity = captureHandoffFrameCapacity(
        format: inputFormat,
        requestedFrames: tapFrames
    )
    guard let handoff = BoundedAudioHandoff(
        format: inputFormat,
        frameCapacity: handoffFrameCapacity,
        capacity: 64
    ) else {
        terminate(Exit.software, "capture failed: audio buffer allocation")
    }

    let failures = DispatchSource.makeUserDataOrSource(queue: .main)
    var isTerminating = false
    var tapInstalled = false
    var pendingDeviceTermination: DispatchWorkItem?
    let terminateStream = { (failure: StreamFailure) -> Never in
        isTerminating = true
        pendingDeviceTermination?.cancel()
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine.stop()
        terminate(failure.exitCode, failure.diagnostic)
    }
    failures.setEventHandler {
        guard !isTerminating else {
            return
        }
        let failure = StreamFailure.select(from: failures.data)
        if failure == .deviceChanged {
            guard pendingDeviceTermination == nil else {
                return
            }
            let work = DispatchWorkItem {
                guard !isTerminating else {
                    return
                }
                terminateStream(.deviceChanged)
            }
            pendingDeviceTermination = work
            // macOS may publish a configuration change immediately before its
            // authoritative sleep event. Give that main-queue event one bounded
            // chance to override the otherwise terminal device transition.
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100), execute: work)
            return
        }
        terminateStream(failure)
    }
    failures.resume()

    // Register before starting the worker, tap or engine. Device failures get
    // a bounded grace period so a sleep notification already queued on this
    // same main queue can take authoritative precedence.
    let sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.willSleepNotification,
        object: nil,
        queue: .main
    ) { _ in
        guard !isTerminating else {
            return
        }
        terminateStream(
            StreamFailure.select(from: failures.data, authoritativeSleep: true)
        )
    }

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
    tapInstalled = true

    do {
        engine.prepare()
        try engine.start()
    } catch {
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        let work = DispatchWorkItem {
            guard !isTerminating else {
                return
            }
            isTerminating = true
            terminate(Exit.unavailable, "capture failed: input device unavailable")
        }
        pendingDeviceTermination = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100), execute: work)
        dispatchMain()
    }

    // Some devices issue an engine-configuration notification as part of the
    // initial start. Arm failure monitoring only after that transition succeeds.
    let engineObserver = NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: engine,
        queue: .main
    ) { _ in
        failures.or(data: StreamFailure.deviceChanged.rawValue)
    }
    var signalSources: [DispatchSourceSignal] = []
    let stopNormally = {
        guard !isTerminating else {
            return
        }
        isTerminating = true
        pendingDeviceTermination?.cancel()
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
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
    guard StreamFailure.select(
        from: StreamFailure.deviceChanged.rawValue,
        authoritativeSleep: true
    ) == .systemSleep,
        StreamFailure.select(
            from: StreamFailure.handoffOverflow.rawValue,
            authoritativeSleep: true
        ) == .handoffOverflow
    else {
        terminate(Exit.software, "self-check failed: sleep failure priority")
    }

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
        let requestedTapFrames: AVAudioFrameCount = 1_024
        let handoffFrameCapacity = captureHandoffFrameCapacity(
            format: inputFormat,
            requestedFrames: requestedTapFrames
        )
        guard input.frameLength > requestedTapFrames,
              handoffFrameCapacity >= input.frameLength
        else {
            terminate(Exit.software, "self-check failed: advisory tap capacity")
        }
        guard let handoff = BoundedAudioHandoff(
            format: inputFormat,
            frameCapacity: handoffFrameCapacity,
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
guard let mode = arguments.first else {
    terminate(
        Exit.usage,
        "usage: OpenMurmurCapture --authorize|--authorization-status|--source-digest|--stream|--self-check|--supervise-daemon"
    )
}

switch mode {
case "--authorize":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid authorization invocation") }
    runAuthorization()
case "--request-authorization":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid authorization request") }
    runAuthorizationRequest()
case "--authorization-status":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid status invocation") }
    runAuthorizationStatus()
case "--source-digest":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid digest invocation") }
    runSourceDigest()
case "--stream":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid stream invocation") }
    runStream()
case "--self-check":
    guard arguments.count == 1 else { terminate(Exit.usage, "invalid self-check invocation") }
    runSelfCheck()
case "--supervise-daemon":
    runDaemonSupervisor(Array(arguments.dropFirst()))
default:
    terminate(
        Exit.usage,
        "usage: OpenMurmurCapture --authorize|--authorization-status|--source-digest|--stream|--self-check|--supervise-daemon"
    )
}
