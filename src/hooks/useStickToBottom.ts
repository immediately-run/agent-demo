import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  nextFollowState,
  STICK_TO_BOTTOM_SLACK_PX,
  type FollowState,
} from "../lib/stickToBottom";

/**
 * Keep a scroller pinned to its bottom while `value` streams in, and stop the moment the
 * reader scrolls up — resuming only when they return. The DOM wiring for
 * `src/lib/stickToBottom.ts`: on each `value` change it pins a following reader to the
 * new bottom and (re)attaches the scroll listener that flips follow ↔ released. A
 * released reader is never yanked down by new content — that is the "released survives
 * content growth" half, and it is why the pin is gated on the state, not on `value`.
 */
export function useStickToBottom(
  scrollerRef: RefObject<HTMLElement | null>,
  value: unknown,
): void {
  const stateRef = useRef<FollowState>("follow");
  const elementRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = scrollerRef.current;

    // A new scroller element starts following again — the reasoning box remounts for
    // each fresh block, and a release from a previous box must not leak into this one.
    if (el !== elementRef.current) {
      elementRef.current = el;
      stateRef.current = "follow";
    }
    if (!el) return;

    // Follow new content: a following reader is carried to the new bottom.
    if (stateRef.current === "follow") {
      el.scrollTop = el.scrollHeight;
    }

    // Release on scroll-up, resume on return-to-bottom.
    const onScroll = () => {
      stateRef.current = nextFollowState(
        stateRef.current,
        {
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
        },
        STICK_TO_BOTTOM_SLACK_PX,
      );
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [value, scrollerRef]);
}
