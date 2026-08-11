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

`summary-acceptance.json` is a deterministic RU/EN/TH acceptance corpus. Its
checked-in golden candidates measure the evaluator itself: 18 exact normalized
claims grounded by transcript terms, minimum 80% claim recall, 100% claim
precision, zero forbidden facts and 100% passing cases. Transcript copies and
unlisted inventions fail precision even when recall passes. This is not a
real-model quality claim. Running the same corpus against local Ollama is tracked
separately as D108; the current measured result and unmet acceptance boundary
are recorded in `docs/DEPENDENCIES.md`.

To pin a specific transcript for a fixture, drop `<name>.expected.txt` beside
`<name>.wav`/`<name>.flac` and `FakeAsr` will return its contents verbatim.
