import { describe, it, expect } from "vitest";
import { describeStoreFailure, unwrapSuppressed } from "./storeError";

/** Build a real SuppressedError the way the engine does for a failed `await using`:
 *  `error` is what disposal threw, `suppressed` is the original body failure. */
const suppressed = (original: unknown, disposal: unknown): Error => {
  const e = new Error("An error was suppressed during disposal.") as Error & {
    suppressed?: unknown;
    error?: unknown;
  };
  e.suppressed = original;
  e.error = disposal;
  return e;
};

const coded = (code: string, message = "boom"): Error => {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
};

describe("unwrapSuppressed", () => {
  it("returns a plain error as itself", () => {
    const e = coded("EACCES");
    expect(unwrapSuppressed(e)).toEqual([e]);
  });

  it("puts the ORIGINAL failure before the disposal failure", () => {
    const original = coded("EROFS");
    const disposal = coded("EBADF");
    expect(unwrapSuppressed(suppressed(original, disposal))).toEqual([
      original,
      disposal,
      expect.any(Error),
    ]);
  });

  it("flattens nesting without running away", () => {
    const inner = coded("EACCES");
    const nested = suppressed(suppressed(inner, coded("EBADF")), coded("EBADF"));
    expect(unwrapSuppressed(nested)).toContain(inner);
  });
});

describe("describeStoreFailure", () => {
  it("names the underlying cause instead of the useless SuppressedError message", () => {
    // The whole point: "An error was suppressed during disposal." tells the user
    // (and the next debugging session) nothing at all.
    const msg = describeStoreFailure(suppressed(coded("EROFS"), coded("EBADF")));
    expect(msg).toContain("EROFS");
    expect(msg).not.toContain("suppressed during disposal");
  });

  it("still reports a plain error's code", () => {
    expect(describeStoreFailure(coded("forbidden"))).toContain("forbidden");
  });

  it("keeps the friendly signed-out wording, even when wrapped", () => {
    expect(describeStoreFailure(suppressed(coded("auth-required"), coded("EBADF")))).toMatch(
      /^Sign in to keep your conversations/,
    );
  });

  it("appends the caller's consequence clause", () => {
    const msg = describeStoreFailure(coded("EACCES"), ", so each message is sent without the earlier ones");
    expect(msg).toBe(
      "Conversations can't be saved (EACCES), so each message is sent without the earlier ones.",
    );
  });

  it("falls back to the message when there is no code", () => {
    expect(describeStoreFailure(new Error("mount gone"))).toContain("mount gone");
  });
});
