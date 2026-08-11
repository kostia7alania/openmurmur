import {
  type ClaimEvidence,
  EMPTY_SUMMARY,
  type StructuredSummary,
  type SummaryClaimField,
} from './schema.ts';

export interface SummaryChunk {
  readonly id: string;
  readonly index: number;
  readonly count: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** Exact source characters covered by this chunk, without prompt annotations. */
  readonly sourceText: string;
  /** Source text with global transcript segment labels for the LLM prompt. */
  readonly promptText: string;
  readonly promptUtf8Bytes: number;
  readonly segmentIndexes: readonly number[];
}

export interface ChunkSummary {
  readonly chunk: SummaryChunk;
  readonly summary: StructuredSummary;
}

interface SourcePiece {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly segmentIndex: number | null;
}

interface PromptUnit extends SourcePiece {
  readonly sourceText: string;
  readonly promptText: string;
  readonly promptUtf8Bytes: number;
}

interface AggregationState {
  readonly lists: Record<ListField, string[]>;
  readonly itemIndexes: Map<string, number>;
  readonly claims: Map<string, ClaimEvidence>;
  readonly legacyEvidence: number[];
  readonly summaryParts: string[];
}

const LIST_FIELDS = [
  'decisions',
  'tasks',
  'commitments',
  'people',
  'places',
  'expenses',
  'ideas',
  'questions',
  'uncertainties',
] as const satisfies readonly SummaryClaimField[];
type ListField = (typeof LIST_FIELDS)[number];

const MAX_LIST_ITEMS = 20;
const MAX_SUMMARY_CHARACTERS = 4_000;
const MAX_EVIDENCE_SEGMENTS = 20;

function annotation(segmentIndex: number | null): string {
  return segmentIndex === null ? '[unsegmented]\n' : `[segment ${segmentIndex}]\n`;
}

function sourcePieces(transcript: string, segments: readonly string[]): SourcePiece[] {
  const pieces: SourcePiece[] = [];
  let cursor = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segment.length === 0) continue;
    const start = transcript.indexOf(segment, cursor);
    if (start < 0) continue;
    if (start > cursor) {
      pieces.push({ sourceStart: cursor, sourceEnd: start, segmentIndex: null });
    }
    const end = start + segment.length;
    pieces.push({ sourceStart: start, sourceEnd: end, segmentIndex });
    cursor = end;
  }
  if (cursor < transcript.length) {
    pieces.push({ sourceStart: cursor, sourceEnd: transcript.length, segmentIndex: null });
  }
  if (pieces.length === 0) {
    pieces.push({ sourceStart: 0, sourceEnd: transcript.length, segmentIndex: null });
  }
  return pieces;
}

function boundedEnd(text: string, start: number, endLimit: number, maxBytes: number): number {
  let cursor = start;
  let bytes = 0;
  let boundary = -1;
  while (cursor < endLimit) {
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    cursor += character.length;
    if (/\s/u.test(character) && bytes >= maxBytes * 0.6) boundary = cursor;
  }
  if (cursor === endLimit) return cursor;
  if (boundary > start) return boundary;
  return cursor;
}

function promptUnits(
  transcript: string,
  segments: readonly string[],
  maxPromptBytes: number,
): PromptUnit[] {
  const units: PromptUnit[] = [];
  for (const piece of sourcePieces(transcript, segments)) {
    const label = annotation(piece.segmentIndex);
    const contentBudget = maxPromptBytes - Buffer.byteLength(label);
    if (contentBudget < 4) throw new Error('summary prompt budget is too small for source labels');
    let start = piece.sourceStart;
    if (start === piece.sourceEnd) {
      units.push({
        ...piece,
        sourceText: '',
        promptText: label,
        promptUtf8Bytes: Buffer.byteLength(label),
      });
      continue;
    }
    while (start < piece.sourceEnd) {
      const relativeEnd = boundedEnd(transcript, start, piece.sourceEnd, contentBudget);
      if (relativeEnd <= start) throw new Error('summary prompt budget cannot fit one character');
      const sourceText = transcript.slice(start, relativeEnd);
      const promptText = `${label}${sourceText}`;
      units.push({
        sourceStart: start,
        sourceEnd: relativeEnd,
        segmentIndex: piece.segmentIndex,
        sourceText,
        promptText,
        promptUtf8Bytes: Buffer.byteLength(promptText),
      });
      start = relativeEnd;
    }
  }
  return units;
}

/**
 * Covers every transcript code unit exactly once and adds only provenance
 * labels. The byte bound applies to the annotated transcript portion of each
 * prompt; Ollama orchestration separately accounts for system/metadata bytes.
 */
export function planSummaryChunks(
  transcript: string,
  segments: readonly string[],
  maxPromptBytes: number,
): SummaryChunk[] {
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 64) {
    throw new Error('summary prompt byte budget must be an integer of at least 64');
  }
  const units = promptUnits(transcript, segments, maxPromptBytes);
  const provisional: Omit<SummaryChunk, 'id' | 'index' | 'count'>[] = [];
  let current: PromptUnit[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    const segmentIndexes = [
      ...new Set(
        current.map((unit) => unit.segmentIndex).filter((index): index is number => index !== null),
      ),
    ];
    provisional.push({
      sourceStart: current[0]?.sourceStart ?? 0,
      sourceEnd: current.at(-1)?.sourceEnd ?? 0,
      sourceText: current.map((unit) => unit.sourceText).join(''),
      promptText: current.map((unit) => unit.promptText).join('\n'),
      promptUtf8Bytes: currentBytes,
      segmentIndexes,
    });
    current = [];
    currentBytes = 0;
  };

  for (const unit of units) {
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (
      current.length > 0 &&
      currentBytes + separatorBytes + unit.promptUtf8Bytes > maxPromptBytes
    ) {
      flush();
    }
    current.push(unit);
    currentBytes += (current.length === 1 ? 0 : 1) + unit.promptUtf8Bytes;
  }
  flush();

  const count = provisional.length;
  const width = String(Math.max(count, 1)).length;
  return provisional.map((chunk, index) => ({
    ...chunk,
    id: `chunk-${String(index + 1).padStart(width, '0')}-of-${count}`,
    index,
    count,
  }));
}

