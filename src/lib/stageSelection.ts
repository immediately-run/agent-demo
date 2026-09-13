// The stage-selection arbiter (agent-conversations plan 05 / R3-594). Pure: it orders
// the three ways a conversation can become current — an explicit panel selection (which
// may arrive before the store opens), the newest-in-scope fallback, and `run()`'s freshly
// created conversation — so the latest request wins no matter what order their loads
// settle. Extracted out of `ConversationStage` because agent-demo's vitest runs in node
// with no DOM, so logic left in a component cannot be tested.

import type { Conversation } from './conversationModel';
import type { ConversationStore } from './conversationStore';
import { scopeConversations } from './conversationScope';

/** The outcome of a `select` / `storeOpened` load. */
export type StageSelectionResult = 'shown' | 'missing' | 'superseded';

export interface StageSelection {
  /** Record an explicit selection, cancelling the fallback for good. Loads now if the
   * store is open, otherwise holds the id until `storeOpened` (whose call settles the
   * returned promise). */
  select(id: string): Promise<StageSelectionResult>;
  /** Record the store; load the held selection if there is one, else — if nothing has
   * been shown — the newest in scope. */
  storeOpened(store: ConversationStore, repo: string | undefined): Promise<StageSelectionResult>;
  /** Make `run()`'s newly created conversation current, so no in-flight load replaces it. */
  adopt(conv: Conversation): void;
}

export interface StageSelectionOptions {
  show: (conv: Conversation) => void;
  /** Whether a run is in flight for the given conversation. A re-select of the shown
   * conversation is a repair gesture (reload it) — unless a run is in flight for *that
   * same* conversation, in which case the tap is ignored so in-flight work is never
   * discarded. A run for a different conversation does not gate the reload. */
  isRunning: (id: string) => boolean;
}

/**
 * Build the arbiter over a single `show` callback and a `isRunning` probe.
 *
 * The latest-wins ticket works because every load captures its ticket when it is
 * initiated (`++latest`), and a load whose ticket is stale when its `store.load` settles
 * is discarded — without it, a fallback `list()`/`load()` that finishes after a `select`
 * would put the newest conversation back on screen.
 */
export function createStageSelection({ show, isRunning }: StageSelectionOptions): StageSelection {
  let store: ConversationStore | null = null;
  let held: string | null = null;
  let heldResolve: ((r: StageSelectionResult) => void) | null = null;
  let latest = 0;
  // Guards the fallback: once anything has been shown (select, fallback or adopt), the
  // store opening must not auto-show the newest over it.
  let shown = false;
  // The conversation the stage is showing, so a re-select of it can be told apart from a
  // select of a different one (re-tap reloads; a different id is an ordinary load).
  let currentId: string | null = null;

  const attempt = async (id: string, ticket: number): Promise<StageSelectionResult> => {
    const conv = store ? await store.load(id) : null;
    if (ticket !== latest) return 'superseded';
    if (!conv) return 'missing';
    show(conv);
    shown = true;
    currentId = id;
    return 'shown';
  };

  return {
    select(id) {
      // A new explicit selection supersedes a held one that never loaded.
      if (heldResolve) {
        heldResolve('superseded');
        heldResolve = null;
      }
      const ticket = ++latest;
      if (store) {
        // Re-tapping the conversation already shown is a repair gesture: reload it so the
        // stage re-reads the store and re-renders. But while a run is in flight for *that
        // same* conversation, a stray tap must not discard the live work — ignore it.
        if (id === currentId && isRunning(id)) {
          return Promise.resolve('shown');
        }
        return attempt(id, ticket);
      }
      held = id;
      return new Promise<StageSelectionResult>((resolve) => {
        heldResolve = resolve;
      });
    },

    async storeOpened(s, repo) {
      store = s;
      if (held) {
        const id = held;
        held = null;
        const ticket = ++latest;
        const result = await attempt(id, ticket);
        heldResolve?.(result);
        heldResolve = null;
        return result;
      }
      // Nothing selected and nothing shown: the plan-05 fallback.
      if (shown) return 'shown';
      const ticket = ++latest;
      const [newest] = scopeConversations(await store.list(), repo).mine;
      if (!newest) return 'missing';
      return attempt(newest.id, ticket);
    },

    adopt(conv) {
      if (heldResolve) {
        heldResolve('superseded');
        heldResolve = null;
      }
      held = null;
      latest++; // slice out any in-flight load's (late) result
      shown = true;
      currentId = conv.id;
      show(conv);
    },
  };
}
