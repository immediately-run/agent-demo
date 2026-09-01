// The conversation LIST — the panel-slot half of the agents activity (plan Phase
// 04, region `panel.agent`). The analog of the file explorer: it lists the user's
// conversations and a "new" button, and on selection posts the conversation id to
// the stage over IPC. It runs no agent and holds no net:fetch — all model calls
// happen in the stage (ConversationStage).
//
// R3-475 — the list is SCOPED to the repository loaded in the workbench: the host
// confers the editor session's working tree on this panel too (`exposesWorkingTree:
// 'ro'`, exactly like `panel.files`), whose mount label is the edited repo's
// `owner/repo`. Conversations stamped with another repo never mix into the list;
// they surface under "Other repositories" (repo + count). Legacy unstamped
// conversations ride along with every scope and get stamped on their next save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postToRegion, onRegionMessage, revealRegion, useWorkspace } from "@immediately-run/sdk";
import { openConversationStore, type ConversationStore } from "../lib/conversationStore";
import type { ConversationMeta } from "../lib/conversationModel";
import { scopeConversations } from "../lib/conversationScope";
import { STAGE_REGION, isUpdated, isRequestSelection } from "../lib/conversationIpc";
import { describeStoreFailure } from "../lib/storeError";
import "./ConversationList.css";

