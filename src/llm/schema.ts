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
    'evidence',
  ],
} as const;

const MAX_ITEMS = 20;
const MAX_ITEM_LENGTH = 500;

function coerceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_ITEM_LENGTH))
    .filter((item) => item.length > 0)
    .slice(0, MAX_ITEMS);
}

/**
 * Validates and clamps model output. A model that returns the wrong shape, or
 * an enormous list, yields a partial summary rather than an exception — a bad
 * summary must never cost the user their audio and transcript.
 */
export function parseSummary(raw: unknown): StructuredSummary {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SUMMARY;
  const record = raw as Record<string, unknown>;

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
    summary: typeof record['summary'] === 'string' ? record['summary'].trim().slice(0, 4000) : '',
    decisions: coerceList(record['decisions']),
    tasks: coerceList(record['tasks']),
    commitments: coerceList(record['commitments']),
    people: coerceList(record['people']),
    places: coerceList(record['places']),
    expenses: coerceList(record['expenses']),
    ideas: coerceList(record['ideas']),
    questions: coerceList(record['questions']),
    uncertainties: coerceList(record['uncertainties']),
    evidence,
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
