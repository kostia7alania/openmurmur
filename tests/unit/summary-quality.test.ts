import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSummary, type StructuredSummary } from '../../src/llm/schema.ts';
import {
  measureSummaryCorpus,
  type SummaryAcceptanceCase,
  type SummaryAcceptanceCorpus,
  validateSummaryAcceptanceCorpus,
} from '../../src/llm/summary-quality.ts';

interface FixtureCase extends SummaryAcceptanceCase {
  readonly candidateSummary: StructuredSummary;
}

interface FixtureCorpus extends SummaryAcceptanceCorpus {
  readonly cases: readonly FixtureCase[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'summary-acceptance.json',
);

function loadCorpus(): FixtureCorpus {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureCorpus;
}

describe('multilingual summary acceptance corpus', () => {
  it('contains grounded RU, EN and TH facts with measurable MVP thresholds', () => {
    const corpus = loadCorpus();
    assert.doesNotThrow(() => validateSummaryAcceptanceCorpus(corpus));
    assert.deepEqual(
      new Set(corpus.cases.flatMap((testCase) => testCase.languages)),
      new Set(['ru', 'en', 'th']),
    );
    assert.equal(corpus.cases.length, 3);
    assert.equal(
      corpus.cases.reduce((total, item) => total + item.expectedFacts.length, 0),
      18,
    );
    assert.deepEqual(corpus.thresholds, {
      minimumGroundedFactRecall: 0.8,
      minimumClaimPrecision: 1,
      maximumForbiddenFactHits: 0,
      minimumCasePassRate: 1,
    });
  });

  it('measures deterministic candidates at 100% recall and claim precision', () => {
    const corpus = loadCorpus();
    const candidates = new Map(
      corpus.cases.map((testCase) => [testCase.id, parseSummary(testCase.candidateSummary)]),
    );

    const measurement = measureSummaryCorpus(corpus, candidates);
    assert.equal(measurement.groundedFactsExpected, 18);
    assert.equal(measurement.groundedFactsFound, 18);
    assert.equal(measurement.groundedFactRecall, 1);
    assert.equal(measurement.outputClaims, 18);
    assert.equal(measurement.matchedOutputClaims, 18);
    assert.equal(measurement.unlistedClaims, 0);
    assert.equal(measurement.claimPrecision, 1);
    assert.equal(measurement.forbiddenFactHits, 0);
    assert.equal(measurement.casePassRate, 1);
    assert.equal(measurement.pass, true);
  });

  it('fails the threshold when a fake candidate drops a grounded fact or invents a forbidden one', () => {
    const corpus = loadCorpus();
    const candidates = new Map(
      corpus.cases.map((testCase) => [testCase.id, parseSummary(testCase.candidateSummary)]),
    );
    const english = candidates.get('en-customer-followup');
    assert.ok(english);
    candidates.set('en-customer-followup', {
      ...english,
      decisions: ['Cancel the pilot.'],
      tasks: [],
    });

    const measurement = measureSummaryCorpus(corpus, candidates);
    assert.equal(measurement.forbiddenFactHits, 1);
    assert.equal(measurement.cases.find((item) => item.id === 'en-customer-followup')?.pass, false);
    assert.equal(measurement.pass, false);
  });

  it('rejects transcript copying and invented claims absent from the allowed gold semantics', () => {
    const corpus = loadCorpus();
    const candidates = new Map(
      corpus.cases.map((testCase) => [testCase.id, parseSummary(testCase.candidateSummary)]),
    );
    const englishCase = corpus.cases.find((testCase) => testCase.id === 'en-customer-followup');
    const english = candidates.get('en-customer-followup');
    assert.ok(englishCase);
    assert.ok(english);
    candidates.set('en-customer-followup', {
      ...english,
      summary: englishCase.transcript,
      ideas: ['Launch in Tokyo.'],
    });

    const measurement = measureSummaryCorpus(corpus, candidates);
    const measuredEnglish = measurement.cases.find((item) => item.id === 'en-customer-followup');
    assert.ok(measuredEnglish);
    assert.ok(measuredEnglish.groundedFactRecall >= corpus.thresholds.minimumGroundedFactRecall);
    assert.equal(measuredEnglish.forbiddenFactHits, 0);
    assert.equal(measuredEnglish.unlistedClaims, 2);
    assert.ok(measuredEnglish.claimPrecision < corpus.thresholds.minimumClaimPrecision);
    assert.equal(measuredEnglish.pass, false);
    assert.equal(measurement.pass, false);
  });
});
