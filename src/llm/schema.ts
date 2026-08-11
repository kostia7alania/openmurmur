/**
 * Structured extraction schema.
 *
 * The LLM is a text-to-JSON function and nothing else. It has no tools, no
 * shell, no filesystem, no network and no say in where messages go, what is
 * retained, or what is deleted. Its entire output is this object, which is
 * validated before use; anything unparseable degrades to "no summary" rather
 * than to unchecked behaviour.
 */

export interface EvidenceRef {
  /** Index into the transcript segment list this claim came from. */
  readonly segment: number;
}

export const SUMMARY_CLAIM_FIELDS = [
  'summary',
  'decisions',
  'tasks',
  'commitments',
  'people',
  'places',
  'expenses',
  'ideas',
  'questions',
  'uncertainties',
] as const;

export type SummaryClaimField = (typeof SUMMARY_CLAIM_FIELDS)[number];

/**
 * Revision-local provenance for one summary claim.
 *
 * `item` is zero for the summary paragraph and the zero-based item index for a
 * list field. `segments` contains immutable `transcript_segments.segment_index`
 * values from the revision stored alongside the summary row.
 */
export interface ClaimEvidence {
  readonly field: SummaryClaimField;
  readonly item: number;
  readonly segments: readonly number[];
}

export interface StructuredSummary {
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly tasks: readonly string[];
  readonly commitments: readonly string[];
  readonly people: readonly string[];
  readonly places: readonly string[];
  readonly expenses: readonly string[];
  readonly ideas: readonly string[];
  readonly questions: readonly string[];
  readonly uncertainties: readonly string[];
  /** Claim-level references used by reports and durable recall. */
  readonly claimEvidence: readonly ClaimEvidence[];
  /** Legacy summary-wide references retained for stored-payload compatibility. */
  readonly evidence: readonly EvidenceRef[];
}

export const EMPTY_SUMMARY: StructuredSummary = {
  summary: '',
  decisions: [],
  tasks: [],
  commitments: [],
  people: [],
  places: [],
  expenses: [],
  ideas: [],
  questions: [],
  uncertainties: [],
  claimEvidence: [],
  evidence: [],
};

const STRING_LIST = {
  type: 'array',
  items: { type: 'string' },
} as const;

/** JSON Schema handed to Ollama's `format` parameter for constrained decoding. */
export const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    decisions: STRING_LIST,
    tasks: STRING_LIST,
    commitments: STRING_LIST,
    people: STRING_LIST,
    places: STRING_LIST,
    expenses: STRING_LIST,
    ideas: STRING_LIST,
    questions: STRING_LIST,
    uncertainties: STRING_LIST,
    claimEvidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: SUMMARY_CLAIM_FIELDS },
          item: { type: 'integer', minimum: 0 },
          segments: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'integer', minimum: 0 },
          },
        },
        required: ['field', 'item', 'segments'],
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: { segment: { type: 'integer' } },
        required: ['segment'],
      },
    },
  },
  required: [
    'summary',
    'decisions',
    'tasks',
    'commitments',
    'people',
    'places',
    'expenses',
    'ideas',
    'questions',
    'uncertainties',
    'claimEvidence',
    'evidence',
  ],
} as const;

const MAX_ITEMS = 20;
const MAX_ITEM_LENGTH = 500;
const MAX_CLAIM_EVIDENCE = 1 + (SUMMARY_CLAIM_FIELDS.length - 1) * MAX_ITEMS;
const SUMMARY_CLAIM_FIELD_SET = new Set<string>(SUMMARY_CLAIM_FIELDS);

interface CoercedList {
  readonly values: string[];
  /** Raw model-array index to the surviving normalized output index. */
  readonly itemIndexes: ReadonlyMap<number, number>;
}

function coerceList(value: unknown): CoercedList {
  const values: string[] = [];
  const itemIndexes = new Map<number, number>();
  if (!Array.isArray(value)) return { values, itemIndexes };
  for (const [sourceIndex, candidate] of value.entries()) {
    if (typeof candidate !== 'string') continue;
    const item = candidate.trim().slice(0, MAX_ITEM_LENGTH);
    if (item.length === 0) continue;
    if (values.length >= MAX_ITEMS) break;
    itemIndexes.set(sourceIndex, values.length);
    values.push(item);
  }
  return { values, itemIndexes };
}

/**
 * Validates and clamps model output. A model that returns the wrong shape, or
 * an enormous list, yields a partial summary rather than an exception — a bad
 * summary must never cost the user their audio and transcript.
 */
