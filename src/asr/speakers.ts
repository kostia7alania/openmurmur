import type { SpeakerTurn } from './types.ts';

/**
 * Matching transcript segments to voices.
 *
 * The aligner and the diarizer cut the same audio independently — one on word
 * boundaries, the other on voice changes — so their spans never line up
 * exactly. A segment belongs to whichever voice it overlaps most.
 *
 * Pure, so every rule here is testable without audio or a model.
 */

/**
 * Which voice spoke a segment, or null when that cannot be answered.
 *
 * Null is returned for a segment with no timestamps and for one falling
 * entirely in a gap between turns. Both are common — some ASR output has no
 * timing, and the two models choose different boundaries — and an unlabelled
 * line is honest where a nearest-neighbour guess would not be.
 */
export function assignSpeaker(
  startMs: number | null,
  endMs: number | null,
  turns: readonly SpeakerTurn[],
): number | null {
  if (startMs === null) return null;
  const finish = endMs ?? startMs;

  let best: number | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.min(finish, turn.endMs) - Math.max(startMs, turn.startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = turn.speaker;
    }
  }
  return best;
}

export function speakerCount(turns: readonly SpeakerTurn[]): number {
  return new Set(turns.map((turn) => turn.speaker)).size;
}

/**
 * Shifts turns by a part's offset, so times refer to the whole session.
 *
 * Each part is diarized on its own, which means voice 0 in part 2 is not voice
 * 0 in part 1 — the clustering never saw both. Rather than pretend otherwise,
 * speakers are renumbered into a per-session space, so a session that rotated
 * mid-conversation reports more voices than were in the room. Sessions rotate
 * every 15 minutes by default, so this is rare and visible, which is better
 * than silently merging two strangers into one.
 */
export function offsetTurns(
  turns: readonly SpeakerTurn[],
  offsetMs: number,
  speakerBase: number,
): SpeakerTurn[] {
  return turns.map((turn) => ({
    startMs: turn.startMs + offsetMs,
    endMs: turn.endMs + offsetMs,
    speaker: turn.speaker + speakerBase,
  }));
}

/** Human-facing label. One-based, because "voice 0" reads like a bug. */
export function speakerLabel(speaker: number | null): string {
  return speaker === null ? 'Голос ?' : `Голос ${speaker + 1}`;
}
