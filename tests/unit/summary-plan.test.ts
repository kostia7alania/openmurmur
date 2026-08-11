import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import {
  MAX_SUMMARY_CHUNK_CALLS,
  OLLAMA_CHAT_TEMPLATE_RESERVE_BYTES,
  OllamaLlm,
  summaryInputByteLimit,
  summaryPromptContextByteLength,
} from '../../src/llm/ollama.ts';
import { EMPTY_SUMMARY, type StructuredSummary } from '../../src/llm/schema.ts';
import {
  aggregateChunkSummaries,
  planSummaryChunks,
  type SummaryChunk,
} from '../../src/llm/summary-plan.ts';

function chunk(index: number, segmentIndexes: readonly number[]): SummaryChunk {
  return {
    id: `chunk-${index + 1}-of-2`,
    index,
    count: 2,
    sourceStart: index * 10,
    sourceEnd: index * 10 + 10,
    sourceText: `source-${index}`,
    promptText: `source-${index}`,
    promptUtf8Bytes: 8,
    segmentIndexes,
  };
}

function responseSummary(overrides: Partial<StructuredSummary>): string {
  return JSON.stringify({ ...EMPTY_SUMMARY, ...overrides });
}

describe('long-session summary planning', () => {
  it('covers every source character once with deterministic bounded chunk provenance', () => {
    const segments = [
      'Решили выпустить MVP в пятницу.',
      'Priya will send the guide on Monday.',
      'มาลีจะเตรียมรายการตรวจสอบ',
    ];
    const transcript = segments.join('\n\n');
    const first = planSummaryChunks(transcript, segments, 90);
    const second = planSummaryChunks(transcript, segments, 90);

    assert.deepEqual(first, second);
    assert.equal(first.map((item) => item.sourceText).join(''), transcript);
    assert.ok(first.length > 1);
    for (const item of first) {
      assert.ok(item.promptUtf8Bytes <= 90);
      assert.match(item.id, /^chunk-\d+-of-\d+$/);
      assert.ok(!/[\uD800-\uDBFF]$/.test(item.sourceText));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(item.sourceText));
    }
  });

  it('deduplicates list facts and remaps chunk claims to global segment indexes', () => {
    const summary = aggregateChunkSummaries([
      {
        chunk: chunk(0, [0, 1]),
        summary: {
          ...EMPTY_SUMMARY,
          tasks: ['Ship MVP'],
          claimEvidence: [{ field: 'tasks', item: 0, segments: [0, 99] }],
        },
      },
      {
        chunk: chunk(1, [1, 2]),
        summary: {
          ...EMPTY_SUMMARY,
          tasks: ['Ship MVP', 'Call Acme'],
          claimEvidence: [
            { field: 'tasks', item: 0, segments: [1] },
            { field: 'tasks', item: 1, segments: [2] },
          ],
        },
      },
    ]);

    assert.deepEqual(summary.tasks, ['Ship MVP', 'Call Acme']);
    assert.deepEqual(summary.claimEvidence, [
      { field: 'tasks', item: 0, segments: [0, 1] },
      { field: 'tasks', item: 1, segments: [2] },
    ]);
  });

  it('makes aggregate bounds explicit and removes misleading summary refs after grapheme truncation', () => {
    const family = '👨‍👩‍👧‍👦';
    const summary = aggregateChunkSummaries([
      {
        chunk: chunk(0, [0]),
        summary: {
          ...EMPTY_SUMMARY,
          summary: family.repeat(500),
          tasks: Array.from({ length: 21 }, (_, index) => `task-${index}`),
          claimEvidence: [{ field: 'summary', item: 0, segments: [0] }],
        },
      },
    ]);

    assert.ok(summary.summary.length <= 4_000);
    assert.ok(summary.summary.endsWith(family));
    assert.equal(summary.tasks.length, 20);
    assert.match(summary.uncertainties.at(-1) ?? '', /Aggregation output bound reached/);
    assert.equal(
      summary.claimEvidence.some((claim) => claim.field === 'summary'),
      false,
    );
  });
});

