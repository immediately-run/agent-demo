/**
 * R3-856 — grep's `flags`, normalised in one place.
 *
 * The schema used to say only `Regex flags, e.g. "i"`, and `grep` passed the
 * string straight to `new RegExp`. Models reach for grep's command-line flags:
 * `"n"` died on `invalid regex` (the line-number flag, meaningless as a RegExp
 * flag), and `g`/`y` are WORSE than a refusal — `re.test` becomes stateful
 * across lines, silently skipping every other match. This module keeps the
 * letters that are safe per line (`i` `m` `s` `u`), drops the stateful pair,
 * and names every ignored letter so the model learns the real grammar in the
 * result instead of guessing again.
 */

/** The per-letter reasons the result names, so the model does not retry them. */
const IGNORED_REASONS: Record<string, string> = {
  n: 'line numbers are always shown',
  g: 'stateful with re.test here — matches would be skipped',
  y: 'stateful with re.test here — matches would be skipped',
};

/**
 * Why one ignored letter is ignored. The fallback is worded to stay TRUE for
 * every character it can name — d (hasIndices) and v (unicodeSets) ARE valid
 * JS RegExp flags this runtime accepts, so "not a JS RegExp flag" would teach
 * the model a falsehood (round-1 finding).
 */
export function ignoredFlagReason(letter: string): string {
  return IGNORED_REASONS[letter] ?? 'not accepted here (only i, m, s, u are)';
}

/**
 * Normalise a raw flags string into what `grep` can safely use.
 * Keeps `i` `m` `s` `u` (deduped, first-seen order); EVERY other character —
 * uppercase, digits, anything — is reported in `ignored` for the caller to
 * name in its result (round-1 finding: `flags:"I"` silently ran
 * case-sensitive with no note, the exact failure class this item kills).
 */
export function normalizeGrepFlags(raw: string): { flags: string; ignored: string[] } {
  const kept = new Set<string>();
  const ignored: string[] = [];
  for (const ch of String(raw ?? '')) {
    if (ch === 'i' || ch === 'm' || ch === 's' || ch === 'u') kept.add(ch);
    else ignored.push(ch);
  }
  return { flags: [...kept].join(''), ignored: [...new Set(ignored)] };
}

/** The note `grep` appends when letters were ignored, or '' when none were. */
export function ignoredFlagsNote(ignored: string[]): string {
  if (ignored.length === 0) return '';
  const per = ignored.map((l) => `${l} — ${ignoredFlagReason(l)}`);
  return ` (ignored flags: ${per.join('; ')})`;
}
