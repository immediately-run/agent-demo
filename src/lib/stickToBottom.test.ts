import { describe, it, expect } from "vitest";

import {
  atBottom,
  nextFollowState,
  STICK_TO_BOTTOM_SLACK_PX,
  type ScrollGeometry,
} from "./stickToBottom";

const SLACK = STICK_TO_BOTTOM_SLACK_PX;

/** A scroll box 1000px tall of content in a 400px viewport. `top` is `scrollTop`. */
const geo = (top: number, scrollHeight = 1000, clientHeight = 400): ScrollGeometry => ({
  scrollTop: top,
  clientHeight,
  scrollHeight,
});

describe("atBottom", () => {
  it("is true at the exact slack boundary", () => {
    // distance = scrollHeight - scrollTop - clientHeight = SLACK exactly.
    expect(atBottom(geo(1000 - 400 - SLACK), SLACK)).toBe(true);
  });

  it("is false one pixel past the slack boundary", () => {
    expect(atBottom(geo(1000 - 400 - SLACK - 1), SLACK)).toBe(false);
  });

  it("is false far above the bottom", () => {
    expect(atBottom(geo(0), SLACK)).toBe(false);
  });

  it("is true past the bottom (a shrunken scroll box)", () => {
    expect(atBottom(geo(1000, 600, 400), SLACK)).toBe(true);
  });
});

describe("nextFollowState", () => {
  it("releases a following reader who scrolls up", () => {
    expect(nextFollowState("follow", geo(0), SLACK)).toBe("released");
  });

  it("re-follows a released reader who returns to the bottom", () => {
    expect(nextFollowState("released", geo(600), SLACK)).toBe("follow");
  });

  it("keeps a follower following while content grows beneath them (still at the bottom after re-pin)", () => {
    // Content grew: 1000 → 2000. The follower is re-pinned to the new bottom.
    expect(nextFollowState("follow", geo(2000 - 400, 2000), SLACK)).toBe("follow");
  });

  it("keeps a released reader released through content growth", () => {
    // Content grew below them, but the released reader hasn't moved.
    expect(nextFollowState("released", geo(100), SLACK)).toBe("released");
  });

  it("walks the sequence: stream → scroll up → stream → return", () => {
    const states: string[] = [];
    // stream (grew, pinned to bottom)
    states.push(nextFollowState("follow", geo(600), SLACK)); // follow
    // reader scrolls up mid-turn
    states.push(nextFollowState("follow", geo(100), SLACK)); // released
    // stream continues beneath them
    states.push(nextFollowState("released", geo(100), SLACK)); // released
    // reader returns to the bottom
    states.push(nextFollowState("released", geo(600), SLACK)); // follow

    expect(states).toEqual(["follow", "released", "released", "follow"]);
  });
});
