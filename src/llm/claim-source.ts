import type { StructuredSummary, SummaryClaimField } from './schema.ts';

export interface ClaimSourceSegment {
  readonly text: string;
}

export type ClaimSourceResolution =
  | {
      readonly kind: 'missing';
      readonly segments: readonly [];
    }
  | {
      readonly kind: 'referenced';
      readonly segments: readonly number[];
    }
  | {
      readonly kind: 'unlocalized';
      readonly segments: readonly number[];
    }
  | {
      readonly kind: 'localized';
      readonly segments: readonly number[];
      readonly localizedSegment: number;
      readonly excerpt: string;
    };

interface WordToken {
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}

interface WordMatch {
  readonly start: number;
  readonly end: number;
  readonly wordCount: number;
  readonly characterCount: number;
}

function claimText(summary: StructuredSummary, field: SummaryClaimField, item: number): string {
  if (field === 'summary') return summary.summary;
  return summary[field][item] ?? '';
}

function wordTokens(text: string): WordToken[] {
  return [...new Intl.Segmenter('und', { granularity: 'word' }).segment(text)]
    .filter((part) => part.isWordLike === true)
    .map((part) => ({
      normalized: part.segment.normalize('NFC').toLocaleLowerCase('und'),
      start: part.index,
      end: part.index + part.segment.length,
    }));
}

function bestWordMatch(claim: string, source: string): WordMatch | null {
  const claimTokens = wordTokens(claim);
  const sourceTokens = wordTokens(source);
  if (claimTokens.length === 0 || sourceTokens.length === 0) return null;

  const claimPositions = new Map<string, number[]>();
  for (const [index, token] of claimTokens.entries()) {
    const positions = claimPositions.get(token.normalized) ?? [];
    positions.push(index);
    claimPositions.set(token.normalized, positions);
  }

  let previous = new Map<number, WordMatch>();
  let best: WordMatch | null = null;
  for (const sourceToken of sourceTokens) {
    const current = new Map<number, WordMatch>();
    for (const claimIndex of claimPositions.get(sourceToken.normalized) ?? []) {
      const prefix = previous.get(claimIndex - 1);
      const candidate: WordMatch = {
        start: prefix?.start ?? sourceToken.start,
        end: sourceToken.end,
        wordCount: (prefix?.wordCount ?? 0) + 1,
        characterCount: (prefix?.characterCount ?? 0) + sourceToken.normalized.length,
      };
      current.set(claimIndex, candidate);
      if (
        best === null ||
        candidate.wordCount > best.wordCount ||
        (candidate.wordCount === best.wordCount && candidate.characterCount > best.characterCount)
      ) {
        best = candidate;
      }
    }
    previous = current;
  }

  if (
    best === null ||
    (best.wordCount === 1 && (claimTokens.length > 1 || best.characterCount < 3))
  ) {
    return null;
  }
  return best;
}

function htmlEscapedLength(text: string): number {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').length;
}

function localizedSourceExcerpt(
  claim: string,
  source: string,
): (WordMatch & { readonly excerpt: string }) | null {
  const match = bestWordMatch(claim, source);
  if (match === null) return null;

  const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(source)];
  let anchorStart = 0;
  while (
    anchorStart + 1 < graphemes.length &&
    (graphemes[anchorStart + 1]?.index ?? source.length) <= match.start
  ) {
    anchorStart += 1;
  }
  let anchorEnd = anchorStart + 1;
  while (
    anchorEnd < graphemes.length &&
    (graphemes[anchorEnd]?.index ?? source.length) < match.end
  ) {
    anchorEnd += 1;
  }

  const maxGraphemes = 120;
  const midpoint = Math.floor((anchorStart + anchorEnd) / 2);
  let left = Math.max(
    0,
    Math.min(graphemes.length - maxGraphemes, midpoint - Math.floor(maxGraphemes / 2)),
  );
  let right = Math.min(graphemes.length, left + maxGraphemes);
  const render = () =>
    `${left > 0 ? '…' : ''}${graphemes
      .slice(left, right)
      .map((part) => part.segment)
      .join('')}${right < graphemes.length ? '…' : ''}`;

  while (htmlEscapedLength(render()) > 320) {
    const leftContext = anchorStart - left;
    const rightContext = right - anchorEnd;
    if (leftContext <= 0 && rightContext <= 0) return null;
    if (rightContext > leftContext && right > anchorEnd) right -= 1;
    else if (left < anchorStart) left += 1;
    else right -= 1;
  }
  return { ...match, excerpt: render() };
}

/** Resolves model-reported segment references without treating them as factual proof. */
export function resolveClaimSource(
  summary: StructuredSummary,
  field: SummaryClaimField,
  item: number,
  transcriptSegments: readonly ClaimSourceSegment[],
): ClaimSourceResolution {
  const segments =
    summary.claimEvidence.find((claim) => claim.field === field && claim.item === item)?.segments ??
    [];
  if (segments.length === 0) return { kind: 'missing', segments: [] };

  const claim = claimText(summary, field, item);
  let best:
    | {
        readonly segment: number;
        readonly excerpt: string;
        readonly wordCount: number;
        readonly characterCount: number;
      }
    | undefined;
  let hasSourceText = false;
  for (const segment of segments) {
    const text = transcriptSegments[segment]?.text.replace(/\s+/gu, ' ').trim() ?? '';
    if (text.length === 0) continue;
    hasSourceText = true;
    const match = localizedSourceExcerpt(claim, text);
    if (
      match !== null &&
      (best === undefined ||
        match.wordCount > best.wordCount ||
        (match.wordCount === best.wordCount && match.characterCount > best.characterCount))
    ) {
      best = { segment, ...match };
    }
  }

  if (best !== undefined) {
    return {
      kind: 'localized',
      segments,
      localizedSegment: best.segment,
      excerpt: best.excerpt,
    };
  }
  return { kind: hasSourceText ? 'unlocalized' : 'referenced', segments };
}

export function renderClaimSourceLabel(source: ClaimSourceResolution): string {
  if (source.kind === 'missing') return 'ссылка модели: не указана';

  const label = `ссылка модели: сегм. ${source.segments.map((segment) => segment + 1).join(', ')}`;
  if (source.kind === 'localized') {
    const excerptLabel =
      source.segments.length === 1 ? 'фрагмент' : `фрагмент сегм. ${source.localizedSegment + 1}`;
    return `${label}; ${excerptLabel}: «${source.excerpt}»`;
  }
  if (source.kind === 'unlocalized') {
    return `${label}; фрагмент внутри сегмента не локализован`;
  }
  return label;
}
