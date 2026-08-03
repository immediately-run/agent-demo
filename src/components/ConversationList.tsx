// The conversation LIST — the panel-slot half of the agents activity (plan Phase
// 04, region `panel.agent`). The analog of the file explorer: it lists the user's
// conversations and a "new" button, and on selection posts the conversation id to
// the stage over IPC. It runs no agent and holds no net:fetch — all model calls
// happen in the stage (ConversationStage).
import { useCallback, useEffect, useRef, useState } from "react";
import { postToRegion, onRegionMessage, revealRegion } from "@immediately-run/sdk";
import { openConversationStore, type ConversationStore } from "../lib/conversationStore";
import type { ConversationMeta } from "../lib/conversationModel";
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

  const select = useCallback((id: string) => {
    setSelected(id);
    void postToRegion(STAGE_REGION, { type: "select-conversation", id }).catch(() => {});
  }, []);
  // The current selection, readable from the IPC listener without re-subscribing it
  // on every change (the stage asks for it when it mounts). Mirrored in an effect,
  // not during render — the listener only ever reads it asynchronously.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // OPEN = select AND take the user there (R3-243). Distinct from `select` on
  // purpose: only a tap that MEANS "show me this" advances the column. Selecting
  // the first conversation on load, or the next one after a delete, is bookkeeping
  // — advancing there would move the user somewhere they didn't ask to go, and the
  // host would refuse it anyway (no gesture).
  //
  // The host ignores a reveal it doesn't like, so this needs no success handling;
  // it only swallows the authorization rejection (an older host has no `reveal`
  // method, which must degrade to today's behaviour rather than an unhandled reject).
  const openConversation = useCallback(
    (id: string) => {
      select(id);
      void revealRegion(STAGE_REGION).catch(() => {});
    },
    [select],
  );

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    try {
      setItems(await store.list());
    } catch {
      /* transient read failure — keep the last good list */
    }
  }, []);

  // Open the store, list, and auto-select the newest so the stage isn't blank.
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
        if (list[0]) select(list[0].id);
      } catch (e) {
        if (live) setStoreError(describeStoreFailure(e));
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [select]);

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
      const conv = await store.create();
      setItems((l) => [{ id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt }, ...l]);
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
    const remaining = items.filter((c) => c.id !== id);
    setItems(remaining);
    if (selected === id) {
      if (remaining[0]) select(remaining[0].id);
      else setSelected(null);
    }
  };

  return (
    <div className="cl">
      <header className="cl-hd">
        <span className="cl-title">Conversations</span>
        <button type="button" className="cl-new" onClick={() => void newConversation()}>
          New conversation
        </button>
      </header>

      {storeError && (
        <p className="cl-empty cl-error" role="status">
          {storeError}
        </p>
      )}

      {ready && !storeError && items.length === 0 && (
        <p className="cl-empty">No conversations yet. Start one with “New conversation”.</p>
      )}

      <ul className="cl-list">
        {items.map((c) => (
          <li
            key={c.id}
            className={`cl-row${selected === c.id ? " cl-row-active" : ""}`}
            onClick={() => openConversation(c.id)}
            tabIndex={0}
            role="button"
            aria-pressed={selected === c.id}
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
    </div>
  );
}
