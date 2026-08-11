import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMPTY_SUMMARY, parseSummary, type StructuredSummary } from '../../src/llm/schema.ts';
import {
  measureSummaryCase,
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

  it('matches grounded paraphrases one-to-one at 100% recall and claim precision', () => {
    const corpus = loadCorpus();
    const candidates = new Map(
      corpus.cases.map((testCase) => [testCase.id, parseSummary(testCase.candidateSummary)]),
    );
    const english = candidates.get('en-customer-followup');
    assert.ok(english);
    candidates.set('en-customer-followup', {
      ...english,
      decisions: ['On Tuesday, the beta goes to Acme.'],
      tasks: ['By Monday, Priya will email the installation guide.'],
    });

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

    const thresholds = corpus.thresholds;
    const ambiguousCase = {
      id: 'ambiguous-duplicates',
      languages: ['en'],
      transcript: 'Ship beta Tuesday and review beta Wednesday.',
      expectedFacts: [
        { field: 'decisions' as const, claim: 'Ship beta Tuesday.', terms: ['beta'] },
        { field: 'decisions' as const, claim: 'Review beta Wednesday.', terms: ['beta'] },
      ],
      forbiddenFacts: [],
    };
    assert.throws(
      () => validateSummaryAcceptanceCorpus({ thresholds, cases: [ambiguousCase] }),
      /ambiguous decisions term signatures/,
    );

    const distinctCase = {
      ...ambiguousCase,
      expectedFacts: [
        { field: 'decisions' as const, claim: 'Ship beta Tuesday.', terms: ['beta'] },
        {
          field: 'decisions' as const,
          claim: 'Review beta Wednesday.',
          terms: ['beta', 'Wednesday'],
        },
      ],
    };
    const duplicateOutput = parseSummary({
      ...EMPTY_SUMMARY,
      decisions: ['Beta Wednesday.', 'Beta Wednesday.'],
    });
    const duplicateMeasurement = measureSummaryCase(distinctCase, duplicateOutput, thresholds);
    assert.equal(duplicateMeasurement.groundedFactsFound, 1);
    assert.equal(duplicateMeasurement.outputClaims, 2);
    assert.equal(duplicateMeasurement.claimPrecision, 0.5);
    assert.equal(duplicateMeasurement.pass, false);
  });

  it('rejects invented claims even when a transcript copy preserves fact recall', () => {
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
    assert.equal(measuredEnglish.unlistedClaims, 1);
    assert.ok(measuredEnglish.claimPrecision < corpus.thresholds.minimumClaimPrecision);
    assert.equal(measuredEnglish.pass, false);
    assert.equal(measurement.pass, false);
  });
});
