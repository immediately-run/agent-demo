// Test-only fixture: a SuppressedError built the way the engine does for a
// failed `await using` — `error` is what disposal threw, `suppressed` is the
// original body failure. One home so every suite that drives the unwrap paths
// (storeError, fsTools) builds the same shape (R3-1026 review).
export const suppressed = (original: unknown, disposal: unknown): Error => {
  const e = new Error("An error was suppressed during disposal.") as Error & {
    suppressed?: unknown;
    error?: unknown;
  };
  e.suppressed = original;
  e.error = disposal;
  return e;
};
