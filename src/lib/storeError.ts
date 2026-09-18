// Turning a store failure into something a user (or a debugging agent) can act on.
//
// The hard part is `SuppressedError`. ZenFS's file handles use explicit resource
// management (`await using`), so when an operation throws AND the handle's disposal
// also throws, the engine replaces both with a `SuppressedError` whose own message
// is the useless constant "An error was suppressed during disposal." — the ACTUAL
// cause is hidden on `.suppressed` (the original error) and `.error` (the disposal
// one). Reporting `e.message` therefore tells you nothing at exactly the moment you
// most need to know, which is what happened when the conversation store started
// failing after R3-247 (roadmap R3-248).
//
// So: unwrap. Walk into the suppressed chain, prefer a `code` (the platform's typed
// error vocabulary) over free text, and keep the outermost context as a fallback.

/** A thrown value that might be a SuppressedError or carry a platform `code`. */
type MaybeSuppressed = {
  code?: string;
  message?: string;
  /** The original error the `using` body threw (what we actually want). */
  suppressed?: unknown;
  /** The error the disposal threw. */
  error?: unknown;
};

const isObj = (v: unknown): v is MaybeSuppressed =>
  typeof v === "object" && v !== null;

/**
 * Flatten a (possibly nested) `SuppressedError` into the chain of underlying
 * errors, innermost causes first. A plain error yields itself.
 */
export function unwrapSuppressed(e: unknown, depth = 0): unknown[] {
  if (!isObj(e) || depth > 8) return [e];
  const out: unknown[] = [];
  // `suppressed` is the ORIGINAL failure — the interesting one — so it leads.
  if (e.suppressed !== undefined) out.push(...unwrapSuppressed(e.suppressed, depth + 1));
  if (e.error !== undefined) out.push(...unwrapSuppressed(e.error, depth + 1));
  if (out.length === 0) return [e];
  out.push(e);
  return out;
}

/** The most informative label for one thrown value: its platform `code` if it has
 *  one, else its message, else its stringification. */
const label = (e: unknown): string => {
  if (!isObj(e)) return String(e);
  return e.code ?? e.message ?? String(e);
};

/**
 * A user-facing sentence for a conversation-store failure. `auth-required` is the
 * ordinary signed-out case and gets friendly wording; everything else NAMES the
 * cause — unwrapped past any `SuppressedError` — so a bad capability grant or a
 * failing settings mount is diagnosable from the UI alone.
 */
export function describeStoreFailure(e: unknown, suffix = ""): string {
  const chain = unwrapSuppressed(e);
  const codes = chain.map((c) => (isObj(c) ? c.code : undefined)).filter(Boolean) as string[];
  if (codes.includes("auth-required")) {
    return `Sign in to keep your conversations${suffix ? " (and their history)" : ""}.`;
  }
  // Prefer the innermost distinct labels; drop the SuppressedError's own useless
  // constant message when we managed to unwrap something better.
  const parts: string[] = [];
  for (const c of chain) {
    const l = label(c);
    if (!l || parts.includes(l)) continue;
    if (chain.length > 1 && /suppressed during disposal/i.test(l)) continue;
    parts.push(l);
  }
  const detail = parts.length ? parts.join(" ← ") : label(e);
  return `Conversations can't be saved (${detail})${suffix}.`;
}

// ── R3-561: the advisory run lease's two outcomes, as copy ────────────────────
//
// WHY HERE. `append` rejects with one of two typed codes when this frame does not
// hold the lease, and both are UX states rather than codes to print
// (AGENT_RUN_DURABILITY_SPEC §9). Three run catches consume them — `run` and
// `resumeRun` in ConversationStage, and CodingAgent's — and the first attempt
// pasted the discrimination into two of them and missed the third, which is
// exactly what a pasted block does. `isJournalRefusal` beside it is the existing
// precedent for code discrimination living in `lib` rather than in a `.tsx`, and
// this module is already the tested home for store-error copy.

/** `append` refused because this frame does not hold the run lease. Either the
 *  conversation was deleted under it, or another frame took the lease. */
export type LeaseFailure = 'conversation-removed' | 'lease-lost';

/** Which of the two, or `null` for anything else. The ONE place the codes are
 *  matched — a caller that re-spells them is the bug this function exists to
 *  prevent. */
export function leaseFailure(e: unknown): LeaseFailure | null {
  const c = isObj(e) ? e.code : undefined;
  return c === 'conversation-removed' || c === 'lease-lost' ? c : null;
}

/**
 * What to tell the user, given a lease failure and whether this surface can offer
 * a takeover.
 *
 * `canTakeOver` exists because the two surfaces honestly differ: ConversationStage
 * raises a takeover banner, CodingAgent has no affordance row and deliberately
 * does not invent one. R-ARD-18a still forbids a dead end, so the no-takeover copy
 * names what ACTUALLY frees the lease — its TTL — rather than an action the
 * component does not ship. Naming an affordance that is not there is the placebo
 * this split avoids.
 */
export function leaseFailureText(failure: LeaseFailure, canTakeOver: boolean): string {
  if (failure === 'conversation-removed') {
    return 'This conversation was deleted while the run was going, so the run stopped here. The file changes it already made stay.';
  }
  return canTakeOver
    ? 'Another window took over this conversation, so this one stopped rather than driving the same files. Nothing here was lost — reopen it there, or take it back below.'
    : 'Another window took over this conversation, so this one stopped rather than driving the same files. Nothing here was lost — carry on in that window, or wait about a minute and run again: it frees up on its own once that window is gone.';
}

/** The copy for `acquireRun` answering `held` — the run never started. Same
 *  `canTakeOver` split, and the same reason for it. */
export function leaseHeldText(canTakeOver: boolean): string {
  return canTakeOver
    ? 'Another window may be running this conversation. Only one should drive the files at a time — take over if that window is gone.'
    : 'Another window may be running this conversation. Only one should drive the files at a time. Carry on in that window, or wait about a minute and run again: it frees up on its own once that window is gone.';
}
