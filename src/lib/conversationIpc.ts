// The IPC contract between the conversation list (panel.agent) and the conversation
// stage (stage.conversation) — agent-conversations plan, Phases 04/05. The host
// authorizes the two-sided edge (registry §5.6); these are just the payload shapes.
// Only an id ever crosses: both regions are the same app (same appKey → same
// openSettings() mount), so the store is the shared source of truth — never the
// transcript bytes.

export const PANEL_REGION = 'panel.agent';
export const STAGE_REGION = 'stage.conversation';

/** panel → stage: "show this conversation in the stage". */
export interface SelectConversationMsg {
  type: 'select-conversation';
  id: string;
}

/** stage → panel: "this conversation changed; re-list" (e.g. a new title). */
export interface ConversationUpdatedMsg {
  type: 'conversation-updated';
  id: string;
}

export type ConversationIpcMsg = SelectConversationMsg | ConversationUpdatedMsg;

export const isSelect = (m: unknown): m is SelectConversationMsg =>
  (m as { type?: string })?.type === 'select-conversation' && typeof (m as SelectConversationMsg).id === 'string';

export const isUpdated = (m: unknown): m is ConversationUpdatedMsg =>
  (m as { type?: string })?.type === 'conversation-updated' && typeof (m as ConversationUpdatedMsg).id === 'string';
