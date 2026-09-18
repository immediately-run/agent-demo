// R3-561 / R-ARD-18 — "the lease is refreshed on an interval WHILE THE RUN
// EXECUTES". This is that interval, extracted rather than lived in one component.
//
// WHY A HOOK AND NOT A `useEffect` IN THE STAGE. There are TWO run surfaces —
// `ConversationStage` and `CodingAgent` — and both acquire the lease, append every
// boundary and release at the end. The first version put the interval in the stage
// only, and the review gate's answer was the right one: nothing about the argument
// for it is specific to that component. `CodingAgent` adopts the NEWEST
// conversation at mount, which is the one the stage is most likely driving, so it
// is if anything the surface where a second frame is most reachable.
//
// WHY AN INTERVAL AT ALL, when `append` already refreshes. Because `append` only
// runs at a loop boundary, and the loop reaches a boundary only after the model
// turn returns. One long turn outlasts `LEASE_TTL_MS`, the running frame's own
// lease expires under it, and a second frame reads `free` — the double-drive the
// lease exists to prevent, arriving through the mechanism meant to prevent it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not surface the loss. An earlier
// version set a "held" banner from here and claimed to "raise the offer
// immediately"; it could not, because the banner renders only when the run is NOT
// running and this timer exists only while it is. The honest stopping point for a
// lost lease is the next `append`, which rejects with a typed code its caller's
// catch renders. So this loop refreshes, and stops once there is nothing left to
// refresh — no second opinion about the UI.
import { useEffect, type RefObject } from 'react';
import { LEASE_HEARTBEAT_MS } from '../lib/lease';

/** The one method this needs, so a caller can pass a store or a stub. */
export interface LeaseRefreshTarget {
  holdsRun(convId: string): Promise<boolean>;
}

/**
 * While `running`, refresh the run's lease every `LEASE_HEARTBEAT_MS`.
 *
 * There is no `onLost` callback, deliberately. An earlier version had one and
 * nothing passed it — and a callback is exactly the seam a later surface would
 * reach for to put a banner back here, which is the opinion the header above says
 * this loop does not get to have. Losing the lease stops the loop and nothing
 * else; the append that follows carries the typed code its caller renders.
 *
 * A refresh that THROWS is not a loss either: the mount could not answer, which is
 * no evidence either way. `checkHold` takes the same position, bounded by the
 * lease's own expiry.
 */
export function useLeaseRefresh(
  /** The store, by REF. Both callers hold theirs in one, and
   *  `eslint-plugin-react-hooks` v7 makes reading `.current` during render a hard
   *  error — so the ref crosses the boundary and the effect dereferences it. */
  storeRef: RefObject<LeaseRefreshTarget | null>,
  /** The conversation this run holds, by ref for the same reason. Read at each
   *  TICK rather than captured once, so a run that changes conversation under the
   *  hook refreshes the right lease instead of a stale one. */
  convIdRef: RefObject<string | null>,
  running: boolean,
): void {
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      const store = storeRef.current;
      const convId = convIdRef.current;
      if (!store || !convId) return; // nothing to refresh yet; try again next tick
      void store
        .holdsRun(convId)
        .then((still) => {
          if (!live || still) return;
          live = false; // nothing left to refresh — stop asking
          clearInterval(timer);
        })
        .catch(() => {
          /* a refresh that cannot run is not a loss — the TTL decides */
        });
    }, LEASE_HEARTBEAT_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // The refs are stable, so `running` is the whole dependency set — and it has to
    // stay that way: a value dependency that changed per render would tear down and
    // re-arm the interval each time, which is how a heartbeat silently never fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
}