function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function ConversationList() {
  const storeRef = useRef<ConversationStore | null>(null);
  const [items, setItems] = useState<ConversationMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Why the store is unavailable, if it is. Without it "New conversation" is a
  // silent no-op and the list is permanently empty — never leave that unexplained
  // (R3-247).
  const [storeError, setStoreError] = useState<string | null>(null);

  // The repository loaded in the workbench (R3-475), from the baseline workspace
  // channel (R3-491). `undefined` when there is no editing session — the channel
  // reports `null` and `scopeConversations` then lists only unstamped conversations,
  // which is the honest answer rather than a guess.
  const currentRepo = useWorkspace()?.label;

  // Scope the list (R3-475): this repo's conversations (plus legacy unstamped
  // ones) vs. every other repo, grouped. Pure rule in conversationScope.ts.
  const { mine, others } = useMemo(() => scopeConversations(items, currentRepo), [items, currentRepo]);

  // The selection the stage should show: the user's explicit choice while it is
  // still in scope, else the newest in-scope conversation (so the stage isn't
  // blank, and a repo switch or delete re-lands somewhere sensible). DERIVED, not
  // set from an effect — there is one writer (`setSelected`, gesture handlers) and
  // one announcer (the posting effect below).
  const effectiveSelected = useMemo(() => {
    if (selected && mine.some((c) => c.id === selected)) return selected;
    return mine[0]?.id ?? null;
  }, [selected, mine]);

  // Announce the selection to the stage whenever it changes — a user's tap and the
  // bookkeeping fallback go through the same single post, so the two can't race.
  useEffect(() => {
    if (!effectiveSelected) return;
    void postToRegion(STAGE_REGION, { type: "select-conversation", id: effectiveSelected }).catch(() => {});
  }, [effectiveSelected]);

  // The current selection, readable from the IPC listener without re-subscribing it
  // on every change (the stage asks for it when it mounts). Mirrored in an effect,
  // not during render — the listener only ever reads it asynchronously.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = effectiveSelected;
  }, [effectiveSelected]);

  // OPEN = select AND take the user there (R3-243). Distinct from `select` on
  // purpose: only a tap that MEANS "show me this" advances the column. Selecting
  // the first conversation on load, or the next one after a delete, is bookkeeping
  // — advancing there would move the user somewhere they didn't ask to go, and the
  // host would refuse it anyway (no gesture).
  //
  // The host ignores a reveal it doesn't like, so this needs no success handling;
  // it only swallows the authorization rejection (an older host has no `reveal`
  // method, which must degrade to today's behaviour rather than an unhandled reject).
  const openConversation = useCallback((id: string) => {
    setSelected(id);
    void revealRegion(STAGE_REGION).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    try {
      setItems(await store.list());
    } catch {
      /* transient read failure — keep the last good list */
    }
  }, []);

  // Open the store and list. Selection happens in the scoped effect below, so the
  // stage isn't seeded with another repo's newest conversation (R3-475).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openConversationStore();
        if (!live) return;
        storeRef.current = store;
        const list = await store.list();
        if (!live) return;
        setItems(list);
        setStoreError(null);
      } catch (e) {
        if (live) setStoreError(describeStoreFailure(e));
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Keep the list fresh: the stage posts "updated" when it derives a title or saves;
  // also re-list when the panel regains focus (cheap belt-and-suspenders).
  useEffect(() => {
    const off = onRegionMessage((m) => {
      if (isUpdated(m.data)) void refresh();
      // The stage mounted and wants to know what it should be showing (R3-243). It
      // may have missed the `select-conversation` entirely: on mobile it does not
      // exist until the reveal puts it on screen, which happens after the post.
      // Answering here is what makes tapping an OLDER conversation land on that one
      // rather than on the newest.
      else if (isRequestSelection(m.data) && selectedRef.current) {
        void postToRegion(STAGE_REGION, {
          type: "select-conversation",
          id: selectedRef.current,
        }).catch(() => {});
      }
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const newConversation = async () => {
    const store = storeRef.current;
    // No store ⇒ the button cannot work. Say why rather than doing nothing.
    if (!store) {
      setStoreError((prev) => prev ?? describeStoreFailure(new Error("settings unavailable")));
      return;
    }
    try {
      // Stamped with the loaded repo (R3-475) so it scopes correctly from birth.
      const conv = await store.create(undefined, currentRepo);
      setItems((l) => [
        { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, repo: conv.repo },
        ...l,
      ]);
      setStoreError(null);
      openConversation(conv.id);
    } catch (e) {
      setStoreError(describeStoreFailure(e));
    }
  };

  const remove = async (id: string) => {
    const store = storeRef.current;
    if (!store) return;
    try {
      await store.remove(id);
    } catch {
      /* ignore */
    }
    setItems((l) => l.filter((c) => c.id !== id));
    if (selected === id) setSelected(null); // the scoped effect re-selects
  };

  return (
    <div className="cl">
      <header className="cl-hd">
        <span className="cl-title">Conversations</span>
        <button type="button" className="cl-new" onClick={() => void newConversation()}>
          New conversation
        </button>
      </header>

      {currentRepo && (
        <p className="cl-scope" title="Conversations are scoped to the repository loaded in the workbench.">
          {currentRepo}
        </p>
      )}

      {storeError && (
        <p className="cl-empty cl-error" role="status">
          {storeError}
        </p>
      )}

      {ready && !storeError && mine.length === 0 && (
        <p className="cl-empty">No conversations here yet. Start one with “New conversation”.</p>
      )}

      <ul className="cl-list">
        {mine.map((c) => (
          <li
            key={c.id}
            className={`cl-row${effectiveSelected === c.id ? " cl-row-active" : ""}`}
            onClick={() => openConversation(c.id)}
            tabIndex={0}
            role="button"
            aria-pressed={effectiveSelected === c.id}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openConversation(c.id);
              }
            }}
          >
            <span className="cl-row-main">
              <span className="cl-row-title">{c.title}</span>
              <span className="cl-row-time">{relTime(c.updatedAt)}</span>
            </span>
            <button
              type="button"
              className="cl-del"
              aria-label={`Delete ${c.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void remove(c.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {/* Conversations belonging to OTHER repositories (R3-475): visible so they are
          never lost, but never mixed into the list above. Opening one of these repos
          in a new tab needs a host-mediated affordance — a tab opened from this
          sandboxed frame inherits the sandbox (opaque origin, measured) and the
          workbench cannot run in it — so until that lands the rows name the repo to
          open rather than pretending a link works. */}
      {ready && others.length > 0 && (
        <details className="cl-others">
          <summary>Other repositories</summary>
          <ul className="cl-others-list">
            {others.map((g) => (
              <li
                key={g.repo}
                className="cl-others-row"
                title={`Open ${g.repo} on immediately.run to see these conversations.`}
              >
                <span className="cl-others-repo">{g.repo}</span>
                <span className="cl-others-count">{g.count}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
