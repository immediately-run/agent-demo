// Conversation data model (agent-conversations plan, Phase 01). A conversation is
// a durable, listable record of one agent session: a transcript plus metadata. It
// is persisted one-JSON-file-per-conversation by `conversationStore.ts` under the
// app's `openSettings()` mount, so it survives reloads and can be listed/opened.
//
// Types only — no runtime export — so this file never trips the Fast-Refresh
// "components-only" lint and can be imported anywhere.

import type { ChatMessage } from './agentLoop';

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
}

/** The full stored record (one JSON file per conversation). */
export interface Conversation extends ConversationMeta {
  schema: ConversationSchema;
  /** The loop transcript so far (user/assistant turns + tool results). */
  messages: ChatMessage[];
  /** Which mount this conversation edits, if pinned (optional in v1). */
  workspaceMountId?: string;
}