describe('production Ollama chunk orchestration with fake transport', () => {
  it('reports an accepted 4096-token context as explicit incomplete without sending data', async () => {
    let calls = 0;
    const llm = new OllamaLlm({ ...DEFAULT_CONFIG.llm, contextTokens: 4_096 }, async () => {
      calls += 1;
      return Response.json({ message: { content: responseSummary({}) } });
    });

    const summary = await llm.summarize({
      transcript: 'A short transcript that must remain available.',
      segments: ['A short transcript that must remain available.'],
      languages: ['en'],
      durationMs: 1_000,
    });

    assert.equal(calls, 0);
    assert.match(
      summary.uncertainties.at(-1) ?? '',
      /processed 0 chunks.*4096-token context cannot fit.*No transcript was sent.*complete transcript remains available/i,
    );
  });

  it('bounds every prompt, covers late facts and preserves global chunk claim provenance', async () => {
    const segments = Array.from(
      { length: 8 },
      (_, index) => `FACT_${index} decision ${'context '.repeat(140)}`,
    );
    const transcript = segments.join('\n\n');
    const prompts: string[] = [];
    const config = { ...DEFAULT_CONFIG.llm, contextTokens: 8_192 };
    const llm = new OllamaLlm(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
      const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
      prompts.push(user);
      const messageBytes = Buffer.byteLength(system) + Buffer.byteLength(user);
      assert.ok(
        summaryPromptContextByteLength(user) <= summaryInputByteLimit(config.contextTokens),
      );
      assert.ok(
        summaryPromptContextByteLength(user) >= messageBytes + OLLAMA_CHAT_TEMPLATE_RESERVE_BYTES,
      );
      const indexes = [
        ...new Set([...user.matchAll(/\[segment (\d+)\]/g)].map((match) => Number(match[1]))),
      ];
      return Response.json({
        message: {
          content: responseSummary({
            summary: `covered ${indexes.join(',')}`,
            decisions: indexes.map((index) => `decision-${index}`),
            claimEvidence: indexes.map((index, item) => ({
              field: 'decisions' as const,
              item,
              segments: [index],
            })),
          }),
        },
      });
    });

    const summary = await llm.summarize({
      transcript,
      segments,
      languages: ['ru', 'en'],
      durationMs: 60 * 60_000,
    });

    assert.ok(prompts.length > 1);
    assert.deepEqual(
      summary.decisions,
      segments.map((_, index) => `decision-${index}`),
    );
    assert.deepEqual(
      summary.claimEvidence.filter((claim) => claim.field === 'decisions'),
      segments.map((_, item) => ({ field: 'decisions', item, segments: [item] })),
    );
    for (let index = 0; index < segments.length; index += 1) {
      assert.equal(
        prompts.filter((prompt) => prompt.includes(`FACT_${index}`)).length,
        1,
        `FACT_${index} was omitted or duplicated`,
      );
    }
  });

  it('signals model output clamping instead of silently dropping chunk facts', async () => {
    const llm = new OllamaLlm({ ...DEFAULT_CONFIG.llm, contextTokens: 8_192 }, async () =>
      Response.json({
        message: {
          content: responseSummary({
            tasks: Array.from({ length: 25 }, (_, index) => `task-${index}`),
          }),
        },
      }),
    );

    const summary = await llm.summarize({
      transcript: 'A grounded short transcript.',
      segments: ['A grounded short transcript.'],
      languages: ['en'],
      durationMs: 1_000,
    });
    assert.equal(summary.tasks.length, 20);
    assert.match(summary.uncertainties.at(-1) ?? '', /Model output exceeded/);
  });

  it('caps total model work and marks a partial long-session summary incomplete', async () => {
    let calls = 0;
    const llm = new OllamaLlm({ ...DEFAULT_CONFIG.llm, contextTokens: 8_192 }, async () => {
      calls += 1;
      return Response.json({ message: { content: responseSummary({}) } });
    });
    const transcript = 'bounded local context '.repeat(8_000);

    const summary = await llm.summarize({
      transcript,
      segments: [transcript],
      languages: ['en'],
      durationMs: 8 * 60 * 60_000,
    });

    assert.equal(calls, MAX_SUMMARY_CHUNK_CALLS);
    assert.match(
      summary.uncertainties.at(-1) ?? '',
      /summary incomplete: processed 64 of \d+ chunks.*complete transcript remains available/i,
    );
  });

  it('uses one overall deadline across chunks and returns an explicit partial result', async () => {
    let nowMs = 1_000;
    let calls = 0;
    const llm = new OllamaLlm(
      { ...DEFAULT_CONFIG.llm, contextTokens: 8_192, requestTimeoutMs: 100 },
      async () => {
        const item = calls;
        calls += 1;
        nowMs += 60;
        return Response.json({
          message: {
            content: responseSummary({ decisions: [`decision-${item}`] }),
          },
        });
      },
      () => nowMs,
    );
    const transcript = 'deadline bounded context '.repeat(1_000);

    const summary = await llm.summarize({
      transcript,
      segments: [transcript],
      languages: ['en'],
      durationMs: 60 * 60_000,
    });

    assert.equal(calls, 2);
    assert.deepEqual(summary.decisions, ['decision-0']);
    assert.match(
      summary.uncertainties.at(-1) ?? '',
      /processed 1 of \d+ chunks; reached the overall 100 ms deadline.*complete transcript remains available/i,
    );
  });

  it('rejects schema-invalid chunks explicitly and still aggregates later valid chunks', async () => {
    const invalidOutputs = [
      ['empty object', '{}'],
      ['array', '[]'],
      ['scalar', '42'],
      ['missing required fields', JSON.stringify({ summary: 'only one field' })],
    ] as const;
    const transcript = 'schema validation context '.repeat(400);

    for (const [label, invalidOutput] of invalidOutputs) {
      let calls = 0;
      const llm = new OllamaLlm({ ...DEFAULT_CONFIG.llm, contextTokens: 8_192 }, async () => {
        calls += 1;
        return Response.json({
          message: {
            content:
              calls === 1
                ? invalidOutput
                : responseSummary({ decisions: ['Later valid grounded decision.'] }),
          },
        });
      });

      const summary = await llm.summarize({
        transcript,
        segments: [transcript],
        languages: ['en'],
        durationMs: 60_000,
      });

      assert.ok(calls > 1, `${label}: expected a later chunk after the invalid response`);
      assert.deepEqual(summary.decisions, ['Later valid grounded decision.'], label);
      assert.match(
        summary.uncertainties.at(-1) ?? '',
        /summary incomplete: processed \d+ of \d+ chunks; rejected 1 schema-invalid chunk response/i,
        label,
      );
    }
  });
});
