# OpenMurmurCapture (planned — P1-01)

A native Swift capture helper using `AVAudioEngine`, to replace FFmpeg +
AVFoundation as the default capture backend.

**Nothing here is implemented.** This document records the design so the
interface in `src/capture/backend.ts` stays honest about what it is for.

## Why FFmpeg is the MVP backend

A native helper that behaves well under macOS TCC should be code-signed, which
requires an Apple Developer Program membership ($99/year). Requiring that to run
an open-source project from source would exclude most users and contributors on
day one.

See [ADR-0003](../../docs/adr/0003-capture-backend.md).

## What FFmpeg costs us

| Limitation | Consequence |
| --- | --- |
| Imprecise TCC errors | macOS reports a permission denial as a device-open failure, so `classifyFfmpegFailure` matches on message text. A wrong guess costs a less helpful error string, never correctness. |
| No route-change notifications | Unplugging a USB microphone looks like a stream ending, not a device change. The health check catches it within 15 seconds. |
| An extra process | One more thing to supervise, and a pipe between it and the daemon. |
| Timestamps assigned on receipt | Frames carry pipe scheduling jitter. Irrelevant at 32 ms granularity for session boundaries; word-level alignment comes from the ASR model instead. |

## What the native helper would provide

- `AVAudioSession` / `AVAudioEngine` with an explicit, distinguishable
  permission state (`AVCaptureDevice.authorizationStatus`).
- Route-change and configuration-change notifications, so switching microphones
  is handled rather than looking like a failure.
- Hardware-referenced timestamps.
- A stable, signed identity, so a TCC grant survives a rebuild.
- No extra process if built as a framework, or a small signed helper if not.

## Interface it must satisfy

```ts
interface CaptureBackend {
  readonly name: string;
  start(): AsyncIterableIterator<CaptureFrame>;
  stop(): Promise<void>;
  msSinceLastFrame(): number | null;
}
```

`start()` yielding its first frame is the daemon's proof that the microphone is
genuinely open — it gates the `🟢 Запись включена` message. A native
implementation must preserve that: **do not signal readiness before real audio
arrives.**

## Sketch

```
native/OpenMurmurCapture/
├── Package.swift
├── Sources/OpenMurmurCapture/
│   ├── main.swift               # NDJSON control on stdin, PCM on stdout
│   ├── AudioCapture.swift       # AVAudioEngine tap → 16 kHz mono s16le
│   ├── Permissions.swift        # explicit TCC state
│   └── RouteMonitor.swift       # device change handling
└── Tests/
```

The wire format would mirror the FFmpeg backend — raw 16-bit mono PCM on stdout
— so `FfmpegCapture` and the native helper differ only in how the process is
started and how errors are reported.

## Acceptance criteria (P1-01)

- A permission denial is distinguishable from a missing device, in code.
- Switching the input device does not drop or corrupt an active session.
- Frame timing is at least as stable as the FFmpeg backend.
- The daemon runs unchanged apart from backend selection.
- Building from source still works without an Apple Developer account, even if
  the resulting binary is unsigned.

That last point is a hard requirement. Signing may improve behaviour; it must
never be the price of running the project.
