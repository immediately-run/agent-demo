// Narrow list updates for the conversation list (R3-612 / interaction standards
// R-IX-4): a `conversation-updated` message names ONE conversation, so the list
// patches that row from the message's own data instead of re-listing the store
// (a full `list()` is up to 500 JSON reads to learn one row's title moved).
//
// Pure rule — no store, no fs — so the ordering contract is testable against the
// real records the store returns (see conversationUpdate.test.ts).

import type { ConversationMeta } from "./conversationModel";

/**
 * Fold one conversation record into the list: replace the matching row and
 * re-order by `updatedAt` (newest first, the store's own `list()` order);
 * insert at the head when the row is absent (a conversation created in another
 * region); leave every other row's relative order alone.
 */
export function applyConversationUpdate(
  items: ConversationMeta[],
  next: ConversationMeta,
): ConversationMeta[] {
  const idx = items.findIndex((c) => c.id === next.id);
  if (idx === -1) return [next, ...items];
  const out = items.slice();
  out[idx] = next;
  // Stable in every runtime this ships on, so the untouched rows keep their
  // order and only the replaced row moves to its new `updatedAt` position.
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
