// The "follow the stream" decision (agent-conversations plan / R3-615). Pure: it answers
// "is the reader at the bottom, and should they keep following" from scroll geometry, so
// agent-demo's vitest (node environment, no DOM) can test it — a component cannot be.

export type FollowState = "follow" | "released";

export interface ScrollGeometry {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** How close to the bottom still counts as "at the bottom" (px). The hook and the
 *  tests both read it from here rather than retyping the number. */
export const STICK_TO_BOTTOM_SLACK_PX = 24;

/** True when the reader is within `slackPx` of the bottom (or past it — a shrunken
 *  scroll box reads as at-the-bottom). */
export function atBottom(g: ScrollGeometry, slackPx: number): boolean {
  return g.scrollHeight - g.scrollTop - g.clientHeight <= slackPx;
}

/** The next follow state for a scroll observation: at the bottom → follow, above it →
 *  released. The follow/released answer is the geometry's alone — whether the reader
 *  scrolled up or held still while content grew below them — so `previous` does not
 *  change it; the *hook* reads its own state to know whether to re-pin on a content
 *  change (that is the "follow survives content growth" half, and it is not this call).
 *  `previous` stays in the signature so the whole state machine is reviewed in one place.
 */
export function nextFollowState(
  _previous: FollowState,
  g: ScrollGeometry,
  slackPx: number,
): FollowState {
  return atBottom(g, slackPx) ? "follow" : "released";
}
