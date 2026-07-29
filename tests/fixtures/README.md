# Test fixtures

This directory is intentionally almost empty.

Audio fixtures are **generated at test time** with ffmpeg's own `sine` and
`anullsrc` sources (see `tests/integration/audio-pipeline.test.ts`). Committing
binary audio would bloat the repository, and generated fixtures cannot drift
from the ffmpeg version actually under test.

CI never uses a real microphone and never downloads a model:

- capture is exercised through `FfmpegCapture.buildArgs()` and the FLAC writer,
  both of which take synthetic PCM;
- ASR runs through `FakeAsr`, which reads an optional `<audio>.expected.txt`
  sidecar next to the fixture;
- the LLM runs through `FakeLlm`, which makes no network call.

To pin a specific transcript for a fixture, drop `<name>.expected.txt` beside
`<name>.wav`/`<name>.flac` and `FakeAsr` will return its contents verbatim.
