import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeResponse, encodeRequest, LineSplitter } from '../../src/asr/protocol.ts';
import { sessionIdFromDeliveryPart } from '../../src/cli/daemon.ts';
import { nodeVersionIsSupported, parseAvfoundationDevices } from '../../src/cli/doctor.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../../src/config/schema.ts';
import { openDatabase } from '../../src/database/db.ts';
import {
  buildDigest,
  hasUnfinishedSessionsForDate,
  localDayBounds,
  renderDigest,
  renderDigestMarkdown,
  scheduledDigestDate,
} from '../../src/digest/daily.ts';
import { EnergyVad, rmsDbfs } from '../../src/sessionizer/vad.ts';

describe('config parsing', () => {
  it('accepts an empty object and returns defaults', () => {
    assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  });

  it('merges a partial override without losing the rest', () => {
    const config = parseConfig({ sessionizer: { silenceTimeoutSeconds: 30 } });
    assert.equal(config.sessionizer.silenceTimeoutSeconds, 30);
    assert.equal(config.sessionizer.preRollSeconds, DEFAULT_CONFIG.sessionizer.preRollSeconds);
  });

  it('supports a send-only Telegram instance while receiving remains the default', () => {
    assert.equal(DEFAULT_CONFIG.telegram.receiveUpdates, true);
    assert.equal(
      parseConfig({ telegram: { receiveUpdates: false } }).telegram.receiveUpdates,
      false,
    );
    assert.throws(
      () => parseConfig({ telegram: { receiveUpdates: 'no' } }),
      /telegram\.receiveUpdates.*boolean/,
    );
  });

  it('accepts auto or one forced ASR language, never a fake priority list', () => {
    assert.deepEqual(parseConfig({ asr: { languageHints: [] } }).asr.languageHints, []);
    assert.deepEqual(parseConfig({ asr: { languageHints: ['Thai'] } }).asr.languageHints, ['Thai']);
    assert.throws(
      () => parseConfig({ asr: { languageHints: ['Thai', 'Russian'] } }),
      /at most one forced language/,
    );
    assert.throws(() => parseConfig({ asr: { languageHints: [42] } }), /non-empty strings/);
  });

  it('rejects an unknown key instead of ignoring it', () => {
    // A typo in a threshold name must not silently leave the default in place.
    assert.throws(
      () => parseConfig({ sessionizer: { silence_timeout_seconds: 30 } }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.issues.some((i) => i.includes('sessionizer.silence_timeout_seconds')),
    );
  });

  it('rejects a wrong type', () => {
    assert.throws(
      () => parseConfig({ sessionizer: { silenceTimeoutSeconds: 'sixty' } }),
      /must be a number/,
    );
  });

  it('refuses Telegram limits above what the selected Bot API mode allows', () => {
    assert.throws(
      () => parseConfig({ telegram: { maxOutgoingBytes: 100 * 1024 * 1024 } }),
      /50 MB Bot API sendDocument limit/,
    );
    assert.throws(
      () => parseConfig({ telegram: { maxIncomingBytes: 50 * 1024 * 1024 } }),
      /20 MB Bot API getFile limit/,
    );
    assert.doesNotThrow(() =>
      parseConfig({
        telegram: {
          apiBaseUrl: 'http://127.0.0.1:8081',
          maxIncomingBytes: 512 * 1024 * 1024,
        },
      }),
    );
    assert.throws(
      () =>
        parseConfig({
          telegram: {
            apiBaseUrl: 'http://127.0.0.1:8081',
            maxIncomingBytes: 3 * 1024 * 1024 * 1024,
          },
        }),
      /2 GB/,
    );
  });

  it('refuses a message limit above Telegram’s 4096 characters', () => {
    assert.throws(() => parseConfig({ telegram: { transcriptInlineLimit: 5000 } }), /4096/);
  });

  it('refuses a sample rate the models cannot use', () => {
    assert.throws(() => parseConfig({ audio: { sampleRate: 44_100 } }), /must be 16000/);
    assert.throws(() => parseConfig({ audio: { channels: 2 } }), /must be 1/);
  });

  it('refuses a rotation shorter than the silence timeout', () => {
    // Otherwise a session could rotate before it could ever close.
    assert.throws(
      () => parseConfig({ sessionizer: { maxPartSeconds: 30, silenceTimeoutSeconds: 60 } }),
      /must exceed/,
    );
  });

  it('refuses a VAD threshold outside (0, 1)', () => {
    for (const vadThreshold of [0, 1, 1.5, -0.2]) {
      assert.throws(() => parseConfig({ sessionizer: { vadThreshold } }), /between 0 and 1/);
    }
  });

  it('allows only the official or a structurally local Telegram endpoint', () => {
    assert.doesNotThrow(() =>
      parseConfig({ telegram: { apiBaseUrl: 'https://api.telegram.org' } }),
    );
    assert.doesNotThrow(() => parseConfig({ telegram: { apiBaseUrl: 'http://127.0.0.1:8081' } }));
    for (const apiBaseUrl of [
      'https://evil.example',
      'http://evil.example',
      'https://api.telegram.org.evil.example',
      'https://user:password@api.telegram.org',
      'https://api.telegram.org/proxy',
      'https://api.telegram.org?target=remote',
      'http://localhost:8081',
      'http://2130706433:8081',
      'http://127.0.0.1:8081/proxy',
    ]) {
      assert.throws(
        () => parseConfig({ telegram: { apiBaseUrl } }),
        /telegram\.apiBaseUrl/,
        apiBaseUrl,
      );
    }
  });

  it('keeps the Ollama endpoint structurally local-only', () => {
    assert.doesNotThrow(() =>
      parseConfig({ llm: { baseUrl: 'http://127.0.0.1:11434', backend: 'ollama' } }),
    );
    for (const baseUrl of [
      'https://127.0.0.1:11434',
      'http://localhost:11434',
      'http://2130706433:11434',
      'http://0177.0.0.1:11434',
      'http://127.1:11434',
      'http://user:password@127.0.0.1:11434',
      'http://127.0.0.1:11434/proxy',
      'http://127.0.0.1:11434?target=remote',
      'http://127.0.0.1:11434#remote',
      'https://example.com',
      'not a URL',
    ]) {
      assert.throws(
        () => parseConfig({ llm: { baseUrl, backend: 'ollama' } }),
        /llm\.baseUrl/,
        baseUrl,
      );
    }
  });

  it('accepts only command-safe Ollama model identifiers', () => {
    assert.equal(
      parseConfig({ llm: { model: 'registry/team-model:27b' } }).llm.model,
      'registry/team-model:27b',
    );
    for (const model of ['qwen3.6:27b\nopen -a Calculator', '-danger', 'model;whoami', '']) {
      assert.throws(() => parseConfig({ llm: { model } }), /llm\.model/, model);
    }
  });

  it('rejects unsafe timeout, interval and retention values', () => {
    const invalidConfigs = [
      { asr: { pythonWorkerTimeoutMs: 0 } },
      { llm: { contextTokens: 0 } },
      { llm: { requestTimeoutMs: -1 } },
      { telegram: { transcriptInlineLimit: 0 } },
      { telegram: { pollIntervalMs: 0 } },
      { telegram: { longPollSeconds: -1 } },
      { telegram: { maxIncomingDurationSeconds: 0 } },
      { telegram: { maxConcurrentIncomingJobs: 0 } },
      { retention: { sessionAudioHours: -1 } },
      { retention: { incomingAudioHours: -1 } },
      { retention: { quarantineHours: -1 } },
      { retention: { rejectedSessionHours: -1 } },
      { health: { pollIntervalMs: 0 } },
      { health: { recorderStaleSeconds: 0 } },
      { health: { asrBacklogMinutes: -1 } },
      { health: { outboxStaleMinutes: -1 } },
      { health: { diskFreeWarnGb: -1 } },
      { health: { alertCooldownMinutes: 0 } },
    ];

    for (const config of invalidConfigs) {
      assert.throws(() => parseConfig(config), ConfigError, JSON.stringify(config));
    }

    assert.doesNotThrow(() =>
      parseConfig({
        telegram: { longPollSeconds: 0 },
        retention: {
          sessionAudioHours: 0,
          incomingAudioHours: 0,
          quarantineHours: 0,
          rejectedSessionHours: 0,
        },
        health: {
          asrBacklogMinutes: 0,
          outboxStaleMinutes: 0,
          diskFreeWarnGb: 0,
        },
      }),
    );
  });

  it('reports every problem at once rather than one at a time', () => {
    try {
      parseConfig({ audio: { sampleRate: 8000, channels: 5 }, logLevel: 'loud' });
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.issues.length >= 3, `expected several issues, got ${error.issues.length}`);
    }
  });

  it('validates the digest time format', () => {
    assert.throws(() => parseConfig({ digest: { atLocalTime: '25:00' } }), /HH:MM/);
    assert.throws(() => parseConfig({ digest: { atLocalTime: '9:5' } }), /HH:MM/);
    assert.throws(() => parseConfig({ digest: { timezone: 'Mars/Olympus_Mons' } }), /IANA/);
    assert.doesNotThrow(() => parseConfig({ digest: { timezone: 'Europe/Moscow' } }));
    assert.doesNotThrow(() => parseConfig({ digest: { atLocalTime: '23:30' } }));
  });

  it('rejects a non-object root', () => {
    for (const value of [null, [], 'x', 42]) {
      assert.throws(() => parseConfig(value), ConfigError);
    }
  });

  it('has no field capable of holding a secret', () => {
    // The bot token and chat ID live in the Keychain. The config file is
    // world-readable-ish by comparison and must not be able to represent them,
    // so a user cannot "helpfully" paste a token into it.
    const secretish = /bot.?token|api.?key|password|secret|credential|chat.?id|authorization/i;

    const walk = (value: unknown, path: string): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        assert.ok(
          !secretish.test(key),
          `config key "${path}${key}" looks like it could hold a secret`,
        );
        walk(inner, `${path}${key}.`);
      }
    };
    walk(DEFAULT_CONFIG, '');
  });
});

