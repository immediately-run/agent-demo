// The advisory run lease (R3-561 / AGENT_RUN_DURABILITY_SPEC §6, R-ARD-18…19).
//
// WHY. Two frames can hold one conversation — two tabs, or a tab and a restored
// session — and both would resume, both would drive the same working tree, and
// both would allocate `seq`. There is a third writer already shipping: the
// conversation-list panel and the conversation stage are the SAME app on the same
// settings mount, and the panel calls `create` and `remove`. Deleting a
// conversation while its run is executing is the race that actually bites.
//
// WHAT THIS IS, EXACTLY. An **advisory** lease, and nothing stronger. It does not
// exclude: two frames can both believe they hold it — a suspended frame keeps a
// lease it is not using, and a TTL takeover can race a frame that resumes
// execution. What it buys is that the ordinary two-tab case does not double-drive
// a working tree. The spec's own honesty note (§6, rev 2) says so, and says why
// rev 1's claim of a conditional-write backstop was withdrawn:
//
//   * `rev` IS stamped at the store's one write chokepoint, but its only consumer
//     is host-internal (`currentRev: (path) => ffs.revisionOf(path)`);
//   * the SDK's file surface exposes no version — `FileStat` is `{kind, size,
//     mtimeMs?}` — and no conditional write;
//   * the agent's own port is narrower still, and its `writeFile` is unconditional
//     last-writer-wins.
//
// So there is no loser-detection to lean on. Nothing in this file, in the store, or
// in the UI may describe the mechanism as stronger than advisory — R3-561's exit
// criteria grep this file for the two phrases that would, which is why even the
// DENIALS above are worded around them. If a conditional write ever reaches the
// SDK's file surface, §6's Q7 is where the upgrade is argued and `mayTakeOver` is
// the seam it attaches to.
//
// WHY NOT THE WEB LOCKS API. Its locks are scoped per ORIGIN and this app's origin
// is opaque (a sandboxed iframe without `allow-same-origin`), so the obvious
// primitive silently does not work here. R-ARD-19 states it so it is not proposed
// again; the exit criteria grep for its global too, so it is named in prose only.
//
// WHY ITS OWN FILE, NEVER A FIELD ON THE RECORD. The record grows monotonically;
// refreshing a field on it means rewriting the whole record on every heartbeat,
// which is the O(n²) pattern the journal design spends a section rejecting.
//
// PURE. Clock injected, no timers, no fs — the store integration is the thin part.
// Same shape as `steering.ts`.

/** How long a lease stays live after its last refresh. The cost of expiring early
 *  is a spurious takeover offer; the cost of expiring late is only that a
 *  genuinely dead frame's lease lingers, and same-tab reclaim already covers the
 *  common teardown — so this is sized generously against the refresh cadence
 *  below rather than against any guess about how slow a frame might be. */
export const LEASE_TTL_MS = 60_000;

/**
 * Refresh cadence, and the TTL is STRICTLY MORE than three times it — so two
 * consecutively missed beats still leave the lease live, with the third tick
 * landing inside the window rather than exactly on its edge.
 *
 * The strictness is the whole point and it was wrong here for a round. At exactly
 * a third, a tick at `t` sets `expiresAt = t + TTL`; miss the next two and the
 * following tick lands at `t + 3×cadence` = `expiresAt`, and `isExpired` is
 * `now >= expiresAt` — already gone at the instant it would have refreshed. And
 * `setInterval` drift only ever pushes a tick LATER. So the margin was zero, not
 * two beats. `lease.test.ts` now asserts the inequality rather than trusting the
 * numbers.
 *
 * What this does NOT cover, said plainly because the old comment claimed it did:
 * a **hidden tab**. Chrome clamps timers in a page hidden more than five minutes
 * to roughly once per minute, which is at most one tick per TTL — no slack at
 * all. What actually keeps such a run's lease alive is the boundary appends,
 * every one of which refreshes through `checkHold`. The timer is for the case
 * boundaries cannot cover: one long model turn in a VISIBLE tab.
 */
export const LEASE_HEARTBEAT_MS = 15_000;

/** The lease file's contents — `{holderId, tabId, expiresAt}`, and nothing else.
 *  It lives beside the conversation, never on the record. */
