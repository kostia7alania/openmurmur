import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundClaimEvidence, EMPTY_SUMMARY, parseSummary } from '../../src/llm/schema.ts';
import { renderSessionReport, renderSessionReportMarkdown } from '../../src/telegram/report.ts';

describe('summary claim provenance', () => {
  it('keeps only references to claims that survived schema normalization', () => {
    const summary = parseSummary({
      ...EMPTY_SUMMARY,
      summary: 'Краткий итог',
      tasks: ['Позвонить завтра', '', 'Отправить смету'],
      claimEvidence: [
        { field: 'summary', item: 0, segments: [3, 3, 1] },
        { field: 'tasks', item: 0, segments: [2] },
        { field: 'tasks', item: 1, segments: [99] },
        { field: 'tasks', item: 2, segments: [5] },
        { field: 'tasks', item: 9, segments: [7] },
        { field: 'not-a-field', item: 0, segments: [0] },
        { field: 'tasks', item: 0, segments: [4] },
      ],
    });

    assert.deepEqual(summary.tasks, ['Позвонить завтра', 'Отправить смету']);
    assert.deepEqual(summary.claimEvidence, [
      { field: 'summary', item: 0, segments: [3, 1] },
      { field: 'tasks', item: 0, segments: [2, 4] },
      { field: 'tasks', item: 1, segments: [5] },
    ]);
  });

  it('drops model-supplied segment indexes outside the bound transcript revision', () => {
    const bounded = boundClaimEvidence(
      parseSummary({
        ...EMPTY_SUMMARY,
        tasks: ['Позвонить'],
        claimEvidence: [{ field: 'tasks', item: 0, segments: [0, 2, 99] }],
        evidence: [{ segment: 1 }, { segment: 20 }],
      }),
      3,
    );

    assert.deepEqual(bounded.claimEvidence, [{ field: 'tasks', item: 0, segments: [0, 2] }]);
    assert.deepEqual(bounded.evidence, [{ segment: 1 }]);
  });

  it('renders one-based source segments and states when a claim has no reference', () => {
    const summary = {
      ...EMPTY_SUMMARY,
      summary: 'Решили выпускать MVP.',
      tasks: ['Подготовить релиз', 'Позвонить заказчику'],
      claimEvidence: [
        { field: 'summary' as const, item: 0, segments: [0, 2] },
        { field: 'tasks' as const, item: 0, segments: [2] },
      ],
    };
    const input = {
      sessionId: 'session-1',
      startedWallMs: Date.parse('2026-08-11T09:00:00.000Z'),
      endedWallMs: Date.parse('2026-08-11T09:01:00.000Z'),
      durationMs: 60_000,
      speechMs: 30_000,
      languages: ['ru'],
      partCount: 1,
      summary,
    };

    const html = renderSessionReport(input);
    assert.match(html, /ссылка модели: сегм\. 1, 3/);
    assert.match(html, /Подготовить релиз[\s\S]*ссылка модели: сегм\. 3/);
    assert.match(html, /Позвонить заказчику[\s\S]*ссылка модели: не указана/);

    const markdown = renderSessionReportMarkdown(input);
    assert.match(markdown, /ссылка модели: сегм\\\. 1, 3/);
    assert.match(markdown, /ссылка модели: не указана/);
  });
});