describe('runtime requirements', () => {
  it('enforces the exact Node 26.7.0 runtime floor', () => {
    assert.equal(nodeVersionIsSupported('26.6.1'), false);
    assert.equal(nodeVersionIsSupported('26.7.0'), true);
    assert.equal(nodeVersionIsSupported('27.0.0'), true);
  });
});

describe('paths', () => {
  it('keeps all state under one root', () => {
    const paths = resolvePaths('/tmp/openmurmur-root');
    for (const dir of managedDirectories(paths)) {
      assert.ok(dir.startsWith('/tmp/openmurmur-root'), `${dir} escapes the root`);
    }
  });

  it('separates quarantine from finalized audio', () => {
    const paths = resolvePaths('/tmp/r');
    assert.notEqual(paths.quarantineDir, paths.audioDir);
    assert.notEqual(paths.tempDir, paths.audioDir);
  });
});

describe('ffmpeg device listing', () => {
  it('parses the AVFoundation device table', () => {
    const stderr = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x1] [1] External USB Mic`;

    const devices = parseAvfoundationDevices(stderr);
    assert.equal(devices.length, 2, 'video devices must not be listed as audio inputs');
    assert.deepEqual(devices[0], { index: '0', name: 'MacBook Pro Microphone' });
    assert.deepEqual(devices[1], { index: '1', name: 'External USB Mic' });
  });

  it('returns nothing when no devices are reported', () => {
    assert.deepEqual(parseAvfoundationDevices('some unrelated ffmpeg output'), []);
  });
});

describe('worker protocol framing', () => {
  it('encodes one newline-terminated JSON object', () => {
    const line = encodeRequest({ id: 'a', op: 'ping' });
    assert.ok(line.endsWith('\n'));
    assert.equal(line.split('\n').filter(Boolean).length, 1);
  });

  it('decodes a success and an error response', () => {
    const success = decodeResponse('{"id":"a","ok":true,"op":"ping","worker_version":"0.1.0"}');
    assert.equal(success.ok, true);

    const failure = decodeResponse('{"id":"a","ok":false,"code":"internal","error":"boom"}');
    assert.equal(failure.ok, false);
  });

  it('rejects malformed responses rather than guessing', () => {
    for (const line of ['not json', '[]', '{"id":"a"}', '{"ok":true}']) {
      assert.throws(() => decodeResponse(line));
    }
  });

  it('reassembles NDJSON split across arbitrary chunk boundaries', () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push('{"id":"a",'), [], 'a partial line yields nothing yet');
    assert.deepEqual(splitter.push('"ok":true}\n{"id":"b"'), ['{"id":"a","ok":true}']);
    assert.deepEqual(splitter.push(',"ok":false}\n'), ['{"id":"b","ok":false}']);
  });

  it('ignores blank lines', () => {
    assert.deepEqual(new LineSplitter().push('\n\n  \n{"id":"a"}\n'), ['{"id":"a"}']);
  });
});

describe('energy gate', () => {
  function tone(amplitude: number, samples = 512): Uint8Array {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      buffer.writeInt16LE(
        Math.round(Math.sin((i / samples) * Math.PI * 8) * amplitude * 32767),
        i * 2,
      );
    }
    return buffer;
  }

  it('reports -Infinity dBFS for digital silence', () => {
    assert.equal(rmsDbfs(new Uint8Array(1024)), Number.NEGATIVE_INFINITY);
  });

  it('rises with amplitude', () => {
    assert.ok(rmsDbfs(tone(0.01)) < rmsDbfs(tone(0.1)));
    assert.ok(rmsDbfs(tone(0.1)) < rmsDbfs(tone(0.8)));
  });

  it('passes loud audio and blocks silence', () => {
    const vad = new EnergyVad();
    assert.ok(vad.probability(tone(0.5)) > 0.5);
    assert.equal(vad.probability(new Uint8Array(1024)), 0);
  });

  it('handles an empty frame without throwing', () => {
    assert.equal(rmsDbfs(new Uint8Array(0)), Number.NEGATIVE_INFINITY);
  });
});

describe('digest day boundaries', () => {
  it('converts a local date to a UTC range', () => {
    const { fromIso, toIso } = localDayBounds('2026-07-29', 0);
    assert.equal(fromIso, '2026-07-29T00:00:00.000Z');
    assert.equal(toIso, '2026-07-30T00:00:00.000Z');
  });

  it('applies the timezone offset', () => {
    // getTimezoneOffset returns +420 for UTC-7, so local midnight is 07:00 UTC.
    const { fromIso } = localDayBounds('2026-07-29', 420);
    assert.equal(fromIso, '2026-07-29T07:00:00.000Z');
  });

  it('rejects a malformed date', () => {
    assert.throws(() => localDayBounds('29-07-2026', 0), /YYYY-MM-DD/);
  });

  it('uses real IANA timezone boundaries across daylight saving changes', () => {
    const spring = localDayBounds('2026-03-08', 'America/New_York');
    const fall = localDayBounds('2026-11-01', 'America/New_York');
    assert.equal(Date.parse(spring.toIso) - Date.parse(spring.fromIso), 23 * 60 * 60 * 1000);
    assert.equal(Date.parse(fall.toIso) - Date.parse(fall.fromIso), 25 * 60 * 60 * 1000);
  });

  it('starts at the first existing local time when midnight is skipped', () => {
    const santiago = localDayBounds('2026-09-06', 'America/Santiago');
    const cairo = localDayBounds('2026-04-24', 'Africa/Cairo');

    assert.deepEqual(santiago, {
      fromIso: '2026-09-06T04:00:00.000Z',
      toIso: '2026-09-07T03:00:00.000Z',
    });
    assert.deepEqual(cairo, {
      fromIso: '2026-04-23T22:00:00.000Z',
      toIso: '2026-04-24T21:00:00.000Z',
    });
  });

  it('selects the most recent due date in the configured timezone', () => {
    const schedule = {
      enabled: true,
      atLocalTime: '23:30',
      timezone: 'Europe/Moscow',
    };
    assert.equal(scheduledDigestDate(Date.parse('2026-08-09T20:29:00Z'), schedule), '2026-08-08');
    assert.equal(scheduledDigestDate(Date.parse('2026-08-09T20:30:00Z'), schedule), '2026-08-09');
    assert.equal(
      scheduledDigestDate(Date.parse('2026-08-09T21:10:00Z'), schedule),
      '2026-08-09',
      '00:10 in Moscow still retries the previous due date',
    );
    assert.equal(
      scheduledDigestDate(Date.parse('2026-08-09T21:00:00Z'), { ...schedule, enabled: false }),
      null,
    );
  });

  it('defers snapshots until every session for the date is done', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      const now = '2026-08-09T12:00:00.000Z';
      db.handle
        .prepare(
          `INSERT INTO audio_sessions
             (session_id, state, started_at, created_at, updated_at)
           VALUES ('done', 'DONE', ?, ?, ?), ('pending', 'ACTIVE', ?, ?, ?)`,
        )
        .run(now, now, now, now, now, now);

      for (const state of ['ACTIVE', 'FINALIZING', 'PROCESSING', 'DELIVERING']) {
        db.handle
          .prepare("UPDATE audio_sessions SET state = ? WHERE session_id = 'pending'")
          .run(state);
        assert.equal(hasUnfinishedSessionsForDate(db.handle, '2026-08-09', 'UTC'), true);
      }

      db.handle
        .prepare("UPDATE audio_sessions SET state = 'DONE' WHERE session_id = 'pending'")
        .run();
      assert.equal(hasUnfinishedSessionsForDate(db.handle, '2026-08-09', 'UTC'), false);
      assert.equal(buildDigest(db.handle, '2026-08-09', 'UTC').sessionCount, 2);

      db.handle
        .prepare("UPDATE audio_sessions SET state = 'DELIVERING' WHERE session_id = 'pending'")
        .run();
      assert.equal(buildDigest(db.handle, '2026-08-09', 'UTC').sessionCount, 1);
    } finally {
      db.close();
    }
  });

  it('rejects a calendar date that does not exist', () => {
    assert.throws(() => localDayBounds('2026-02-30', 'UTC'), /does not exist/);
  });

  it('renders a complete safe Markdown artifact for a large digest', () => {
    const digest = {
      date: '2026-08-09',
      sessionCount: 1,
      totalSpeechMs: 60_000,
      rows: [
        {
          sessionId: 's1',
          startedAt: '2026-08-09T10:00:00.000Z',
          speechMs: 60_000,
          summary: '<script>alert(1)</script> **heading**',
          decisions: ['ship [now](https://example.com)'],
          tasks: [],
          questions: [],
        },
      ],
    };
    const markdown = renderDigestMarkdown(digest, 'America/New_York');
    const telegram = renderDigest(digest, 'America/New_York');
    assert.match(markdown, /# Дайджест OpenMurmur/);
    assert.match(markdown, /06:00/);
    assert.match(telegram, /06:00/);
    assert.doesNotMatch(markdown, /<script>/);
    assert.doesNotMatch(markdown, /\*\*heading\*\*/);
  });
});

describe('delivery part ids', () => {
  it('extracts the session id from transcript and report ids', () => {
    assert.equal(sessionIdFromDeliveryPart('transcript:sess-1:2'), 'sess-1');
    assert.equal(sessionIdFromDeliveryPart('report:sess-1'), 'sess-1');
  });

  it('returns null for ids that carry a part id, not a session id', () => {
    assert.equal(sessionIdFromDeliveryPart('audio:part-9'), null);
    assert.equal(sessionIdFromDeliveryPart('malformed'), null);
  });
});
