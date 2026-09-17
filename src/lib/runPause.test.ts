import { describe, it, expect, vi } from 'vitest';

// The join's SDK seams, faked through the barrel (same reason as
// agentLoop.test.ts: mocking keeps vitest from loading the full SDK), with the
// host's visibility push scriptable per case. The immediate-fire-on-subscribe
// behaviour of the real `onRegionVisibilityChange` is reproduced so the
// subscription contract is exercised, not just the routing.
const h = vi.hoisted(() => {
  const state = { hidden: false };
  const listeners = new Set<(hidden: boolean) => void>();
  return {
    state,
    listeners,
    /** The host pushes a visibility change to every subscriber. */
    push(hidden: boolean): void {
      state.hidden = hidden;
      for (const l of [...listeners]) l(hidden);
    },
  };
});
vi.mock('@immediately-run/sdk', () => ({
  PauseController: class {
    paused = false;
    set(paused: boolean): void {
      this.paused = paused;
    }
    isPaused(): boolean {
      return this.paused;
    }
    whenResumed(): Promise<void> {
      return Promise.resolve();
    }
  },
  isRegionHidden: () => h.state.hidden,
  onRegionVisibilityChange: (listener: (hidden: boolean) => void): (() => void) => {
    h.listeners.add(listener);
    listener(h.state.hidden); // the real channel fires immediately with the current value
    return () => h.listeners.delete(listener);
  },
}));

import { createRunPause } from './runPause';

describe('createRunPause — the hide→pause join (R3-562 §7 R-ARD-20a)', () => {
  it('seeds from the visibility at kickoff: a run started hidden begins paused (R-ARD-15)', () => {
    h.state.hidden = true;
    const { pause, dispose } = createRunPause();
    expect(pause.isPaused()).toBe(true);
    dispose();
    h.state.hidden = false;
  });

  it('routes the host push: hidden pauses the in-flight run, the reveal continues it', () => {
    h.state.hidden = false;
    const { pause, dispose } = createRunPause();
    expect(pause.isPaused()).toBe(false);
    h.push(true); // the rail switches away — region kept mounted, merely hidden
    expect(pause.isPaused()).toBe(true);
    h.push(false); // the reveal
    expect(pause.isPaused()).toBe(false);
    dispose();
  });

  it('dispose stops the routing: a push after the run ended cannot pause a dead controller', () => {
    h.state.hidden = false;
    const { pause, dispose } = createRunPause();
    dispose(); // the run's finally
    h.push(true);
    expect(pause.isPaused()).toBe(false);
  });
});
