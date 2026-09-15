// Conversation data model (agent-conversations plan, Phase 01). A conversation is
// a durable, listable record of one agent session: a transcript plus metadata. It
// is persisted one-JSON-file-per-conversation by `conversationStore.ts` under the
// app's `openSettings()` mount, so it survives reloads and can be listed/opened.
//
// Types only — no runtime export — so this file never trips the Fast-Refresh
// "components-only" lint and can be imported anywhere.

import type { ChatMessage, RunState } from './agentLoop';

/** The current stored-record schema version. Bump + migrate on a shape change. */
export type ConversationSchema = 1;

/** List-row projection — cheap to render; carries no transcript. */
export interface ConversationMeta {
  /** `crypto.randomUUID()`. */
  id: string;
  /** "New conversation" until the first user prompt names it (see `deriveTitle`). */
  title: string;
  /** `Date.now()` at creation. */
  createdAt: number;
  /** `Date.now()`, bumped on every save. Drives newest-first ordering. */
  updatedAt: number;
  /**
   * The repository this conversation is about (R3-475) — the conferred worktree
   * mount's label, `owner/repo`. The panel scopes its list on it so different
   * repos' conversations never mix. Additive-optional (schema stays 1): a legacy
   * record has none, rides along unscoped, and is stamped on its next save from
   * a connected workspace.
   */
  repo?: string;
}

/** The full stored record (one JSON file per conversation). */
export interface Conversation extends ConversationMeta {
  schema: ConversationSchema;
  /** The loop transcript so far (user/assistant turns + tool results). */
  messages: ChatMessage[];
  /** Which mount this conversation edits, if pinned (optional in v1). */
  workspaceMountId?: string;
  /**
   * R3-559 — the fold watermark: the highest journal `seq` the record's
   * `messages` already contains. Replay skips entries at/below it, which is what
   * makes replay idempotent and a re-delivered entry harmless (R-ARD-5).
   * Additive-optional: a legacy record has none and replays from the whole journal.
   */
  foldedSeq?: number;
  /**
   * R3-559 — the loop's carried accounting at the last fold (R-ARD-7b). A resume
   * driven from the folded record alone continues the spend bound rather than
   * restarting it (G-ARD-16's second-device view). Absent on legacy records.
   */
  runState?: RunState;
}
