import {
  EMPTY_SUMMARY,
  type StructuredSummary,
  SUMMARY_CLAIM_FIELDS,
  type SummaryClaimField,
} from './schema.ts';

export interface ExpectedSummaryFact {
  readonly field: SummaryClaimField;
  /** Exact normalized output claim accepted by the deterministic corpus. */
  readonly claim: string;
  /** Every term must occur in both the accepted claim and its transcript. */
  readonly terms: readonly string[];
}

export interface SummaryAcceptanceCase {
  readonly id: string;
  readonly languages: readonly string[];
  readonly transcript: string;
  readonly expectedFacts: readonly ExpectedSummaryFact[];
  readonly forbiddenFacts: readonly string[];
}

export interface SummaryAcceptanceThresholds {
  readonly minimumGroundedFactRecall: number;
  readonly minimumClaimPrecision: number;
  readonly maximumForbiddenFactHits: number;
  readonly minimumCasePassRate: number;
}

export interface SummaryAcceptanceCorpus {
  readonly thresholds: SummaryAcceptanceThresholds;
  readonly cases: readonly SummaryAcceptanceCase[];
}

export interface SummaryCaseMeasurement {
  readonly id: string;
  readonly groundedFactsFound: number;
  readonly groundedFactsExpected: number;
  readonly groundedFactRecall: number;
  readonly outputClaims: number;
  readonly matchedOutputClaims: number;
  readonly unlistedClaims: number;
  readonly claimPrecision: number;
  readonly forbiddenFactHits: number;
  readonly pass: boolean;
}

