import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { decodeResponse, encodeRequest, LineSplitter } from '../../src/asr/protocol.ts';
import { sessionIdFromDeliveryPart } from '../../src/cli/daemon.ts';
import { nodeVersionIsSupported, parseAvfoundationDevices } from '../../src/cli/doctor.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../../src/config/schema.ts';
import { openDatabase } from '../../src/database/db.ts';
import {
  buildDigest,
  digestSnapshotStillCurrent,
  hasUnfinishedSessionsForDate,
  localDayBounds,
  readStoredDigest,
  renderDigest,
  renderDigestCaption,
  renderDigestMarkdown,
  scheduledDigestDate,
  storeDigest,
} from '../../src/digest/daily.ts';
import {
  cleanupDurableDigestTemps,
  ensureDigestDeliveryArtifact,
  prepareDigestDelivery,
  prepareDigestDocumentForSend,
  publishDigestSnapshot,
  readDigestDeliveryPayload,
} from '../../src/digest/delivery.ts';
import { EMPTY_SUMMARY } from '../../src/llm/schema.ts';
import { EnergyVad, rmsDbfs } from '../../src/sessionizer/vad.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

describe('config parsing', () => {
  it('accepts an empty object and returns defaults', () => {
    assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  });

  it('merges a partial override without losing the rest', () => {
    const config = parseConfig({ sessionizer: { silenceTimeoutSeconds: 30 } });
    assert.equal(config.sessionizer.silenceTimeoutSeconds, 30);
    assert.equal(config.sessionizer.preRollSeconds, DEFAULT_CONFIG.sessionizer.preRollSeconds);
  });

  it('fails closed to send-only until one Telegram input owner is explicit', () => {
    assert.equal(DEFAULT_CONFIG.telegram.receiveUpdates, false);
    assert.equal(parseConfig({ telegram: { receiveUpdates: true } }).telegram.receiveUpdates, true);
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

  it('rejects the removed incoming-summary option with a migration instruction', () => {
    assert.throws(
      () => parseConfig({ telegram: { summarizeIncoming: true } }),
      /summarizeIncoming.*removed.*remove it from the config/,
    );
  });

  it('rejects the removed VAD frame option with the fixed protocol contract', () => {
    assert.throws(
      () => parseConfig({ sessionizer: { vadFrameMs: 16 } }),
      /vadFrameMs.*removed.*fixed 32 ms frames.*remove it from the config/,
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
    assert.throws(
      () => parseConfig({ audio: { captureBackend: 'automatic' } }),
      /captureBackend must be "ffmpeg" or "native"/,
    );
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
    for (const model of ['qwen3.8:27b\nopen -a Calculator', '-danger', 'model;whoami', '']) {
      assert.throws(() => parseConfig({ llm: { model } }), /llm\.model/, model);
    }
  });

  it('rejects unsafe timeout, interval and retention values', () => {
    const invalidConfigs = [
      { asr: { pythonWorkerTimeoutMs: 0 } },
      { asr: { workerIdleTimeoutMs: 0 } },
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
  it('enforces the exact Node 26.8.1 runtime floor', () => {
    assert.equal(nodeVersionIsSupported('26.8.0'), false);
    assert.equal(nodeVersionIsSupported('26.8.1'), true);
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
      const built = buildDigest(db.handle, '2026-08-09', 'UTC', 'digest-mac');
      assert.equal(built.sessionCount, 2);
      assert.equal(built.sourceKind, 'local_daily_digest');
      assert.equal(built.processingHost, 'digest-mac');

      db.handle
        .prepare("UPDATE audio_sessions SET state = 'DELIVERING' WHERE session_id = 'pending'")
        .run();
      assert.equal(buildDigest(db.handle, '2026-08-09', 'UTC', 'digest-mac').sessionCount, 1);
    } finally {
      db.close();
    }
  });

  it('rejects a calendar date that does not exist', () => {
    assert.throws(() => localDayBounds('2026-02-30', 'UTC'), /does not exist/);
  });

  it('keeps one revision-bound digest and reconstructs only its durable artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'om-digest-repeat-'));
    const db = openDatabase({ file: join(root, 'openmurmur.db') });
    const processingHost = `snapshot-before-${hostname()}`;
    try {
      const now = '2026-08-09T10:00:00.000Z';
      db.handle
        .prepare(
          `INSERT INTO audio_sessions
             (session_id, state, started_at, ended_at, duration_ms, speech_ms, created_at, updated_at)
           VALUES ('s1', 'DONE', ?, ?, 60000, 60000, ?, ?)`,
        )
        .run(now, '2026-08-09T10:01:00.000Z', now, now);
      db.handle
        .prepare(
          `INSERT INTO transcript_revisions
             (revision_id, session_id, revision_number, engine, model, languages, text,
              word_count, is_current, created_at)
           VALUES
             ('revision-old', 's1', 1, 'fake', 'fake', '["Russian"]', 'Старый текст',
              2, 0, ?),
             ('revision-current', 's1', 2, 'fake', 'fake', '["Russian"]', 'Текущий текст',
              2, 1, ?)`,
        )
        .run(now, now);
      const misleadingPrefix = `САМОЕ НАЧАЛО НЕ ДОЛЖНО ПОПАСТЬ. ${'Нерелевантное вступление. '.repeat(20)}`;
      db.handle
        .prepare(
          `INSERT INTO transcript_segments
             (revision_id, segment_index, start_ms, end_ms, timestamp_source, text)
           VALUES ('revision-current', 0, 0, 1000, 'aligner', ?),
                  ('revision-current', 1, 1000, 2000, 'aligner', 'Бюджет пока обсуждается.')`,
        )
        .run(
          `${misleadingPrefix}Я постараюсь отправить отчёт до пятницы, но пока не обещаю. После этого разговор ушёл дальше.`,
        );
      db.handle
        .prepare(
          `INSERT INTO summaries
             (summary_id, session_id, revision_id, engine, model, payload, created_at)
           VALUES ('summary-old', 's1', 'revision-old', 'fake', 'fake', ?, ?),
                  ('summary-current', 's1', 'revision-current', 'fake', 'fake', ?, ?)`,
        )
        .run(
          JSON.stringify({ ...EMPTY_SUMMARY, summary: 'СТАРОЕ РЕЗЮМЕ' }),
          '2026-08-09T10:02:00.000Z',
          JSON.stringify({
            ...EMPTY_SUMMARY,
            summary: '<script>alert(1)</script> **heading**',
            decisions: [
              'Отправлю отчёт до пятницы.',
              ...Array.from(
                { length: 19 },
                (_, index) => `ship item ${index}: [now](https://example.com) ${'x'.repeat(220)}`,
              ),
            ],
            tasks: ['Позвонить Анне'],
            questions: ['Утверждён ли бюджет?'],
            claimEvidence: [
              { field: 'summary', item: 0, segments: [1] },
              { field: 'decisions', item: 0, segments: [0] },
              { field: 'questions', item: 0, segments: [1] },
            ],
          }),
          '2026-08-09T10:01:00.000Z',
        );

      const digest = buildDigest(db.handle, '2026-08-09', 'UTC', processingHost);
      assert.equal(digest.claimSourceVersion, 2);
      assert.equal(digest.rows[0]?.summaryId, 'summary-current');
      assert.equal(digest.rows[0]?.summaryRevisionId, 'revision-current');
      assert.doesNotMatch(JSON.stringify(digest), /СТАРОЕ РЕЗЮМЕ/);
      assert.equal(digestSnapshotStillCurrent(db.handle, digest, 'UTC'), true);
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 0 WHERE revision_id = 'revision-current'",
        )
        .run();
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = 'revision-old'",
        )
        .run();
      assert.equal(digestSnapshotStillCurrent(db.handle, digest, 'UTC'), false);
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 0 WHERE revision_id = 'revision-old'",
        )
        .run();
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = 'revision-current'",
        )
        .run();
      const markdown = renderDigestMarkdown(digest, 'America/New_York');
      const telegram = renderDigest(digest, 'America/New_York');
      const caption = renderDigestCaption(digest);
      assert.ok(telegram.length > DEFAULT_CONFIG.telegram.transcriptInlineLimit);
      for (const rendered of [telegram, caption]) {
        assert.match(rendered, /локальный дневной дайджест OpenMurmur/);
        assert.ok(rendered.includes(processingHost));
      }
      assert.match(markdown, /локальный дневной дайджест OpenMurmur/);
      assert.ok(markdown.includes(processingHost.replaceAll('-', '\\-').replaceAll('.', '\\.')));
      const empty = renderDigest(
        { ...digest, sessionCount: 0, totalSpeechMs: 0, rows: [] },
        'America/New_York',
      );
      assert.match(empty, /локальный дневной дайджест OpenMurmur/);
      assert.ok(empty.includes(processingHost));
      assert.match(markdown, /# Дайджест OpenMurmur/);
      assert.match(markdown, /06:00/);
      assert.match(telegram, /06:00/);
      assert.match(telegram, /Черновик модели: решения/);
      assert.match(telegram, /Я постараюсь отправить отчёт до пятницы, но пока не обещаю/);
      assert.doesNotMatch(telegram, /САМОЕ НАЧАЛО/);
      assert.match(telegram, /ссылка модели: не указана/);
      assert.match(telegram, /revision-current/);
      assert.match(markdown, /черновик модели/i);
      assert.match(markdown, /Я постараюсь отправить отчёт до пятницы, но пока не обещаю/);
      assert.doesNotMatch(markdown, /<script>/);
      assert.doesNotMatch(markdown, /\*\*heading\*\*/);
      const transcriptsDir = join(root, 'transcripts');
      mkdirSync(transcriptsDir, { recursive: true });
      const prepared = prepareDigestDelivery(
        digest,
        'America/New_York',
        DEFAULT_CONFIG.telegram.transcriptInlineLimit,
        transcriptsDir,
      );
      assert.equal(prepared.payload.type, 'document');
      assert.equal(publishDigestSnapshot(db.handle, digest, prepared.payload, 'UTC'), 'inserted');

      // A delayed loser must observe the durable winner before source
      // revalidation. It cannot classify the shared winner as stale or delete
      // the winner's content-addressed artifact.
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 0 WHERE revision_id = 'revision-current'",
        )
        .run();
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = 'revision-old'",
        )
        .run();
      const losingDigest = { ...digest, processingHost: 'losing-concurrent-host' };
      const losingPrepared = prepareDigestDelivery(
        losingDigest,
        'UTC',
        DEFAULT_CONFIG.telegram.transcriptInlineLimit,
        transcriptsDir,
      );
      assert.equal(
        publishDigestSnapshot(db.handle, losingDigest, losingPrepared.payload, 'UTC'),
        'exists',
      );
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 0 WHERE revision_id = 'revision-old'",
        )
        .run();
      db.handle
        .prepare(
          "UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = 'revision-current'",
        )
        .run();

      const stored = db.handle
        .prepare('SELECT payload FROM digests WHERE digest_date = ?')
        .get(digest.date) as { payload: string };
      assert.deepEqual(JSON.parse(stored.payload), digest);
      assert.doesNotMatch(stored.payload, /losing-concurrent-host/);

      const outbox = new Outbox(db.handle);
      const durablePayload = readDigestDeliveryPayload(db.handle, digest.date);
      assert.equal(durablePayload.type, 'document');
      assert.equal(durablePayload.digestTimezone, 'America/New_York');
      assert.match(durablePayload.contentSha256 ?? '', /^[0-9a-f]{64}$/u);
      assert.ok((durablePayload.contentBytes ?? 0) > 0);
      const artifactPath = durablePayload.path;
      assert.equal(existsSync(artifactPath), false, 'the transaction does not publish a file');
      await ensureDigestDeliveryArtifact(digest, durablePayload, transcriptsDir);
      const storedBeforeRepeat = stored.payload;
      const outboxBeforeRepeat = db.handle
        .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
        .get(`digest:${digest.date}`) as { payload: string };
      const artifactBeforeRepeat = readFileSync(artifactPath);
      rmSync(artifactPath);
      assert.equal(existsSync(artifactPath), false);

      const interruptedTemp = join(
        transcriptsDir,
        `.${basename(artifactPath)}.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`,
      );
      writeFileSync(interruptedTemp, artifactBeforeRepeat);
      db.handle
        .prepare("UPDATE telegram_outbox SET state = 'sent' WHERE delivery_part_id = ?")
        .run(`digest:${digest.date}`);
      assert.equal(await cleanupDurableDigestTemps(db.handle, transcriptsDir), 1);
      assert.equal(existsSync(artifactPath), false);
      assert.equal(existsSync(interruptedTemp), false, 'startup removes a sent winner temp');

      await prepareDigestDocumentForSend(
        db.handle,
        `digest:${digest.date}`,
        durablePayload,
        transcriptsDir,
      );
      assert.deepEqual(readFileSync(artifactPath), artifactBeforeRepeat);
      db.handle
        .prepare(
          `UPDATE telegram_outbox
              SET state = 'pending', run_after = '1970-01-01T00:00:00.000Z',
                  attempts = 0, claim_generation = 0, telegram_message_id = NULL
            WHERE delivery_part_id = ?`,
        )
        .run(`digest:${digest.date}`);

      rmSync(artifactPath);
      assert.equal(existsSync(artifactPath), false);

      const repeated = spawnSync(
        process.execPath,
        ['src/cli/main.ts', 'digest', digest.date, '--json', '--root', root],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.deepEqual(JSON.parse(repeated.stdout), digest);
      assert.equal(existsSync(artifactPath), true, 'the durable owner reconstructs a crash gap');
      assert.deepEqual(readFileSync(artifactPath), artifactBeforeRepeat);
      assert.equal(
        (
          db.handle
            .prepare('SELECT payload FROM digests WHERE digest_date = ?')
            .get(digest.date) as { payload: string }
        ).payload,
        storedBeforeRepeat,
      );
      assert.equal(
        (
          db.handle
            .prepare('SELECT payload FROM telegram_outbox WHERE delivery_part_id = ?')
            .get(`digest:${digest.date}`) as { payload: string }
        ).payload,
        outboxBeforeRepeat.payload,
      );

      const first = outbox.claimNext();
      assert.ok(first);
      outbox.recoverSending();
      const retried = outbox.claimNext();
      assert.ok(retried);
      assert.equal(retried.payload, first.payload);
      assert.ok(retried.payload.includes(processingHost));

      const digestRow = digest.rows[0];
      assert.ok(digestRow);
      const legacyDigest = {
        sourceKind: 'local_daily_digest' as const,
        processingHost: 'legacy-host',
        date: '2026-08-08',
        sessionCount: 1,
        totalSpeechMs: digestRow.speechMs,
        rows: [
          {
            sessionId: digestRow.sessionId,
            startedAt: digestRow.startedAt,
            speechMs: digestRow.speechMs,
            summary: digestRow.summary,
            decisions: digestRow.decisions,
            tasks: digestRow.tasks,
            questions: digestRow.questions,
          },
        ],
      };
      assert.equal(storeDigest(db.handle, legacyDigest), true);
      const legacyStored = readStoredDigest(db.handle, legacyDigest.date);
      assert.ok(legacyStored);
      assert.equal(legacyStored.claimSourceVersion, undefined);
      assert.match(
        renderDigest(legacyStored, 'UTC'),
        /legacy snapshot: источник model claim не сохранён/,
      );

      const malformed = [
        ['sessionCount', { ...digest, sessionCount: 2 }],
        ['totalSpeechMs', { ...digest, totalSpeechMs: 60_001 }],
        ['rows\\[0\\]\\.sessionId', { ...digest, rows: [{}] }],
        [
          'rows\\[0\\]\\.startedAt',
          { ...digest, rows: [{ ...digest.rows[0], startedAt: '2026-08-09 10:00:00Z' }] },
        ],
        ['rows\\[0\\]\\.speechMs', { ...digest, rows: [{ ...digest.rows[0], speechMs: -1 }] }],
        ['rows\\[0\\]\\.summary', { ...digest, rows: [{ ...digest.rows[0], summary: 7 }] }],
        [
          'rows\\[0\\]\\.decisions',
          { ...digest, rows: [{ ...digest.rows[0], decisions: ['valid', 7] }] },
        ],
        [
          'rows\\[0\\]\\.claimSources',
          { ...digest, rows: [{ ...digest.rows[0], claimSources: [] }] },
        ],
      ] as const;
      for (const [field, payload] of malformed) {
        db.handle
          .prepare('UPDATE digests SET payload = ? WHERE digest_date = ?')
          .run(JSON.stringify(payload), digest.date);
        assert.throws(() => readStoredDigest(db.handle, digest.date), new RegExp(field));
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
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
