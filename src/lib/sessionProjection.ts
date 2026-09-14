// The agent session projection (CONTRIBUTE_TRANSCRIPT_SPEC §3 R-CT-1; roadmap R3-631).
// A single small JSON doc — session-projection.json — in the app's `openSettings()`
// mount, maintained by the conversation stage so the HOST can learn "is there an
// open agent session for this repo" with no new wire scheme (the
// `@immediately-run/sandbox-protocol` contract is a published package; a new scheme
// needs a descriptor publish — see the spec §3 mechanism resolution, 2026-09-14).
// The host reads the doc from the settings backend it fronts and applies its own
// heartbeat TTL; a stale or missing doc reads as NO active session (fail-closed).
//
// Gate facts only (R-CT-1): repo, conversationId, messageCount, running,
// heartbeatAt. No transcript bytes ever cross here — the conversation record stays
// in the conversations/ store, which the host can also read host-side at opt-in
// time (spec R-CT-4: the projection is display input, not authority).
import fs from 'fs';
import { openSettings } from '@immediately-run/sdk';
import type { StoreFs } from './conversationStore';
import type { Conversation } from './conversationModel';

/** Where the doc lives: the settings mount root, beside (not inside) `conversations/`. */
export const SESSION_PROJECTION_PATH = 'session-projection.json';

/** The doc the host reads. `active: false` is the explicit "no session" — a missing
 *  doc reads the same way host-side, so both absence shapes fail closed. */
export interface SessionProjectionDoc {
  schema: 1;
  active: boolean;
  /** `owner/repo` — present only when active. An unstamped conversation NEVER
   *  projects active (R-CT-2(a)); `conversationScope.ts`'s legacy rule that an
   *  undefined repo matches every repo is deliberately not reused here. */
  repo?: string;
  conversationId?: string;
  /** 0 when inactive. */
  messageCount: number;
  /** The conversation record's own `updatedAt` — the save-time fact the spec's
   *  R-CT-1 enumerates. Distinct from `heartbeatAt`: a save bumps both, a
   *  close/unmount bumps only the heartbeat. */
  updatedAt?: number;
  running: boolean;
  /** ms since epoch, bumped on EVERY publish (including inactive ones). The
   *  HOST's TTL over this field is the staleness bound — the writer never
   *  decides freshness. */
  heartbeatAt: number;
}

/** The inactive doc: close, unmount, unstamped, and empty all collapse to this. */
export const inactiveProjection = (now: number): SessionProjectionDoc => ({
  schema: 1,
  active: false,
  messageCount: 0,
  running: false,
  heartbeatAt: now,
});

/**
 * Pure derivation (R-CT-1/R-CT-2). `null` conversation, an UNSTAMPED conversation
 * (`repo === undefined`), or an empty transcript all project inactive — the host
 * must never offer a transcript for a session it cannot scope or has nothing to
 * show for. Everything else projects the gate facts with a fresh heartbeat.
 */
export function deriveSessionProjection(
  conv: Conversation | null,
  running: boolean,
  now: number,
): SessionProjectionDoc {
  if (!conv || conv.repo === undefined || conv.messages.length === 0) return inactiveProjection(now);
  return {
    schema: 1,
    active: true,
    repo: conv.repo,
    conversationId: conv.id,
    messageCount: conv.messages.length,
    updatedAt: conv.updatedAt,
    running,
    heartbeatAt: now,
  };
}

/**
 * The stage-side trigger semantics (R3-631), extracted from the component for the
 * same reason `stageSelection.ts` was: vitest runs in node with no DOM, so the
 * naming of WHEN a heartbeat fires is testable only out here. The component owns
 * the state; this owns the moments.
 */
export interface ProjectionPublisher {
  /** A conversation became the shown one (selection, adopt, newest-fallback).
   *  Running is true only if the in-flight run belongs to THIS conversation. */
  onShow(): void;
  /** A run started for the conversation with this id. */
  onRunStart(convId: string | null): void;
  /** The post-turn save landed — the natural heartbeat. */
  onSaved(): void;
  /** The run's finally — the running flag clears. */
  onRunEnd(): void;
  /** The stage unmounts — explicit inactive doc, best effort (the host's TTL
   *  backstops a write that loses the teardown race). */
  onUnmount(): void;
}

/**
 * Build the publisher over ref-style accessors. `writer` returning null/undefined
 * (not opened yet, or open failed) makes every trigger a no-op — fail-closed
 * silence, not an error surface: the host simply never sees a heartbeat.
 */
export function createProjectionPublisher(
  writer: () => SessionProjectionWriter | null | undefined,
  state: () => { conv: Conversation | null; runningId: string | null },
): ProjectionPublisher {
  const beat = (running: (conv: Conversation) => boolean) => {
    const w = writer();
    if (!w) return;
    const { conv } = state();
    void w.publish(conv, conv !== null && running(conv));
  };
  return {
    onShow: () => beat((c) => state().runningId === c.id),
    onRunStart: (convId) => beat((c) => c.id === convId),
    onSaved: () => beat(() => false),
    onRunEnd: () => beat(() => false),
    onUnmount: () => {
      void writer()?.publish(null, false);
    },
  };
}

export interface SessionProjectionWriter {
  /** Best-effort publish. A failed write costs one heartbeat — the host's TTL
   *  expires the projection and the feature is absent, which is the safe
   *  direction. Never throws into the conversation flow. */
  publish(conv: Conversation | null, running: boolean): Promise<void>;
}

/** Writer over an explicit fs + root (tests inject a fake); production uses
 *  {@link openSessionProjectionWriter}. */
export function createSessionProjectionWriter(opts: {
  root: string;
  fs: Pick<StoreFs, 'writeFile'>;
}): SessionProjectionWriter {
  const path = `${opts.root.replace(/\/+$/, '')}/${SESSION_PROJECTION_PATH}`;
  return {
    async publish(conv, running) {
      const doc = deriveSessionProjection(conv, running, Date.now());
      try {
        await opts.fs.writeFile(path, JSON.stringify(doc));
      } catch (e) {
        // Fail-closed for the FEATURE, not the app: a missed heartbeat expires the
        // projection host-side. Logged-and-dropped (implementation standards R3) —
        // a persistent fault must be visible somewhere, just never on the chat
        // surface.
        console.warn(`session projection write failed at ${path} (the host TTL will expire it)`, e);
      }
    },
  };
}

/**
 * Production factory: the app's settings mount — the SAME mount
 * `openConversationStore` builds on, so host-side reads see one tree. Throws if
 * `openSettings()` is unavailable exactly like the store does; the stage degrades
 * to no projection (⇒ the host never offers ⇒ fail-closed).
 */
export async function openSessionProjectionWriter(): Promise<SessionProjectionWriter> {
  const mount = await openSettings();
  return createSessionProjectionWriter({ root: mount.path, fs: fs.promises as unknown as StoreFs });
}