function normalizedItem(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function allowedSegments(chunk: SummaryChunk, segments: readonly number[]): number[] {
  const allowed = new Set(chunk.segmentIndexes);
  return [...new Set(segments.filter((segment) => allowed.has(segment)))].slice(
    0,
    MAX_EVIDENCE_SEGMENTS,
  );
}

function aggregationState(): AggregationState {
  return {
    lists: {
      decisions: [],
      tasks: [],
      commitments: [],
      people: [],
      places: [],
      expenses: [],
      ideas: [],
      questions: [],
      uncertainties: [],
    },
    itemIndexes: new Map(),
    claims: new Map(),
    legacyEvidence: [],
    summaryParts: [],
  };
}

function mergeClaim(
  state: AggregationState,
  field: SummaryClaimField,
  item: number,
  segments: readonly number[],
): void {
  if (segments.length === 0) return;
  const key = `${field}:${item}`;
  const existing = state.claims.get(key);
  state.claims.set(key, {
    field,
    item,
    segments: [...new Set([...(existing?.segments ?? []), ...segments])].slice(
      0,
      MAX_EVIDENCE_SEGMENTS,
    ),
  });
}

function mergeChunkSummary(state: AggregationState, result: ChunkSummary): void {
  const { chunk, summary } = result;
  const summaryItem = summary.summary.trim();
  if (summaryItem.length > 0) {
    state.summaryParts.push(summaryItem);
    for (const evidence of summary.claimEvidence) {
      if (evidence.field === 'summary' && evidence.item === 0) {
        mergeClaim(state, 'summary', 0, allowedSegments(chunk, evidence.segments));
      }
    }
  }

  for (const field of LIST_FIELDS) {
    for (const [sourceItem, value] of summary[field].entries()) {
      const dedupeKey = `${field}:${normalizedItem(value)}`;
      let targetItem = state.itemIndexes.get(dedupeKey);
      if (targetItem === undefined) {
        targetItem = state.lists[field].length;
        state.lists[field].push(value);
        state.itemIndexes.set(dedupeKey, targetItem);
      }
      for (const evidence of summary.claimEvidence) {
        if (evidence.field === field && evidence.item === sourceItem) {
          mergeClaim(state, field, targetItem, allowedSegments(chunk, evidence.segments));
        }
      }
    }
  }
  for (const reference of summary.evidence) {
    state.legacyEvidence.push(...allowedSegments(chunk, [reference.segment]));
  }
}

/** Stable, chunk-ordered aggregation. It never lets downstream schema clamps
 * silently discard overflow: any explicit bound produces an uncertainty note. */
export function aggregateChunkSummaries(results: readonly ChunkSummary[]): StructuredSummary {
  if (results.length === 0) return EMPTY_SUMMARY;
  const state = aggregationState();
  for (const result of results) mergeChunkSummary(state, result);

  const overflow: string[] = [];
  for (const field of LIST_FIELDS) {
    if (state.lists[field].length > MAX_LIST_ITEMS) {
      overflow.push(`${field}: ${state.lists[field].length - MAX_LIST_ITEMS}`);
      state.lists[field] = state.lists[field].slice(0, MAX_LIST_ITEMS);
    }
  }
  let summary = state.summaryParts.join('\n\n');
  let summaryTruncated = false;
  if (summary.length > MAX_SUMMARY_CHARACTERS) {
    overflow.push(`summary characters: ${summary.length - MAX_SUMMARY_CHARACTERS}`);
    let bounded = '';
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(summary)) {
      if (bounded.length + segment.length > MAX_SUMMARY_CHARACTERS) break;
      bounded += segment;
    }
    summary = bounded;
    summaryTruncated = true;
  }
  if (overflow.length > 0) {
    if (state.lists.uncertainties.length === MAX_LIST_ITEMS) {
      overflow.push('uncertainties reserved for bound notice: 1');
    }
    const notice = `Aggregation output bound reached; omitted ${overflow.join(', ')}. Review the complete transcript for those details.`;
    state.lists.uncertainties = [...state.lists.uncertainties.slice(0, MAX_LIST_ITEMS - 1), notice];
  }

  const retainedClaims = [...state.claims.values()].filter((claim) => {
    if (claim.field === 'summary') {
      return !summaryTruncated && summary.length > 0 && claim.item === 0;
    }
    if (claim.field === 'uncertainties' && overflow.length > 0) {
      return claim.item < MAX_LIST_ITEMS - 1;
    }
    return claim.item < state.lists[claim.field].length;
  });
  return {
    summary,
    decisions: state.lists.decisions,
    tasks: state.lists.tasks,
    commitments: state.lists.commitments,
    people: state.lists.people,
    places: state.lists.places,
    expenses: state.lists.expenses,
    ideas: state.lists.ideas,
    questions: state.lists.questions,
    uncertainties: state.lists.uncertainties,
    claimEvidence: retainedClaims,
    evidence: [...new Set(state.legacyEvidence)]
      .slice(0, MAX_EVIDENCE_SEGMENTS)
      .map((segment) => ({ segment })),
  };
}
