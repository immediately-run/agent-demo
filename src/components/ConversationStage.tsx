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
} from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset, findConferredWorktree } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { SYSTEM_PROMPT } from "../lib/agentPrompt";
import { createChatModelClient } from "../lib/chatModelClient";
import { runAgent } from "../lib/agentLoop";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import { PANEL_REGION, isSelect } from "../lib/conversationIpc";
import "./CodingAgent.css";

export default function ConversationStage() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  const [title, setTitle] = useState<string>("");

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
    return mergeToolsets(catalogToolset(catalog), fsTools, projectTools);
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
        if (!convRef.current) {
          const [newest] = await store.list();
          if (newest && live) await loadConversation(newest.id);
        }
      } catch {
        /* no host / signed out — render empty */
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
      } catch {
        /* fall through — run ephemerally if create fails */
      }
    }
    const history = conv?.messages ?? [];
    const kickoff = prompt;
    setPrompt("");
    setRunning(true);
    setStreaming("");
    append({ kind: "user", text: kickoff });
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: SYSTEM_PROMPT,
        history,
        prompt: kickoff,
        events: {
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          onAssistantText: (text) => {
            if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) => append({ kind: "result", name, content: r.content, isError: r.isError }),
          onNudge: () => append({ kind: "nudge" }),
        },
      });
      if (conv && store) {
        const newTitle = conv.title === "New conversation" ? deriveTitle(transcript) : conv.title;
        try {
          convRef.current = await store.save({ ...conv, title: newTitle, messages: transcript });
          setTitle(newTitle);
          void postToRegion(PANEL_REGION, { type: "conversation-updated", id: conv.id }).catch(() => {});
        } catch {
          /* persistence best-effort */
        }
      }
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setStreaming("");
      setRunning(false);
    }
  };

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
          disabled={running || !stageTree}
          title={!stageTree ? "Waiting for the app's workspace to connect" : undefined}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
}
