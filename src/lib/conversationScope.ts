// Repository scoping for the conversation list (R3-475). Pure: the panel derives
// the current repo from its conferred worktree mount and partitions the store's
// metas here, so the rule is unit-testable without React or a host.

import type { ConversationMeta } from './conversationModel';

/** One "other repository" group: a repo with conversations outside the current scope. */
export interface RepoGroup {
  repo: string;
  count: number;
  /** Newest member's `updatedAt` — drives the group ordering. */
  updatedAt: number;
}

export interface ScopedConversations {
  /** The current repo's conversations, PLUS legacy unstamped ones — hiding those
   *  entirely would strand them; they ride along until a save stamps them. */
  mine: ConversationMeta[];
  /** Repos other than the current one that have conversations, newest first.
   *  Their members never appear in `mine` — the whole point of the scope. */
  others: RepoGroup[];
}

/**
 * Partition the metas for the panel. `currentRepo === undefined` means no
 * workspace is conferred (or it hasn't arrived yet): only unstamped
 * conversations are "mine" then, and every stamped repo groups under others.
 */
export function scopeConversations(
  items: readonly ConversationMeta[],
  currentRepo: string | undefined,
): ScopedConversations {
  const mine: ConversationMeta[] = [];
  const byRepo = new Map<string, RepoGroup>();
  for (const c of items) {
    if (!c.repo || c.repo === currentRepo) {
      mine.push(c);
      continue;
    }
    const g = byRepo.get(c.repo);
    if (g) {
      g.count += 1;
      g.updatedAt = Math.max(g.updatedAt, c.updatedAt);
    } else {
      byRepo.set(c.repo, { repo: c.repo, count: 1, updatedAt: c.updatedAt });
    }
  }
  return { mine, others: [...byRepo.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
}
