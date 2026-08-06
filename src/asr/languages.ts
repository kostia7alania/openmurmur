/**
 * What languages a transcript actually contains.
 *
 * The model reports the language it decided on, and on genuinely mixed speech
 * that answer is incomplete. Measured on a real recording: 108 Thai characters
 * and 195 Latin ones — a Thai-English conversation — reported as `["th"]`.
 * The transcription was right; only the label was wrong, and the label is what
 * the report, the digest and the search index are built on.
 *
 * So the declared languages are treated as a claim and reconciled against the
 * writing systems present in the text. Script is not language — Latin covers
 * English, Dutch and Malay alike — so this can only ever confirm that *some*
 * language using that script is present. That is exactly why a script is only
 * ever *added* when the model claimed nothing for it, and never used to
 * contradict a claim the model did make.
 */

interface ScriptRule {
  readonly code: string;
  readonly pattern: RegExp;
}

/**
 * Only the scripts this product claims to handle, plus the two that show up in
 * hallucinations. Anything else stays unnamed rather than guessed at.
 */
const SCRIPTS: readonly ScriptRule[] = [
  { code: 'th', pattern: /\p{Script=Thai}/u },
  { code: 'ru', pattern: /\p{Script=Cyrillic}/u },
  { code: 'en', pattern: /\p{Script=Latin}/u },
  { code: 'zh', pattern: /\p{Script=Han}/u },
];

/** Characters of a script needed before it counts, so one stray glyph is not a language. */
const MIN_CHARS = 8;

function scriptCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of text) {
    for (const { code, pattern } of SCRIPTS) {
      if (pattern.test(character)) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

/**
 * Merges the model's answer with what the text demonstrably contains.
 *
 * A declared language is always kept: the model heard the audio and this
 * function did not. A script is added only when it is well represented and no
 * declared language already uses it, which is what stops a handful of English
 * loanwords in Thai speech from being announced as a second language.
 */
export function reconcileLanguages(
  declared: readonly string[],
  text: string,
): { readonly languages: readonly string[]; readonly added: readonly string[] } {
  const kept = declared.map((language) => language.toLowerCase());
  const claimed = new Set(kept);
  const counts = scriptCounts(text);
  const added: string[] = [];

  for (const { code } of SCRIPTS) {
    if ((counts.get(code) ?? 0) < MIN_CHARS) continue;
    if (claimed.has(code)) continue;
    // Latin is the ambiguous one: `en` here means "a Latin-script language",
    // and it is added only when nothing Latin-script was declared at all.
    added.push(code);
    claimed.add(code);
  }

  return { languages: [...kept, ...added], added };
}

/**
 * Scripts present in the text that no declared language accounts for and that
 * this product does not handle.
 *
 * Chinese characters appearing in a Thai transcript are not code-switching:
 * they are the model drifting. Reported so the daemon can log it rather than
 * quietly delivering nonsense, but never removed — silently editing a
 * transcript would be worse than an odd one.
 */
export function foreignScripts(declared: readonly string[], text: string): readonly string[] {
  const claimed = new Set(declared.map((language) => language.toLowerCase()));
  const counts = scriptCounts(text);
  const expected = new Set(['th', 'ru', 'en']);

  const foreign: string[] = [];
  for (const [code, count] of counts) {
    if (count < MIN_CHARS) continue;
    if (claimed.has(code)) continue;
    if (expected.has(code)) continue;
    foreign.push(code);
  }
  return foreign;
}
