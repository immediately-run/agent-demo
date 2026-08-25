// Steering + follow-up queue (R3-333 / AHG-T2-3).
//
// WHY. R3-224 resolved the hard half — `ChatRequest.signal`, per-message abort in
// the host that stops the upstream generator and the billing with it, and
// `runAgent(signal)` behind the stop button. What sits on top of it was never
// built: the human's vocabulary was still START and KILL. There was no way to say
// "yes, but not that file" or "stop and do this instead", or to queue a follow-up
// while a turn is in flight. Correction meant restart — which discards the
// transcript's accumulated understanding and pays for it again.
//
// This is the app-layer half: a queue the loop drains at a turn boundary, plus an
// INTERRUPT signal that aborts the in-flight model turn without ending the run.
//
// THE TWO VERBS ARE NOT THE SAME.
//   * STOP  — `RunAgentOptions.signal`. Ends the run. The transcript so far is kept.
//   * STEER — this controller. Ends the current TURN (or waits for the next
//             boundary), injects the user's correction, and CONTINUES.
// They are distinguishable in the transcript (`STEER_MARKER`) and in the UI, which
// exit criterion 3 requires.
//
// WHY A STEER NEVER INTERRUPTS TOOL EXECUTION. A turn's `tool_use` blocks must each
// get a matching `tool_result`, or the next request is malformed and the provider
// rejects the whole conversation. So the interrupt signal only ever aborts the
// in-flight MODEL call; a steer that arrives while tools are running is applied at
// the boundary after the batch completes. That is exit criterion 5, and it is a
// property of the design rather than a race the loop has to win.

/** How a steer applies. */
export type SteerMode =
  /** Apply at the next turn boundary — the in-flight turn finishes first. */
  | 'queue'
  /** Abort the in-flight model turn now, then apply. Never interrupts a tool call. */
  | 'interrupt';

export interface SteerMessage {
  id: string;
  text: string;
  mode: SteerMode;
}

/** Prefix marking a `user` message as a STEER rather than something typed at the
 *  start of a run — so a replayed conversation shows the interruption where it
 *  happened, instead of reconstructing a history that never ran (scope 5). Mirrors
 *  `COMPACTION_MARKER`/`NUDGE_TEXT`, which the transcript renderer already keys on. */
export const STEER_MARKER = '␟[steer]\n';
/** As above, for a steer that ABORTED an in-flight turn. */
export const STEER_INTERRUPT_MARKER = '␟[steer:interrupt]\n';

/** Text recorded in place of the assistant turn a steer cut short. The turn has to
 *  appear in the transcript — dropping it would put two `user` messages back to back
 *  and lose the fact that the model was mid-sentence when the user cut in. */
export const INTERRUPTED_TURN_TEXT = '(turn interrupted by the user)';

/** Wrap a steer's text for the wire. */
export const steerWireText = (m: SteerMessage): string =>
  (m.mode === 'interrupt' ? STEER_INTERRUPT_MARKER : STEER_MARKER) + m.text;

/** Recognise a steer on replay; returns the mode + text, or `null`. */
export function parseSteer(text: string): { mode: SteerMode; text: string } | null {
  if (text.startsWith(STEER_INTERRUPT_MARKER)) {
    return { mode: 'interrupt', text: text.slice(STEER_INTERRUPT_MARKER.length) };
  }
  if (text.startsWith(STEER_MARKER)) return { mode: 'queue', text: text.slice(STEER_MARKER.length) };
  return null;
}

/** What the loop needs from a steering source (so it can be faked in tests). */
export interface SteerSource {
  /** Remove and return everything pending, in arrival order. */
  drain(): SteerMessage[];
  /** Is anything waiting? Checked before the loop would otherwise END, so a
   *  follow-up queued against a finishing run continues it instead. */
  hasPending(): boolean;
  /** Fires when an `interrupt`-mode steer arrives. The loop composes it with the
   *  stop signal for the in-flight model call. */
  readonly interrupt: AbortSignal;
  /** Called by the loop once an interrupt has been consumed, so the next turn is
   *  not aborted by a stale signal. */
  rearm(): void;
}

let seq = 0;
const nextId = (): string => {
  // `crypto.randomUUID` is not available in every host the app runs in; the id only
  // has to be unique within one run, so a counter + timestamp is enough.
  seq += 1;
  return `steer-${Date.now().toString(36)}-${seq}`;
};

/**
 * The live steering queue. Owned by the UI (which enqueues and cancels) and read
 * by the loop (which drains at a turn boundary).
 */
export class SteerController implements SteerSource {
  private queue: SteerMessage[] = [];
  private controller = new AbortController();
  private listeners = new Set<(pending: readonly SteerMessage[]) => void>();

  /** Queue a correction. Returns its id so the UI can cancel it while it waits. */
  enqueue(text: string, mode: SteerMode = 'queue'): SteerMessage | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const msg: SteerMessage = { id: nextId(), text: trimmed, mode };
    this.queue.push(msg);
    if (mode === 'interrupt') this.controller.abort();
    this.emit();
    return msg;
  }

  /** Drop a queued steer that has not been applied yet. */
  cancel(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((m) => m.id !== id);
    if (this.queue.length === before) return false;
    // Cancelling the only interrupt leaves a fired signal behind; re-arm so the
    // next turn is not aborted by a correction the user took back.
    if (!this.queue.some((m) => m.mode === 'interrupt')) this.rearm();
    this.emit();
    return true;
  }

  /** Everything still waiting, for the UI's "queued" affordance. */
  pending(): readonly SteerMessage[] {
    return this.queue;
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  drain(): SteerMessage[] {
    const out = this.queue;
    this.queue = [];
    if (out.length) this.emit();
    return out;
  }

  get interrupt(): AbortSignal {
    return this.controller.signal;
  }

  rearm(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }

  /** Subscribe to queue changes (the UI re-renders its queued chips). */
  onChange(listener: (pending: readonly SteerMessage[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.queue);
  }
}

/**
 * Combine abort signals into one that fires when any of them does.
 *
 * `AbortSignal.any` exists in modern engines but not everywhere the sandbox runs,
 * and a silent `undefined` here would mean the stop button quietly stops working —
 * so this is explicit, and returns a disposer the caller uses to drop its listeners
 * (a per-turn signal that stayed subscribed to a run-long controller would leak one
 * listener per turn on a long run).
 */
export function anySignal(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const live = signals.filter((s): s is AbortSignal => !!s);
  const controller = new AbortController();
  const already = live.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbort = (e: Event): void => controller.abort((e.target as AbortSignal).reason);
  for (const s of live) s.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const s of live) s.removeEventListener('abort', onAbort);
    },
  };
}
