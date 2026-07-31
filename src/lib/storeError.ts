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
