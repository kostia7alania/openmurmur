# OpenMurmurCapture

A native Swift capture helper using `AVAudioEngine`. It owns microphone access
under the stable `io.openmurmur.capture` bundle identity and writes raw mono
16 kHz signed 16-bit little-endian PCM to stdout.

## Permission modes

- `--authorize` is the only mode that can display the macOS microphone prompt.
  Launch it explicitly as a GUI app before starting a background daemon. The
  GUI process starts one private authorization child so TCC records the signed
  app as the responsible identity instead of the shell or installer that opened
  it.
- `--stream` never requests permission. It exits with code 77 unless permission
  was already granted.
- `--authorization-status` returns fixed JSON and exits 0 when authorized or 77
  otherwise. It never requests permission or opens an audio device.
- `--source-digest` prints the signed bundle's lowercase source SHA-256 and does
  not inspect TCC or audio hardware.
- `--self-check` converts synthetic PCM without opening or enumerating an audio
  device. Build automation uses this mode.
- `--supervise-daemon NODE MAIN STATE_ROOT` is the launchd-only parent process.
  Its fixed argument grammar can start only `NODE MAIN start --root STATE_ROOT`;
  keeping the signed app as the responsible process lets macOS apply its
  microphone grant to the capture child without granting an arbitrary command
  runner the same capability.

stdout is reserved for PCM in stream mode. Diagnostics are fixed, bounded
messages on stderr; status and source-digest modes return their documented
machine-readable stdout only.

## Realtime boundary

The AVAudioEngine tap only copies into one of 64 preallocated buffers after a
nonblocking semaphore acquisition. A serial worker performs resampling,
downmixing, Int16 conversion and stdout writes. If the ring is full, capture
terminates explicitly instead of blocking the realtime callback or silently
dropping samples.

Configuration changes, system sleep, conversion errors and broken stdout all
terminate with stable nonzero codes. When the helper receives `willSleep`, it
stops the tap and engine immediately, emits the fixed `capture failed: system sleep`
diagnostic and exits; it does not claim a sleep duration or resume the old
stream after wake. A bounded handoff tail that had not reached stdout may be
absent. SIGINT and SIGTERM are normal shutdowns.

## Build and self-check

```bash
native/OpenMurmurCapture/build.sh
```

The default build is ad-hoc signed with hardened runtime and the audio-input
entitlement. That is sufficient for compilation and the device-free self-check,
but it is not a distributable or TCC-stable release identity.

The default compiler target is `arm64-apple-macos14.0`. Override
`OPENMURMUR_CAPTURE_TARGET` only when deliberately producing another supported
release slice.

The build directory and all of its existing parents must be real directories,
not symlinks. Compile, signing, verification, digest comparison and self-check
run in a private adjacent staging directory. Only a fully verified app reaches
the final path. An existing app is moved to a private adjacent backup during
that final publish step and restored if publication fails; if rollback itself
fails, both recovery paths are printed and preserved instead of being deleted.

Before signing, the build writes `Contents/Resources/source.sha256`. Its input
manifest is deterministic:

1. Take `Info.plist`, `OpenMurmurCapture.entitlements`, `build.sh`, and every
   regular `Sources/*.swift` file recursively.
2. Sort their paths relative to this directory using bytewise `LC_ALL=C` order.
3. For each path, append `<lowercase SHA-256><two spaces><relative path><LF>`.
4. SHA-256 those exact manifest bytes; write the resulting 64 lowercase hex
   characters plus LF to `source.sha256`.

The build verifies that `--source-digest` returns that value after codesigning,
so an installer can compare release metadata with a resource sealed by the app
signature.

`build.sh --source-digest` computes the same value directly from a source tree
without compiling or signing. It uses a private temporary directory and prints
only the digest, allowing an installer check to compare source and signed bundle
without reimplementing the manifest algorithm.

Release builds set `OPENMURMUR_CAPTURE_CODESIGN_IDENTITY` to a Developer ID
Application identity. They must be notarized and installed at one stable path;
updates must retain the Team ID, bundle ID and designated requirement.

The application is intentionally not launched by the build. Run its explicit
GUI authorization flow only when a user is present:

```bash
open -W "/stable/path/OpenMurmur Capture.app" --args --authorize
```

Opening the bundle executable with `--stream` emits no readiness marker. The
first PCM bytes remain the only proof that capture actually started.

## Stable exit codes

| Code | Meaning |
| ---: | --- |
| 64 | Invalid invocation |
| 69 | Input device unavailable or engine start failed |
| 70 | PCM setup or conversion failed |
| 74 | PCM stdout write failed |
| 75 | Bounded handoff overflow or system sleep (distinguished by exact diagnostic) |
| 76 | Input-device configuration changed |
| 77 | Microphone permission is not granted |
