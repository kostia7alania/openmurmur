import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AsrBackend, AsrRequest, AsrResult } from './types.ts';

/**
 * Deterministic ASR stand-in for CI and for `--fake` local runs.
 *
 * CI must never download a 1.7B model or touch Metal, but the delivery,
 * retention and rejection paths still need a transcript to carry. If a
 * `<audio>.expected.txt` sidecar exists next to the fixture, its contents are
 * returned; otherwise a stable synthetic line is produced from the filename.
 */
export class FakeAsr implements AsrBackend {
  readonly name = 'fake';

  async ready(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    const sidecar = `${request.audioPath.replace(/\.[^.]+$/, '')}.expected.txt`;
    let text: string;
    try {
      text = (await readFile(sidecar, 'utf8')).trim();
    } catch {
      text = `fake transcript for ${basename(request.audioPath)}`;
    }

    return {
      text,
      languages: ['en'],
      segments: [
        {
          startMs: 0,
          endMs: null,
          timestampSource: 'vad',
          language: 'en',
          text,
        },
      ],
      engine: 'fake',
      model: 'fake-asr-0',
      durationMs: 0,
    };
  }

  async close(): Promise<void> {}
}

/** Returns an empty transcript, to exercise the `asr_empty` rejection path. */
export class SilentFakeAsr implements AsrBackend {
  readonly name = 'fake-silent';
  async ready(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async transcribe(): Promise<AsrResult> {
    return {
      text: '',
      languages: [],
      segments: [],
      engine: 'fake',
      model: 'fake-asr-0',
      durationMs: 0,
    };
  }
  async close(): Promise<void> {}
}
