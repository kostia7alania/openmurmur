import {
  EMPTY_SUMMARY,
  type StructuredSummary,
  SUMMARY_CLAIM_FIELDS,
  type SummaryClaimField,
} from './schema.ts';

export interface ExpectedSummaryFact {
  readonly field: SummaryClaimField;
  /** Human-readable canonical wording for the grounded fact. */
  readonly claim: string;
  /** Every term must occur in the transcript, canonical wording and a matching output claim. */
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

interface OutputClaim {
  readonly field: SummaryClaimField;
  readonly normalized: string;
}

function outputClaims(summary: StructuredSummary): OutputClaim[] {
  return SUMMARY_CLAIM_FIELDS.flatMap((field) =>
    fieldClaims(summary, field).map((claim) => ({ field, normalized: normalized(claim) })),
  );
}

function claimMatchesFact(claim: OutputClaim, fact: ExpectedSummaryFact): boolean {
  return (
    claim.field === fact.field &&
    fact.terms.every((term) => claim.normalized.includes(normalized(term)))
  );
}

/** Maximum one-to-one matching prevents one broad claim or duplicate claims from earning extra credit. */
function matchedFacts(
  claims: readonly OutputClaim[],
  facts: readonly ExpectedSummaryFact[],
): number {
  const factOwners = new Map<number, number>();
  const assign = (claimIndex: number, seenFacts: Set<number>): boolean => {
    const claim = claims[claimIndex];
    if (claim === undefined) return false;
    for (const [factIndex, fact] of facts.entries()) {
      if (seenFacts.has(factIndex) || !claimMatchesFact(claim, fact)) continue;
      seenFacts.add(factIndex);
      const owner = factOwners.get(factIndex);
      if (owner === undefined || assign(owner, seenFacts)) {
        factOwners.set(factIndex, claimIndex);
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (const claimIndex of claims.keys()) {
    if (assign(claimIndex, new Set())) matched += 1;
  }
  return matched;
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
  const factTermKeys = new Set<string>();
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
    const termKeys = new Set<string>();
    for (const term of fact.terms) {
      const normalizedTerm = normalized(term);
      if (termKeys.has(normalizedTerm)) {
        throw new Error(
          `summary acceptance fact ${testCase.id}/${fact.field} has a duplicate term: ${term}`,
        );
      }
      termKeys.add(normalizedTerm);
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
    const termKey = `${fact.field}:${[...termKeys].sort().join('\u0000')}`;
    if (factTermKeys.has(termKey)) {
      throw new Error(
        `summary acceptance case ${testCase.id} has ambiguous ${fact.field} term signatures`,
      );
    }
    factTermKeys.add(termKey);
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
  const claims = outputClaims(summary);
  const uniqueClaims = [
    ...new Map(claims.map((claim) => [`${claim.field}\u0000${claim.normalized}`, claim])).values(),
  ];
  const groundedFactsFound = matchedFacts(uniqueClaims, testCase.expectedFacts);
  const groundedFactsExpected = testCase.expectedFacts.length;
  const groundedFactRecall = groundedFactsFound / groundedFactsExpected;
  const matchedOutputClaims = groundedFactsFound;
  const outputClaimCount = claims.length;
  const unlistedClaims = outputClaimCount - matchedOutputClaims;
  const claimPrecision = outputClaimCount === 0 ? 1 : matchedOutputClaims / outputClaimCount;
  const output = normalized(allClaimText(summary));
  const forbiddenFactHits = testCase.forbiddenFacts.filter((fact) =>
    output.includes(normalized(fact)),
  ).length;
  return {
    id: testCase.id,
    groundedFactsFound,
    groundedFactsExpected,
    groundedFactRecall,
    outputClaims: outputClaimCount,
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
