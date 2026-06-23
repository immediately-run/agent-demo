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
import { createFsToolset } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { SYSTEM_PROMPT } from "../lib/agentPrompt";
import { createModelClient } from "../lib/modelClient";
import { useProviderConnection } from "../lib/useProviderConnection";
import { runAgent } from "../lib/agentLoop";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import { PANEL_REGION, isSelect } from "../lib/conversationIpc";
import "./CodingAgent.css";

export default function ConversationStage() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const { provider, connected, hasStoredKey, keyMsg, connect } = useProviderConnection();
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  const [title, setTitle] = useState<string>("");

  const toolset = useMemo(() => {
    const root = getAppMountPath();
    const appMount = mounts.find((m) => m.path === root);
    const readOnly = appMount?.mode === "ro";
    const fsTools = createFsToolset({ root, readOnly });
    const projectTools = createProjectToolset({ root, readOnly });
    return mergeToolsets(catalogToolset(catalog), fsTools, projectTools);
  }, [catalog, mounts]);

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
    // Bind the provider key to this app before the first call (browser-direct
    // injectSecret needs the use-grant or the host refuses the fetch).
    if (!connected && !(await connect())) return;
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
        client: createModelClient(),
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
        <span className="ca-sub">{toolset.tools.length} tools (catalog + files)</span>
      </header>

      {!connected && (
        <div className="ca-key">
          <button type="button" className="ca-keybtn" onClick={() => void connect()}>
            {hasStoredKey ? `Connect ${provider.label} key` : `Add ${provider.label} key`}
          </button>
          <span className="ca-keyhint">
            Your stored {provider.label} key, injected by the host per request — never held by this app.
          </span>
        </div>
      )}
      {keyMsg && <div className="ca-keymsg">{keyMsg}</div>}

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
        <button type="button" className="ca-run" disabled={running} onClick={() => void run()}>
          {running ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
}
