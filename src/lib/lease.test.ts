// R3-561 — the advisory run lease, decided purely (AGENT_RUN_DURABILITY_SPEC §6).
//
// The clock is injected everywhere and there are no timers: every case below is a
// statement about the decision, not about scheduling. The case that matters most is
// same-tab reclaim, which R-ARD-18a calls mandatory rather than an optimization —
// no unload handler can be relied on, so EVERY teardown leaves a live-looking lease
// with nothing to release it.

import { describe, it, expect } from 'vitest';
import {
  LEASE_TTL_MS,
  LEASE_HEARTBEAT_MS,
  isExpired,
  leaseVerdict,
  mayTakeOver,
  mintLease,
  nextHeartbeat,
  parseLease,
  stillHeld,
  type Lease,
} from './lease';

const T0 = 1_700_000_000_000;
const OURS = 'tab-a';
const THEIRS = 'tab-b';

const lease = (over: Partial<Lease> = {}): Lease => ({
  holderId: 'run-1',
  tabId: THEIRS,
  expiresAt: T0 + LEASE_TTL_MS,
  ...over,
});

describe('isExpired', () => {
  it('is live before its TTL and expired at it', () => {
    const l = lease();
    expect(isExpired(l, T0)).toBe(false);
    expect(isExpired(l, l.expiresAt - 1)).toBe(false);
    // The boundary is inclusive: at expiresAt the lease is gone, not still held.
    expect(isExpired(l, l.expiresAt)).toBe(true);
  });

  it('treats an absent or malformed lease as expired — the mechanism is advisory, so it fails toward letting the user work', () => {
    expect(isExpired(null, T0)).toBe(true);
    expect(isExpired(undefined, T0)).toBe(true);
    expect(isExpired({ holderId: 'h', tabId: THEIRS, expiresAt: NaN }, T0)).toBe(true);
    expect(isExpired({ holderId: 'h', tabId: THEIRS, expiresAt: Infinity }, T0)).toBe(true);
    expect(isExpired({ holderId: 'h', tabId: THEIRS } as unknown as Lease, T0)).toBe(true);
  });
});

describe('mayTakeOver', () => {
  it('takes a stale lease from another tab', () => {
    expect(mayTakeOver(lease(), OURS, T0 + LEASE_TTL_MS)).toBe(true);
  });

  it('refuses a live lease held by another tab', () => {
    expect(mayTakeOver(lease(), OURS, T0)).toBe(false);
  });

  it('reclaims our own tab immediately, however live the lease looks', () => {
    // The canonical flow: rail-switch teardown, come back, resume. No unload
    // handler ran, so the lease is still minutes from expiry — and it is ours.
    const fresh = lease({ tabId: OURS, expiresAt: T0 + LEASE_TTL_MS });
    expect(isExpired(fresh, T0)).toBe(false); // live by the clock…
    expect(mayTakeOver(fresh, OURS, T0)).toBe(true); // …and still reclaimable.
  });

  it('reclaims our own tab even across a new run id — tabId is what reclaim keys on', () => {
    expect(mayTakeOver(lease({ holderId: 'some-older-run', tabId: OURS }), OURS, T0)).toBe(true);
  });

  it('takes an absent lease', () => {
    expect(mayTakeOver(null, OURS, T0)).toBe(true);
  });
});

describe('leaseVerdict', () => {
  it('is free when takeable and held only against a live foreign lease', () => {
    expect(leaseVerdict(null, OURS, T0)).toBe('free');
    expect(leaseVerdict(lease({ tabId: OURS }), OURS, T0)).toBe('free');
    expect(leaseVerdict(lease(), OURS, T0 + LEASE_TTL_MS)).toBe('free');
    expect(leaseVerdict(lease(), OURS, T0)).toBe('held');
  });

  it('never yields a third state — held is an offer to take over, not a block', () => {
    // Guards the UI contract in R-ARD-18a: there is no verdict that means "you
    // cannot proceed", because a hard block on an advisory lease is a dead end.
    const verdicts = new Set([
      leaseVerdict(null, OURS, T0),
      leaseVerdict(lease(), OURS, T0),
      leaseVerdict(lease({ tabId: OURS }), OURS, T0),
    ]);
    expect([...verdicts].sort()).toEqual(['free', 'held']);
  });
});

describe('mintLease / nextHeartbeat', () => {
  it('mints one TTL out', () => {
    expect(mintLease('run-9', OURS, T0)).toEqual({ holderId: 'run-9', tabId: OURS, expiresAt: T0 + LEASE_TTL_MS });
  });

  it('pushes expiry forward without changing identity', () => {
    const held = mintLease('run-9', OURS, T0);
    const beat = nextHeartbeat(held, T0 + LEASE_HEARTBEAT_MS);
    expect(beat.holderId).toBe(held.holderId);
    expect(beat.tabId).toBe(held.tabId);
    expect(beat.expiresAt).toBe(T0 + LEASE_HEARTBEAT_MS + LEASE_TTL_MS);
    // A refresh that minted a new holderId would make the holder's own next read
    // look like someone else's lease — the bug this assertion exists to catch.
    expect(stillHeld(beat, held.holderId)).toBe(true);
  });

  it('leaves room for two consecutively missed beats — STRICTLY, not exactly', () => {
    // The inequality, not the numbers: at exactly 3x, the tick after two missed
    // ones lands ON `expiresAt`, and `isExpired` is `now >= expiresAt`, so the
    // lease is already gone at the instant it would have been refreshed. This
    // asserts the property so the constants cannot drift back onto the edge.
    expect(LEASE_HEARTBEAT_MS * 3).toBeLessThan(LEASE_TTL_MS);

    // Driven through the real functions rather than by arithmetic alone.
    const held = mintLease('run-9', OURS, T0);
    const thirdTick = T0 + LEASE_HEARTBEAT_MS * 3;
    expect(isExpired(held, thirdTick)).toBe(false);
  });
});

describe('stillHeld', () => {
  it('is true only for the lease we minted', () => {
    const ours = mintLease('run-9', OURS, T0);
    expect(stillHeld(ours, 'run-9')).toBe(true);
    expect(stillHeld(ours, 'run-10')).toBe(false);
    expect(stillHeld(null, 'run-9')).toBe(false);
  });

  it('is false after another frame takes over, even from the same tab', () => {
    // Same tab, new run: the previous run must observe that it no longer holds it
    // rather than overwriting the newer holder.
    const taken = mintLease('run-10', OURS, T0 + LEASE_TTL_MS);
    expect(stillHeld(taken, 'run-9')).toBe(false);
  });
});

describe('parseLease', () => {
  it('round-trips a minted lease', () => {
    const l = mintLease('run-9', OURS, T0);
    expect(parseLease(JSON.stringify(l))).toEqual(l);
  });

  it('reads anything malformed as absent', () => {
    for (const raw of [
      '',
      'not json',
      'null',
      '[]',
      '"a string"',
      '{}',
      '{"holderId":"h","tabId":"t"}',
      '{"holderId":"","tabId":"t","expiresAt":1}',
      '{"holderId":"h","tabId":"","expiresAt":1}',
      '{"holderId":"h","tabId":"t","expiresAt":"1"}',
      '{"holderId":1,"tabId":"t","expiresAt":1}',
    ]) {
      expect(parseLease(raw), raw).toBeNull();
    }
  });

  it('drops unknown fields rather than carrying them forward', () => {
    const parsed = parseLease('{"holderId":"h","tabId":"t","expiresAt":5,"pid":"something"}');
    expect(parsed).toEqual({ holderId: 'h', tabId: 't', expiresAt: 5 });
  });
});
