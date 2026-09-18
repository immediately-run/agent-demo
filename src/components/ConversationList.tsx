// The conversation LIST — the panel-slot half of the agents activity (plan Phase
// 04, region `panel.agent`). The analog of the file explorer: it lists the user's
// conversations and a "new" button, and on selection posts the conversation id to
// the stage over IPC. It runs no agent and holds no net:fetch — all model calls
// happen in the stage (ConversationStage).
//
// R3-475 — the list is SCOPED to the repository loaded in the workbench: the
// scoping key is `useWorkspace()?.label` (the workspace the host projects to the
// panel), NOT a conferred worktree mount — the `exposesWorkingTree` shortcut was
// rejected (the panel holds no such capability and site-main pins it absent; see
// the item's narrowed history). Conversations stamped with another repo never mix
// into the list; they surface under "Other repositories" (repo + count). Legacy
// unstamped conversations ride along with every scope and get stamped on their
// next save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postToRegion, onRegionMessage, revealRegion, useWorkspace } from "@immediately-run/sdk";
import { openConversationStore, metaOf, type ConversationStore } from "../lib/conversationStore";
import type { ConversationMeta } from "../lib/conversationModel";
import { scopeConversations, type RepoGroup } from "../lib/conversationScope";
import { applyConversationUpdate } from "../lib/conversationUpdate";
import { STAGE_REGION, isUpdated, isRequestSelection, selectMessage } from "../lib/conversationIpc";
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

/** R3-475 — what an other-repositories count IS, in words ("2 conversations in
 *  other/repo"): the hover title and the visually-hidden accessible text are the
 *  one string, so they can never disagree. */
function countLabel(g: RepoGroup): string {
  return `${g.count} ${g.count === 1 ? "conversation" : "conversations"} in ${g.repo}`;
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
  // set from an effect — there is one writer (`setSelected`, gesture handlers),
  // while the announcements come from both a gesture post (`openConversation`,
  // so a re-tap of the selected row still lands) and the derived-change effect below.
  const effectiveSelected = useMemo(() => {
    if (selected && mine.some((c) => c.id === selected)) return selected;
    return mine[0]?.id ?? null;
  }, [selected, mine]);

  // Announce a DERIVED selection change to the stage — the bookkeeping fallback (first
  // row on load, next after a delete/scope change). A user's tap is also announced
  // directly by `openConversation`, so a re-tap of the already-selected row — which does
  // not change `effectiveSelected` and so skips this effect — still posts (R3-616). A
  // tap on a *different* row is therefore announced twice — by the gesture post and
  // again by this effect — the item's accepted cost, harmless because the arbiter is
  // idempotent.
  useEffect(() => {
    if (!effectiveSelected) return;
    void postToRegion(STAGE_REGION, selectMessage(effectiveSelected)).catch(() => {});
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
    // A tap is an event, not a state transition: announce it directly (R3-616) so a tap
    // on the already-selected row still posts — the derived-value effect above only fires
    // when `effectiveSelected` changes, so the re-tap case was previously silent.
    void postToRegion(STAGE_REGION, selectMessage(id)).catch(() => {});
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

  // Keep the list fresh. A `conversation-updated` message names ONE conversation,
  // so the handler loads that row and patches it in place (R3-612 / R-IX-4) — a
  // full `list()` re-reads every conversation JSON (cap 500) to learn one row's
  // title and timestamp moved. `refresh()` stays for the focus-regain path, where
  // there is no narrower signal; the mount path lists directly (it needs the
  // store-open error handling too).
  const patchOne = useCallback(async (id: string) => {
    const store = storeRef.current;
    if (!store) return;
    try {
      const conv = await store.load(id);
      // `null` = deleted elsewhere (or corrupt): the row goes.
      setItems((l) => (conv ? applyConversationUpdate(l, metaOf(conv)) : l.filter((c) => c.id !== id)));
    } catch {
      // Read failure — keep the last good list, the same resolution as refresh().
    }
  }, []);

  useEffect(() => {
    const off = onRegionMessage((m) => {
      if (isUpdated(m.data)) void patchOne(m.data.id);
      // The stage mounted and wants to know what it should be showing (R3-243). It
      // may have missed the `select-conversation` entirely: on mobile it does not
      // exist until the reveal puts it on screen, which happens after the post.
      // Answering here is what makes tapping an OLDER conversation land on that one
      // rather than on the newest.
      else if (isRequestSelection(m.data) && selectedRef.current) {
        void postToRegion(STAGE_REGION, selectMessage(selectedRef.current)).catch(() => {});
      }
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, patchOne]);

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
      setItems((l) => [metaOf(conv), ...l]);
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
    } catch (e) {
      // A delete that failed must leave the row in place and say why (R-IX-3):
      // dropping it anyway would show a change that did not happen. Same
      // failure surface as create/save above.
      setStoreError(describeStoreFailure(e));
      return;
    }
    setItems((l) => l.filter((c) => c.id !== id));
    if (selected === id) setSelected(null); // the scoped effect re-selects
    setStoreError(null);
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
          <li key={c.id} className={`cl-row${effectiveSelected === c.id ? " cl-row-active" : ""}`}>
            {/* R3-612 — the open action is a REAL button over the row's main
                content: a row-level button role containing this control made the
                row's name-from-content absorb "Delete …" and gave the two
                controls one activation surface (WCAG 4.1.2, twice). Selected
                state travels via aria-pressed on the open control. */}
            <button
              type="button"
              className="cl-row-open"
              aria-pressed={effectiveSelected === c.id}
              onClick={() => openConversation(c.id)}
            >
              <span className="cl-row-title">{c.title}</span>
              <span className="cl-row-time">{relTime(c.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="cl-del"
              aria-label={`Delete ${c.title}`}
              onClick={() => void remove(c.id)}
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
            {others.map((g) => {
              // R3-475 — the count must say what it counts: a bare digit has no
              // hover label and announces as a lone number to a screen reader.
              // The row's own title says what OPENING the repo does; the count's
              // label says what the number IS. (The accessible text is
              // visually-hidden real text, not aria-label on a generic span —
              // naming is prohibited on role=generic, so aria-label would be a
              // placebo.)
              const label = countLabel(g);
              return (
                <li
                  key={g.repo}
                  className="cl-others-row"
                  title={`Open ${g.repo} on immediately.run to see these conversations.`}
                >
                  <span className="cl-others-repo">{g.repo}</span>
                  <span className="cl-others-count" title={label}>
                    <span className="cl-vh">{label}</span>
                    <span aria-hidden="true">{g.count}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
