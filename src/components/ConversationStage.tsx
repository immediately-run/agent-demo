// The conversation STAGE — the stage-slot half of the agents activity (plan Phase
// 05, region `stage.conversation`). The analog of the editor: it loads the
// conversation the panel selected, shows its transcript, and runs the in-browser
// agent loop, persisting every turn. The loop, tools, streaming, and host-mediated
// BYOK are the same machinery the standalone CodingAgent uses (LLM_AND_AGENTS_SPEC
// §3.3); confinement is automatic (G12/T24): catalog ⊕ mount-chroot fs tools only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCatalog,
  useMounts,
  getAppMountPath,
  postToRegion,
  onRegionMessage,
  describeChat,
} from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset, findConferredWorktree } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { createDiagnosticsToolset } from "../lib/diagnosticsTools";
import { buildSystemPrompt, todayIso } from "../lib/agentPrompt";
import { createChatModelClient } from "../lib/chatModelClient";
import { runAgent } from "../lib/agentLoop";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import { PANEL_REGION, isSelect } from "../lib/conversationIpc";
import { describeStoreFailure as describe } from "../lib/storeError";
import "./CodingAgent.css";

export default function ConversationStage() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
  // R3-224 (§3.3): the stop button's abort controller for the in-flight run. Aborting
  // it halts the loop AND tears down the in-flight upstream LLM request (stops billing).
  const abortRef = useRef<AbortController | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  const [title, setTitle] = useState<string>("");
  // Why persistence is unavailable, if it is. The conversation store is not a
  // nice-to-have: `run()` reads the model's HISTORY out of the persisted
  // conversation, so a dead store silently downgrades the agent to a stateless
  // chatbot that re-reads nothing between turns. That failure used to be
  // swallowed by empty `catch {}`s — surface it instead (R3-247).
  const [storeError, setStoreError] = useState<string | null>(null);

  // The STAGE app's working tree, conferred by the host as a `type:'worktree'` mount
  // (AA-23) — NOT the agent's OWN repo. If it isn't conferred (the mount hasn't arrived,
  // churned away, or no app is loaded), this is `null` and we MUST NOT fall back to the
  // agent's own repo: doing so made the workbench silently author *itself* (every
  // stage-app path read `not found`, and the model floundered). Re-derived when the
  // conferred mount changes (switching the loaded app tears down the old port, mints new).
  const stageTree = useMemo(() => findConferredWorktree(mounts, getAppMountPath()), [mounts]);

  // Tools given to the model. Without the stage tree the agent gets the catalog ONLY —
  // no filesystem tools — so it can never edit the wrong (its own) repo. Run is gated
  // below and a "workspace not ready" notice is shown.
  const toolset = useMemo(() => {
    if (!stageTree) return catalogToolset(catalog);
    const fsTools = createFsToolset({ root: stageTree.root, readOnly: stageTree.readOnly });
    const projectTools = createProjectToolset({ root: stageTree.root, readOnly: stageTree.readOnly });
    const diagnosticsTools = createDiagnosticsToolset();
    return mergeToolsets(catalogToolset(catalog), fsTools, projectTools, diagnosticsTools);
  }, [catalog, stageTree]);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const showConversation = useCallback((conv: Conversation) => {
    convRef.current = conv;
    setTitle(conv.title);
    setLog(messagesToLog(conv.messages));
    setStreaming("");
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const store = storeRef.current;
      if (!store) return;
      const conv = await store.load(id);
      if (conv) showConversation(conv);
    },
    [showConversation],
  );

  // Open the store; if no selection arrives, show the newest so the stage isn't blank.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openConversationStore();
        if (!live) return;
        storeRef.current = store;
        setStoreError(null);
        if (!convRef.current) {
          const [newest] = await store.list();
          if (newest && live) await loadConversation(newest.id);
        }
      } catch (e) {
        // Signed out is the ordinary case; anything else is a real fault the user
        // must see, because it costs them conversation memory.
        if (live) setStoreError(describe(e, ", so each message is sent without the earlier ones"));
      }
    })();
    return () => {
      live = false;
    };
  }, [loadConversation]);

  // The panel drives which conversation is shown.
  useEffect(() => {
    return onRegionMessage((m) => {
      if (isSelect(m.data)) void loadConversation(m.data.id);
    });
  }, [loadConversation]);

  // Ask the panel what it has selected, once, on mount (R3-243).
  //
  // A `select-conversation` can be sent while this region does not exist: on mobile
  // the panel and the stage are different COLUMNS, and an unvisited column renders a
  // skeleton with no iframe — so the tap that reveals this pane is also the tap whose
  // selection had nowhere to land. Without this handshake the fallback above would
  // win and show the newest conversation instead of the tapped one.
  //
  // Subscribed BEFORE the ask (the listener above is already installed by the time
  // this effect runs), so the reply cannot arrive before anyone is listening. If the
  // panel is not there — a stage mounted on its own — nothing answers and the
  // newest-conversation fallback stands, exactly as before.
  useEffect(() => {
    void postToRegion(PANEL_REGION, { type: "request-selection" }).catch(() => {});
  }, []);

  const run = async () => {
    if (!prompt.trim() || running) return;
    // Refuse rather than author the wrong tree: with no conferred stage-app working
    // tree, the agent has no filesystem tools, so a "build me X" prompt would either
    // do nothing or (pre-fix) silently edit the agent's own repo. Tell the user.
    if (!stageTree) {
      append({ kind: "user", text: prompt });
      append({
        kind: "error",
        text: "No app workspace is connected yet. Open an app in the stage (and give it a moment to mount) before asking me to edit it — I won't touch my own files.",
      });
      setPrompt("");
      return;
    }
    const store = storeRef.current;
    // Ensure a conversation exists to attach this run to.
    let conv = convRef.current;
    if (!conv && store) {
      try {
        conv = await store.create();
        convRef.current = conv;
        setTitle(conv.title);
        setStoreError(null);
      } catch (e) {
        // Running ephemerally is a real degradation, not a detail: `history`
        // below falls back to [], so the model sees ONLY this prompt and the
        // conversation appears to have no memory. Say so (R3-247).
        setStoreError(describe(e, ", so each message is sent without the earlier ones"));
      }
    }
    // The model's memory of earlier turns. Empty whenever the store is
    // unavailable — which is exactly why `storeError` is surfaced above.
    const history = conv?.messages ?? [];
    const kickoff = prompt;
    setPrompt("");
    setRunning(true);
    setStreaming("");
    append({ kind: "user", text: kickoff });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: buildSystemPrompt({ tools: toolset.tools, workspaceRoot: stageTree?.root, today: todayIso() }),
        history,
        prompt: kickoff,
        // R3-224 (§3.3): the stop button aborts the loop AND the in-flight LLM turn.
        signal: controller.signal,
        // Token accounting + auto-compaction let the loop run past ~12 turns (R3-220).
        contextWindow: describeChat()?.features.maxContextTokens,
        events: {
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          onAssistantText: (text) => {
            if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) => append({ kind: "result", name, content: r.content, isError: r.isError }),
          onNudge: () => append({ kind: "nudge" }),
          onCompact: ({ summarizedCount }) =>
            append({ kind: "compaction", summary: `${summarizedCount} earlier messages summarized` }),
        },
      });
      if (conv && store) {
        const newTitle = conv.title === "New conversation" ? deriveTitle(transcript) : conv.title;
        try {
          convRef.current = await store.save({ ...conv, title: newTitle, messages: transcript });
          setTitle(newTitle);
          setStoreError(null);
          void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
        } catch (e) {
          // A failed save means `convRef.current` keeps the PRE-run messages, so the
          // next turn re-sends a stale (or empty) history — the same amnesia as a
          // dead store, one turn later. Never silent (R3-247).
          setStoreError(describe(e, ", so each message is sent without the earlier ones"));
        }
      }
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setStreaming("");
      setRunning(false);
      abortRef.current = null;
    }
  };

  // R3-224 (§3.3): stop the in-flight run — aborts the loop between tool calls AND the
  // in-flight LLM request (the host tears down the upstream provider fetch, stops billing).
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="ca">
      <header className="ca-hd">
        <span className="ca-title">{title || "Conversation"}</span>
        <span className="ca-sub">
          {toolset.tools.length} tools {stageTree ? "(catalog + files)" : "(catalog only)"}
        </span>
      </header>

      {!stageTree && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">
            Waiting for the app's workspace to connect… file tools are unavailable until then
            (I won't edit my own files).
          </span>
        </div>
      )}

      {storeError && (
        <div className="ca-line ca-error" role="status">
          <span className="ca-err">{storeError}</span>
        </div>
      )}

      <ul className="ca-log" aria-live="polite">
        {log.map((e, i) => (
          <li key={i} className={`ca-line ca-${e.kind}`}>
            {e.kind === "user" && <span className="ca-user">{e.text}</span>}
            {e.kind === "text" && <span className="ca-text">{e.text}</span>}
            {e.kind === "tool" && (
              <span>
                → <code>{e.name}</code> <code className="ca-args">{JSON.stringify(e.input)}</code>
              </span>
            )}
            {e.kind === "result" && (
              <span className={e.isError ? "ca-err" : "ca-ok"}>
                <code>{e.name}</code> {e.isError ? "✗" : "✓"} <code className="ca-args">{e.content}</code>
              </span>
            )}
            {e.kind === "error" && <span className="ca-err">{e.text}</span>}
            {e.kind === "nudge" && (
              <span className="ca-nudge">↺ nudging the model to continue…</span>
            )}
            {e.kind === "compaction" && (
              <span className="ca-compaction" title={e.summary}>
                ⚑ compacted earlier turns to stay within the context window
              </span>
            )}
          </li>
        ))}
        {streaming && (
          <li className="ca-line ca-text ca-live">
            <span className="ca-text">{streaming}</span>
          </li>
        )}
      </ul>

      <div className="ca-prompt-row">
        <input
          className="ca-prompt"
          placeholder="Ask the agent to read, search, or edit your app…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          aria-label="Prompt"
        />
        <button
          type="button"
          className="ca-run"
          // While running, the button becomes a live Stop control (R3-224): it must
          // stay enabled so the user can abort the in-flight turn and stop billing.
          disabled={running ? false : !stageTree}
          title={
            running
              ? "Stop the agent and abort the in-flight request"
              : !stageTree
                ? "Waiting for the app's workspace to connect"
                : undefined
          }
          onClick={() => (running ? stop() : void run())}
        >
          {running ? "Stop" : "Run"}
        </button>
      </div>
    </div>
  );
}