export function parseSummary(raw: unknown): StructuredSummary {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SUMMARY;
  const record = raw as Record<string, unknown>;

  const summary =
    typeof record['summary'] === 'string' ? record['summary'].trim().slice(0, 4000) : '';
  const coercedLists = {
    decisions: coerceList(record['decisions']),
    tasks: coerceList(record['tasks']),
    commitments: coerceList(record['commitments']),
    people: coerceList(record['people']),
    places: coerceList(record['places']),
    expenses: coerceList(record['expenses']),
    ideas: coerceList(record['ideas']),
    questions: coerceList(record['questions']),
    uncertainties: coerceList(record['uncertainties']),
  };
  const decisions = coercedLists.decisions.values;
  const tasks = coercedLists.tasks.values;
  const commitments = coercedLists.commitments.values;
  const people = coercedLists.people.values;
  const places = coercedLists.places.values;
  const expenses = coercedLists.expenses.values;
  const ideas = coercedLists.ideas.values;
  const questions = coercedLists.questions.values;
  const uncertainties = coercedLists.uncertainties.values;

  const claimItemIndexes: Readonly<Record<SummaryClaimField, ReadonlyMap<number, number>>> = {
    summary: summary.length === 0 ? new Map() : new Map([[0, 0]]),
    decisions: coercedLists.decisions.itemIndexes,
    tasks: coercedLists.tasks.itemIndexes,
    commitments: coercedLists.commitments.itemIndexes,
    people: coercedLists.people.itemIndexes,
    places: coercedLists.places.itemIndexes,
    expenses: coercedLists.expenses.itemIndexes,
    ideas: coercedLists.ideas.itemIndexes,
    questions: coercedLists.questions.itemIndexes,
    uncertainties: coercedLists.uncertainties.itemIndexes,
  };

  const claimEvidence = coerceClaimEvidence(record['claimEvidence'], claimItemIndexes);

  const evidence = Array.isArray(record['evidence'])
    ? record['evidence']
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .map((item) => item['segment'])
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
        .slice(0, MAX_ITEMS)
        .map((segment) => ({ segment }))
    : [];

  return {
    summary,
    decisions,
    tasks,
    commitments,
    people,
    places,
    expenses,
    ideas,
    questions,
    uncertainties,
    claimEvidence,
    evidence,
  };
}

function coerceClaimEvidence(
  value: unknown,
  claimItemIndexes: Readonly<Record<SummaryClaimField, ReadonlyMap<number, number>>>,
): ClaimEvidence[] {
  if (!Array.isArray(value)) return [];

  const byClaim = new Map<string, { field: SummaryClaimField; item: number; segments: number[] }>();
  for (const candidate of value.slice(0, MAX_CLAIM_EVIDENCE)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const field = record['field'];
    const item = record['item'];
    if (
      typeof field !== 'string' ||
      !SUMMARY_CLAIM_FIELD_SET.has(field) ||
      typeof item !== 'number' ||
      !Number.isInteger(item) ||
      item < 0
    ) {
      continue;
    }
    const typedField = field as SummaryClaimField;
    const outputItem = claimItemIndexes[typedField].get(item);
    if (outputItem === undefined) continue;

    const segments = Array.isArray(record['segments'])
      ? [
          ...new Set(
            record['segments'].filter(
              (segment): segment is number =>
                typeof segment === 'number' && Number.isInteger(segment) && segment >= 0,
            ),
          ),
        ].slice(0, MAX_ITEMS)
      : [];
    if (segments.length === 0) continue;

    const key = `${typedField}:${outputItem}`;
    const existing = byClaim.get(key);
    if (existing === undefined) {
      byClaim.set(key, { field: typedField, item: outputItem, segments });
    } else {
      existing.segments = [...new Set([...existing.segments, ...segments])].slice(0, MAX_ITEMS);
    }
  }
  return [...byClaim.values()];
}

/** Removes model-supplied references that do not exist in the bound revision. */
export function boundClaimEvidence(
  summary: StructuredSummary,
  transcriptSegmentCount: number,
): StructuredSummary {
  const limit = Math.max(0, Math.trunc(transcriptSegmentCount));
  return {
    ...summary,
    claimEvidence: summary.claimEvidence
      .map((claim) => ({
        ...claim,
        segments: claim.segments.filter((segment) => segment < limit),
      }))
      .filter((claim) => claim.segments.length > 0),
    evidence: summary.evidence.filter((reference) => reference.segment < limit),
  };
}

export function isEmptySummary(summary: StructuredSummary): boolean {
  return (
    summary.summary.length === 0 &&
    summary.decisions.length === 0 &&
    summary.tasks.length === 0 &&
    summary.ideas.length === 0 &&
    summary.questions.length === 0
  );
}
