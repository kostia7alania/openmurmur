import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type AlertId, renderAlert } from '../../src/health/alerts.ts';
import {
  evaluateHealth,
  type HealthComponent,
  type HealthInputs,
  type HealthStatus,
  renderHealthLines,
} from '../../src/health/monitor.ts';

const HEALTHY_INPUTS: HealthInputs = {
  recorderRunning: true,
  msSinceLastFrame: 100,
  processingLagMs: 0,
  minutesSinceLastClosedPart: 2,
  workerReady: true,
  workerDetail: 'ready',
  ollamaReady: true,
  ollamaDetail: 'ready',
  activeSessionMs: null,
  asrBacklogMinutes: 0,
  deadJobs: 0,
  outboxAgeMinutes: 0,
  deadOutbox: 0,
  diskFreeGb: 200,
  sqliteWritable: true,
  hoursSinceLastDigest: 1,
};

interface HealthGolden {
  readonly inputs: Partial<HealthInputs>;
  readonly status: Exclude<HealthStatus, 'healthy'>;
  readonly text: string;
}

const COMPONENT_GOLDENS: Readonly<Record<HealthComponent, readonly HealthGolden[]>> = {
  recorder: [
    {
      inputs: { recorderRunning: false },
      status: 'failed',
      text: 'ОШИБКА: запись — процесс записи не работает',
    },
    {
      inputs: { msSinceLastFrame: null },
      status: 'recovering',
      text: 'ВНИМАНИЕ: запись — ожидаю первый аудиокадр',
    },
    {
      inputs: { msSinceLastFrame: 16_000 },
      status: 'failed',
      text: 'ОШИБКА: запись — нет аудиокадров 16 сек',
    },
  ],
  capture_pipeline: [
    {
      inputs: { processingLagMs: 16_000 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: обработка аудио — обработка отстаёт на 16 сек',
    },
  ],
  asr_worker: [
    {
      inputs: {
        workerReady: false,
        workerRecovering: true,
        workerDetail: 'ASR model is loading',
      },
      status: 'recovering',
      text: 'ВНИМАНИЕ: распознавание — локальная модель запускается',
    },
    {
      inputs: { workerReady: false, workerDetail: 'spawn failed: /private/model.bin' },
      status: 'failed',
      text: 'ОШИБКА: распознавание — локальный ASR недоступен',
    },
  ],
  dead_jobs: [
    {
      inputs: { deadJobs: 1 },
      status: 'failed',
      text: 'ОШИБКА: очередь задач — 1 задача исчерпала попытки',
    },
  ],
  llm: [
    {
      inputs: { ollamaReady: false, ollamaDetail: 'ECONNREFUSED 127.0.0.1:11434' },
      status: 'degraded',
      text: 'ВНИМАНИЕ: отчёты — локальные отчёты недоступны; транскрипты продолжат работать',
    },
  ],
  dead_outbox: [
    {
      inputs: { deadOutbox: 1 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: доставка Telegram — 1 сообщение не доставлено',
    },
  ],
  asr_backlog: [
    {
      inputs: { asrBacklogMinutes: 61 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: очередь распознавания — старейшей задаче 61 мин',
    },
  ],
  telegram_outbox: [
    {
      inputs: { outboxAgeMinutes: 31 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: очередь Telegram — старейшему сообщению 31 мин',
    },
  ],
  disk: [
    {
      inputs: { diskFreeGb: 19 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: диск — свободно 19 ГБ',
    },
  ],
  sqlite: [
    {
      inputs: { sqliteWritable: false },
      status: 'failed',
      text: 'ОШИБКА: база данных — база данных недоступна для записи',
    },
  ],
  digest: [
    {
      inputs: { hoursSinceLastDigest: 27 },
      status: 'degraded',
      text: 'ВНИМАНИЕ: дайджест — последний дайджест 27 ч назад',
    },
  ],
};

const ALERT_GOLDENS: Readonly<
  Record<AlertId, { readonly raised: string; readonly cleared: string }>
> = {
  recorder_stale: {
    raised: '🟡 Запись временно недоступна',
    cleared: '🟢 Запись восстановлена',
  },
  worker_crashed: {
    raised: '🟡 Локальное распознавание остановилось',
    cleared: '🟢 Локальное распознавание восстановлено',
  },
  llm_unavailable: {
    raised: '🟡 Структурный отчёт временно недоступен',
    cleared: '🟢 Структурные отчёты снова доступны',
  },
  disk_low: {
    raised: '🟡 Мало места на диске',
    cleared: '🟢 Место на диске восстановлено',
  },
  asr_backlog: {
    raised: '🟡 Очередь распознавания растёт',
    cleared: '🟢 Очередь распознавания разобрана',
  },
  dead_jobs: {
    raised: '🔴 Задача OpenMurmur остановилась после повторных ошибок',
    cleared: '🟢 Ошибочных задач больше нет',
  },
  telegram_delivery: {
    raised: '🟡 Доставка в Telegram не работает',
    cleared: '🟢 Доставка в Telegram восстановлена',
  },
  keychain_unavailable: {
    raised: '🟡 Учётные данные Telegram недоступны в Keychain',
    cleared:
      '🟢 Учётные данные Telegram снова доступны из Keychain — возобновляю попытки доставки.',
  },
  digest_missing: {
    raised: '🟡 Дневной дайджест не сформирован',
    cleared: '🟢 Дайджест сформирован',
  },
};

describe('offline Russian health boundary', () => {
  it('reports the healthy and optional-component baseline exactly', () => {
    const report = evaluateHealth(HEALTHY_INPUTS, DEFAULT_CONFIG.health);
    assert.equal(report.overall, 'healthy');
    assert.equal(renderHealthLines(report), '✅ Всё в порядке');
    assert.deepEqual(
      Object.fromEntries(report.checks.map((check) => [check.component, check.status])),
      {
        recorder: 'healthy',
        capture_pipeline: 'healthy',
        asr_worker: 'healthy',
        dead_jobs: 'healthy',
        llm: 'healthy',
        dead_outbox: 'healthy',
        asr_backlog: 'healthy',
        telegram_outbox: 'healthy',
        disk: 'healthy',
        sqlite: 'healthy',
        digest: 'healthy',
      },
    );
  });

  for (const component of Object.keys(COMPONENT_GOLDENS) as HealthComponent[]) {
    for (const [index, golden] of COMPONENT_GOLDENS[component].entries()) {
      it(`renders ${component} problem ${index + 1} with stable Russian copy`, () => {
        const report = evaluateHealth(
          { ...HEALTHY_INPUTS, ...golden.inputs },
          DEFAULT_CONFIG.health,
        );
        assert.equal(
          report.checks.find((check) => check.component === component)?.status,
          golden.status,
        );
        assert.equal(renderHealthLines(report), golden.text);
      });
    }
  }

  it('uses correct Russian singular and plural forms for terminal work', () => {
    const cases = [
      { deadJobs: 2, deadOutbox: 0, jobs: '2 задачи исчерпали попытки', outbox: null },
      { deadJobs: 5, deadOutbox: 0, jobs: '5 задач исчерпали попытки', outbox: null },
      { deadJobs: 21, deadOutbox: 0, jobs: '21 задача исчерпала попытки', outbox: null },
      { deadJobs: 0, deadOutbox: 2, jobs: null, outbox: '2 сообщения не доставлены' },
      { deadJobs: 0, deadOutbox: 5, jobs: null, outbox: '5 сообщений не доставлены' },
      { deadJobs: 0, deadOutbox: 21, jobs: null, outbox: '21 сообщение не доставлено' },
    ] as const;

    for (const sample of cases) {
      const rendered = renderHealthLines(
        evaluateHealth({ ...HEALTHY_INPUTS, ...sample }, DEFAULT_CONFIG.health),
      );
      if (sample.jobs !== null) assert.match(rendered, new RegExp(sample.jobs));
      if (sample.outbox !== null) assert.match(rendered, new RegExp(sample.outbox));
    }
  });

  it('never exposes raw adapter details at the chat boundary', () => {
    const rendered = renderHealthLines(
      evaluateHealth(
        {
          ...HEALTHY_INPUTS,
          workerReady: false,
          workerDetail: 'spawn failed: /Users/alice/private/model.bin',
          ollamaReady: false,
          ollamaDetail: 'ECONNREFUSED 127.0.0.1:11434',
        },
        DEFAULT_CONFIG.health,
      ),
    );
    assert.doesNotMatch(rendered, /alice|private|ECONNREFUSED|127\.0\.0\.1/);
  });
});

describe('offline Russian recovery edges', () => {
  for (const alertId of Object.keys(ALERT_GOLDENS) as AlertId[]) {
    const golden = ALERT_GOLDENS[alertId];

    it(`renders every ${alertId} active transition with one stable headline`, () => {
      for (const transition of ['raised', 'changed', 'repeated'] as const) {
        const rendered = renderAlert(alertId, transition, '', 12345);
        assert.equal(rendered.text, golden.raised);
        assert.equal(rendered.deliveryPartId, `alert:${alertId}:raise:12345`);
      }
    });

    it(`renders ${alertId} recovery without stale failure detail`, () => {
      const rendered = renderAlert(
        alertId,
        'cleared',
        'СТАРАЯ ОШИБКА: /Users/alice/private/model.bin',
        12345,
      );
      assert.equal(rendered.text, golden.cleared);
      assert.equal(rendered.deliveryPartId, `alert:${alertId}:clear:12345`);
    });
  }

  it('trims active detail without changing its source language', () => {
    assert.equal(
      renderAlert('recorder_stale', 'raised', '  нет аудио 20 сек  ', 1).text,
      '🟡 Запись временно недоступна\n\nнет аудио 20 сек',
    );
  });
});