export interface Lease {
  /** This RUN's identity: a fresh id per acquisition. Distinguishes two runs in
   *  one tab over time, which `tabId` alone cannot. */
  holderId: string;
  /** This FRAME's identity, stable for the life of the document. The field
   *  same-tab reclaim keys on (R-ARD-18a). */
  tabId: string;
  /** Wall-clock ms after which the lease is treated as expired. Absolute rather
   *  than a duration so a reader needs no knowledge of the writer's cadence. */
  expiresAt: number;
}

/** What a frame may do with a conversation it wants to run. */
export type LeaseVerdict =
  /** No live lease, or it is ours — go. */
  | 'free'
  /** Someone else's lease is still live. Renders as a takeover offer, never as a
   *  hard block: the lease is advisory, and a hard block on an advisory lease is a
   *  dead end the user cannot escape (R-ARD-18a). */
  | 'held';

/** Has this lease passed its TTL? A malformed or absent lease reads as expired —
 *  fail toward letting the user work, since the mechanism is advisory and the
 *  alternative is stranding them behind a lease nobody can release. */
export function isExpired(lease: Lease | null | undefined, now: number): boolean {
  if (!lease || typeof lease.expiresAt !== 'number' || !Number.isFinite(lease.expiresAt)) return true;
  return now >= lease.expiresAt;
}

/**
 * May `tabId` take the lease?
 *
 * Two ways yes, and the second is mandatory rather than an optimization
 * (R-ARD-18a): §0 establishes that no unload handler can be relied on, from which
 * it follows that EVERY teardown leaves a live-looking lease with nothing to
 * release it. Without same-tab reclaim the canonical flow — rail-switch teardown,
 * come back, resume — lands on `held` against a frame that no longer exists, and
 * the user is shown a message naming a window that is not there.
 *
 * So: a lease whose `tabId` is ours is reclaimed IMMEDIATELY, regardless of
 * expiry. Any other lease is available only once it has expired.
 */
export function mayTakeOver(lease: Lease | null | undefined, tabId: string, now: number): boolean {
  if (!lease) return true;
  if (lease.tabId === tabId) return true; // same-tab reclaim — expiry is irrelevant
  return isExpired(lease, now);
}

/** The verdict a frame should act on: `free` when it may run, `held` when another
 *  live frame holds it and the user is offered a takeover. */
export function leaseVerdict(lease: Lease | null | undefined, tabId: string, now: number): LeaseVerdict {
  return mayTakeOver(lease, tabId, now) ? 'free' : 'held';
}

/** A lease claimed now, expiring one TTL out. */
export function mintLease(holderId: string, tabId: string, now: number, ttlMs: number = LEASE_TTL_MS): Lease {
  return { holderId, tabId, expiresAt: now + ttlMs };
}

/** The same lease, pushed one TTL forward. A heartbeat never changes identity —
 *  a refresh that minted a new `holderId` would make the holder's own next read
 *  look like someone else's lease. */
export function nextHeartbeat(lease: Lease, now: number, ttlMs: number = LEASE_TTL_MS): Lease {
  return { ...lease, expiresAt: now + ttlMs };
}

/** Do we still hold this lease — i.e. is the stored lease the one we minted? Read
 *  at a turn boundary: a `false` means someone took over while we were working,
 *  and the honest response is to stop, not to overwrite them. */
export function stillHeld(lease: Lease | null | undefined, holderId: string): boolean {
  return !!lease && lease.holderId === holderId;
}

/** Parse a lease file's bytes. Anything that is not a well-formed lease reads as
 *  absent (→ expired → takeable), for the same fail-toward-working reason as
 *  `isExpired`. */
export function parseLease(raw: string): Lease | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const l = parsed as Partial<Lease> | null;
  if (!l || typeof l !== 'object') return null;
  if (typeof l.holderId !== 'string' || !l.holderId) return null;
  if (typeof l.tabId !== 'string' || !l.tabId) return null;
  if (typeof l.expiresAt !== 'number' || !Number.isFinite(l.expiresAt)) return null;
  return { holderId: l.holderId, tabId: l.tabId, expiresAt: l.expiresAt };
}
