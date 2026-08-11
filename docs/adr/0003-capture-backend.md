# ADR-0003: FFmpeg foreground default and native launchd capture

**Status:** Amended · **Date:** 2026-08-11 · **Supersedes:** the 2026-07-29
FFmpeg-only decision

## Context

The daemon needs continuous microphone capture on macOS. FFmpeg with the
`avfoundation` input is portable across source checkouts and is already needed
for FLAC encoding and incoming-file validation. It is therefore the lowest-cost
foreground default.

That does not create a reliable background TCC identity. A microphone prompt
shown for Terminal or iTerm proves an interactive FFmpeg run, not that a
LaunchAgent's hardened Node process can open the device. launchd cannot safely
surface a prompt of its own.

The native `OpenMurmur Capture.app` helper now supplies the missing boundary. It
has one bundle ID, one installed path, the hardened-runtime audio-input
entitlement and explicit modes:

- `--authorize` is the only mode allowed to request microphone permission;
- `--stream` never prompts and emits only 16 kHz mono s16le PCM;
- `--authorization-status`, `--source-digest` and `--self-check` are read-only
  or device-free probes.

## Decision

Keep `audio.captureBackend="ffmpeg"` as the default for foreground use. Select
the configured backend through the same `CaptureBackend` interface for the
daemon and `capture test`.

Use `audio.captureBackend="native"` for reliable launchd capture. The operator
installs the app at `~/Applications/OpenMurmur Capture.app`, explicitly runs
`pnpm openmurmur capture authorize` in a GUI login session, and then runs
`capture test`. The command reads the non-prompting status first and opens the
GUI flow only for `not_determined`; denied and restricted states get distinct
recovery guidance. No setup, installer, doctor, test, daemon or stream operation
invokes authorization automatically.

The runtime accepts only the canonical installed bundle after strict signature,
bundle ID, entitlement and signed source-digest verification. The first real PCM
frame remains the only recording-readiness proof.

## Signing boundary

The source installer defaults to ad-hoc hardened-runtime signing. That is useful
local evidence: it seals the helper, entitlement and source digest. It is not a
promise that TCC authorization survives a rebuild.

A distributable stable release requires a Developer ID Application identity,
the same Team ID/bundle ID/designated requirement across updates, and
notarization. The repository can build with a supplied Developer ID identity but
does not claim that a notarized release has been produced or live-verified.

## Consequences

**Positive:**

- source contributors retain a zero-runtime-dependency FFmpeg default;
- launchd no longer relies on a Terminal or Node permission identity;
- native permission denial has a stable exit code instead of stderr guessing;
- both backends feed the same bounded PCM and first-frame contracts.

**Negative:**

- background setup has an explicit app install, config and GUI authorization
  step;
- an ad-hoc rebuild can require authorization again;
- the native helper currently supports only the default input device;
- FFmpeg still has imprecise TCC errors and no route-change notifications.

## Interface

```ts
interface CaptureBackend {
  readonly name: string;
  start(): AsyncIterableIterator<CaptureFrame>;
  stop(): Promise<void>;
  msSinceLastFrame(): number | null;
}
```

`start()` yielding its first frame gates `🟢 Запись включена`. A successful
process spawn, signature check or authorization status is never reported as
active recording.

## Rejected alternatives

**Treat a Terminal FFmpeg grant as launchd authorization.** Rejected because it
does not prove the background process identity can open the microphone.

**Authorize from setup, installer or daemon startup.** Rejected because a TCC
prompt must be an explicit user-visible action and background processes may not
be able to show it.

**Native Node addon.** Rejected: it adds `node-gyp`, puts audio-thread code in
the daemon process and still needs a signed TCC identity.