export interface SummaryCorpusMeasurement {
  readonly cases: readonly SummaryCaseMeasurement[];
  readonly groundedFactsFound: number;
  readonly groundedFactsExpected: number;
  readonly groundedFactRecall: number;
  readonly outputClaims: number;
  readonly matchedOutputClaims: number;
  readonly unlistedClaims: number;
  readonly claimPrecision: number;
  readonly forbiddenFactHits: number;
  readonly casePassRate: number;
  readonly pass: boolean;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function fieldText(summary: StructuredSummary, field: SummaryClaimField): string {
  return field === 'summary' ? summary.summary : summary[field].join('\n');
}

function fieldClaims(summary: StructuredSummary, field: SummaryClaimField): readonly string[] {
  const claims = field === 'summary' ? [summary.summary] : summary[field];
  return claims.filter((claim) => normalized(claim).length > 0);
}

function allClaimText(summary: StructuredSummary): string {
  return SUMMARY_CLAIM_FIELDS.map((field) => fieldText(summary, field)).join('\n');
}

function validRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateThresholds(thresholds: SummaryAcceptanceThresholds): void {
  if (!validRate(thresholds.minimumGroundedFactRecall)) {
    throw new Error('minimumGroundedFactRecall must be between 0 and 1');
  }
  if (!validRate(thresholds.minimumClaimPrecision)) {
    throw new Error('minimumClaimPrecision must be between 0 and 1');
  }
  if (!validRate(thresholds.minimumCasePassRate)) {
    throw new Error('minimumCasePassRate must be between 0 and 1');
  }
  if (
    !Number.isSafeInteger(thresholds.maximumForbiddenFactHits) ||
    thresholds.maximumForbiddenFactHits < 0
  ) {
    throw new Error('maximumForbiddenFactHits must be a non-negative integer');
  }
}

function validateAcceptanceCase(testCase: SummaryAcceptanceCase, ids: Set<string>): void {
  if (testCase.id.trim().length === 0 || ids.has(testCase.id)) {
    throw new Error(`summary acceptance case id is empty or duplicated: ${testCase.id}`);
  }
  ids.add(testCase.id);
  if (testCase.languages.length === 0) {
    throw new Error(`summary acceptance case ${testCase.id} has no language`);
  }
  if (testCase.expectedFacts.length === 0) {
    throw new Error(`summary acceptance case ${testCase.id} has no expected facts`);
  }
  const transcript = normalized(testCase.transcript);
  const factKeys = new Set<string>();
  for (const fact of testCase.expectedFacts) {
    const claim = normalized(fact.claim);
    const key = `${fact.field}:${claim}`;
    if (claim.length === 0 || factKeys.has(key)) {
      throw new Error(`summary acceptance case ${testCase.id} has an empty or duplicate claim`);
    }
    factKeys.add(key);
    if (fact.terms.length === 0) {
      throw new Error(`summary acceptance case ${testCase.id} has an empty fact`);
    }
    for (const term of fact.terms) {
      const normalizedTerm = normalized(term);
      if (
        normalizedTerm.length === 0 ||
        !transcript.includes(normalizedTerm) ||
        !claim.includes(normalizedTerm)
      ) {
        throw new Error(
          `summary acceptance fact ${testCase.id}/${fact.field} is not grounded: ${term}`,
        );
      }
    }
  }
  if (testCase.forbiddenFacts.some((fact) => normalized(fact).length === 0)) {
    throw new Error(`summary acceptance case ${testCase.id} has an empty forbidden fact`);
  }
}

/** Validates that the acceptance fixture itself only asks for grounded facts. */
export function validateSummaryAcceptanceCorpus(corpus: SummaryAcceptanceCorpus): void {
  if (corpus.cases.length === 0) throw new Error('summary acceptance corpus is empty');
  validateThresholds(corpus.thresholds);
  const ids = new Set<string>();
  for (const testCase of corpus.cases) validateAcceptanceCase(testCase, ids);
}

export function measureSummaryCase(
  testCase: SummaryAcceptanceCase,
  summary: StructuredSummary,
  thresholds: SummaryAcceptanceThresholds,
): SummaryCaseMeasurement {
  const allowedClaims = new Set(
    testCase.expectedFacts.map((fact) => `${fact.field}:${normalized(fact.claim)}`),
  );
  const outputClaimKeys = SUMMARY_CLAIM_FIELDS.flatMap((field) =>
    fieldClaims(summary, field).map((claim) => `${field}:${normalized(claim)}`),
  );
  const outputClaimSet = new Set(outputClaimKeys);
  const groundedFactsFound = [...allowedClaims].filter((claim) => outputClaimSet.has(claim)).length;
  const groundedFactsExpected = testCase.expectedFacts.length;
  const groundedFactRecall = groundedFactsFound / groundedFactsExpected;
  const matchedOutputClaims = outputClaimKeys.filter((claim) => allowedClaims.has(claim)).length;
  const outputClaims = outputClaimKeys.length;
  const unlistedClaims = outputClaims - matchedOutputClaims;
  const claimPrecision = outputClaims === 0 ? 1 : matchedOutputClaims / outputClaims;
  const output = normalized(allClaimText(summary));
  const forbiddenFactHits = testCase.forbiddenFacts.filter((fact) =>
    output.includes(normalized(fact)),
  ).length;
  return {
    id: testCase.id,
    groundedFactsFound,
    groundedFactsExpected,
    groundedFactRecall,
    outputClaims,
    matchedOutputClaims,
    unlistedClaims,
    claimPrecision,
    forbiddenFactHits,
    pass:
      groundedFactRecall >= thresholds.minimumGroundedFactRecall &&
      claimPrecision >= thresholds.minimumClaimPrecision &&
      forbiddenFactHits <= thresholds.maximumForbiddenFactHits,
  };
}

export function measureSummaryCorpus(
  corpus: SummaryAcceptanceCorpus,
  summaries: ReadonlyMap<string, StructuredSummary>,
): SummaryCorpusMeasurement {
  validateSummaryAcceptanceCorpus(corpus);
  const cases = corpus.cases.map((testCase) =>
    measureSummaryCase(testCase, summaries.get(testCase.id) ?? EMPTY_SUMMARY, corpus.thresholds),
  );
  const groundedFactsFound = cases.reduce((total, item) => total + item.groundedFactsFound, 0);
  const groundedFactsExpected = cases.reduce(
    (total, item) => total + item.groundedFactsExpected,
    0,
  );
  const forbiddenFactHits = cases.reduce((total, item) => total + item.forbiddenFactHits, 0);
  const outputClaims = cases.reduce((total, item) => total + item.outputClaims, 0);
  const matchedOutputClaims = cases.reduce((total, item) => total + item.matchedOutputClaims, 0);
  const unlistedClaims = outputClaims - matchedOutputClaims;
  const claimPrecision = outputClaims === 0 ? 1 : matchedOutputClaims / outputClaims;
  const casePassRate = cases.filter((item) => item.pass).length / cases.length;
  return {
    cases,
    groundedFactsFound,
    groundedFactsExpected,
    groundedFactRecall: groundedFactsFound / groundedFactsExpected,
    outputClaims,
    matchedOutputClaims,
    unlistedClaims,
    claimPrecision,
    forbiddenFactHits,
    casePassRate,
    pass:
      groundedFactsFound / groundedFactsExpected >= corpus.thresholds.minimumGroundedFactRecall &&
      claimPrecision >= corpus.thresholds.minimumClaimPrecision &&
      forbiddenFactHits <= corpus.thresholds.maximumForbiddenFactHits &&
      casePassRate >= corpus.thresholds.minimumCasePassRate,
  };
}
