import { describe, it, expect } from "vitest";
import { describeStoreFailure, unwrapSuppressed, leaseFailure, leaseFailureText, leaseHeldText } from "./storeError";

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

// ── R3-561: the lease failure mapping ────────────────────────────────────────
//
// This exists because the discrimination was first pasted into two component
// catches and the third was missed. A test here is the other half of moving it:
// the copy is now checkable, which it was not in a `.tsx` (this repo has no
// component-test harness at all).

describe("leaseFailure / leaseFailureText / leaseHeldText (R3-561)", () => {
  it("recognises exactly the two lease codes and nothing else", () => {
    expect(leaseFailure({ code: "lease-lost" })).toBe("lease-lost");
    expect(leaseFailure({ code: "conversation-removed" })).toBe("conversation-removed");
    for (const other of [
      { code: "journal-unavailable" },
      { code: "journal-timeout" },
      { code: "ENOENT" },
      { code: "" },
      new Error("this frame does not hold the run lease"),
      null,
      undefined,
      "lease-lost", // the string, not an error carrying the code
    ]) {
      expect(leaseFailure(other)).toBeNull();
    }
  });

  it("never returns the internal message — the codes are UX states, not text to print", () => {
    // The regression this guards: both outcomes used to reach the user as the
    // literal "this frame does not hold the run lease".
    for (const failure of ["lease-lost", "conversation-removed"] as const) {
      for (const canTakeOver of [true, false]) {
        const text = leaseFailureText(failure, canTakeOver);
        expect(text).not.toMatch(/lease/i);
        expect(text.length).toBeGreaterThan(40);
      }
    }
  });

  it("offers a takeover only where there is one, and otherwise names what actually frees it", () => {
    // R-ARD-18a forbids a dead end. A surface with no affordance row must not name
    // a button it does not ship — it names the TTL, which is true and actionable.
    expect(leaseFailureText("lease-lost", true)).toMatch(/take it back below/);
    expect(leaseFailureText("lease-lost", false)).not.toMatch(/below/);
    expect(leaseFailureText("lease-lost", false)).toMatch(/frees up on its own/);

    expect(leaseHeldText(true)).toMatch(/take over/i);
    expect(leaseHeldText(false)).not.toMatch(/take over/i);
    expect(leaseHeldText(false)).toMatch(/frees up on its own/);
  });

  it("says the same thing about a deleted conversation either way — there is nothing to take over", () => {
    expect(leaseFailureText("conversation-removed", true)).toBe(leaseFailureText("conversation-removed", false));
    expect(leaseFailureText("conversation-removed", true)).toMatch(/deleted/);
  });
});
