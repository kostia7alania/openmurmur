# ADR-0003: FFmpeg + AVFoundation for capture

**Status:** Accepted · **Date:** 2026-07-29 · **Supersedes:** nothing ·
**Superseded by:** planned, P1-01

## Context

The daemon needs continuous microphone capture on macOS. Options:

1. FFmpeg with the `avfoundation` input device.
2. A native Swift helper using `AVAudioEngine`.
3. A Node native addon wrapping CoreAudio.

The decisive constraint: **a native helper that behaves well under macOS TCC
should be code-signed**, which requires an Apple Developer Program membership
($99/year). Requiring that to run an open-source project from source would
exclude most potential users and contributors on day one.

## Decision

Ship FFmpeg + AVFoundation as the MVP backend, behind a `CaptureBackend`
interface. Document the native helper as P1-01 and keep the interface narrow
enough that adding it touches nothing else.

## Consequences

**Positive.** Works immediately with `brew install ffmpeg`. No certificate, no
native build, no `node-gyp`. FFmpeg already handles resampling and format
conversion, and is needed anyway for FLAC encoding and incoming-file validation.
The `CaptureBackend` interface means a native helper is additive.

**Negative — stated plainly:**

- **Imprecise TCC errors.** macOS reports a permission denial as a device-open
  failure, so `classifyFfmpegFailure` matches on the message text. Getting that
  wrong costs a less helpful error string, never correctness.
- **No route-change notifications.** Unplugging a USB microphone is seen as a
  stream ending, not as a device change. The health check catches it within
  15 seconds and alerts.
- **An extra process** with a pipe between it and the daemon.
- **Frame timestamps are assigned on receipt**, not at the hardware, so they
  carry pipe scheduling jitter. Irrelevant at 32 ms granularity for session
  boundaries; it would matter for word-level alignment, which is why alignment
  comes from the ASR model instead.

## Interface

```ts
interface CaptureBackend {
  readonly name: string;
  start(): AsyncIterableIterator<CaptureFrame>;
  stop(): Promise<void>;
  msSinceLastFrame(): number | null;
}
```

`start()` yielding its first frame is the daemon's proof that the microphone is
genuinely open — it is what gates the `🟢 Запись включена` message.

## Alternatives

**Swift helper now.** Better errors and device handling, but requires a
certificate to distribute well and adds a Swift toolchain to the build. Deferred
to P1-01, not rejected.

**Native Node addon.** All the certificate problems plus `node-gyp`, and it
would put audio-thread code in the daemon's process. Rejected.
