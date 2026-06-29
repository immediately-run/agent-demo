// A real in-browser coding-agent loop (LLM_AND_AGENTS_SPEC §3.3). It hands the
// model two tool sources merged into one list: the app's grant-filtered §5.5
// catalog (driven through the host's gated `invoke()`) and mount-scoped
// filesystem tools (read/write/list/stat/glob/grep/delete over the app's working
// tree). Confinement is automatic (G12/T24): the model can only drive methods in
// this app's catalog or files inside its mount chroot; anything else returns
// `forbidden`/`not found`.
//
// Inference goes through the platform `llm.chat` service (SDK `chat()`): the app
// names no vendor and no model and holds no key — the host injects the user's key and
// resolves the user's preferred provider/model (AGENT_AUTHORING_ARCHITECTURE §3; H2
// favours chat() over net:fetch+secrets). Needs only the `llm:chat` capability.
import { useEffect, useMemo, useRef, useState } from "react";
import { useCatalog, useMounts, getAppMountPath } from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { SYSTEM_PROMPT } from "../lib/agentPrompt";
import { createChatModelClient } from "../lib/chatModelClient";
import { runAgent } from "../lib/agentLoop";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import "./CodingAgent.css";

export default function CodingAgent() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);

  // Persistence (Phase 01): keep this run in a durable conversation so it survives
  // reload. Best-effort — `openSettings()` is inert in local dev / signed out, so a
  // failure degrades to today's ephemeral behavior rather than crashing.
  const storeRef = useRef<ConversationStore | null>(null);
  const convRef = useRef<Conversation | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openConversationStore();
        if (!live) return;
        storeRef.current = store;
        const [newest] = await store.list();
        const conv = newest ? await store.load(newest.id) : await store.create();
        if (!live || !conv) return;
        convRef.current = conv;
        if (conv.messages.length) setLog(messagesToLog(conv.messages));
      } catch {
        /* no host / signed out — stay ephemeral */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Merge the platform catalog with filesystem + project tools chrooted to the
  // app's working tree. Re-derived when grants or the mount's writability change.
  const toolset = useMemo(() => {
    const root = getAppMountPath();
    const appMount = mounts.find((m) => m.path === root);
    const readOnly = appMount?.mode === "ro";
    const fsTools = createFsToolset({ root, readOnly });
    const projectTools = createProjectToolset({ root, readOnly });
    return mergeToolsets(catalogToolset(catalog), fsTools, projectTools);
  }, [catalog, mounts]);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const run = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setLog([]);
    setStreaming("");
    append({ kind: "user", text: prompt });
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: SYSTEM_PROMPT,
        prompt,
        events: {
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          onAssistantText: (text) => {
            if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) =>
            append({ kind: "result", name, content: r.content, isError: r.isError }),
        },
      });
      await persist(transcript);
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setStreaming("");
      setRunning(false);
    }
  };

  // Save the run into its conversation (best-effort; no-op without a store).
  const persist = async (messages: Conversation["messages"]) => {
    const store = storeRef.current;
    if (!store) return;
    try {
      const conv = convRef.current ?? (await store.create());
      const title = conv.title === "New conversation" ? deriveTitle(messages) : conv.title;
      convRef.current = await store.save({ ...conv, title, messages });
    } catch {
      /* persistence is best-effort — never break the run on a write failure */
    }
  };

  return (
    <div className="ca">
      <header className="ca-hd">
        <span className="ca-title">Coding agent</span>
        <span className="ca-sub">{toolset.tools.length} tools (catalog + files + project)</span>
      </header>

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

      <ul className="ca-log">
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
                <code>{e.name}</code> {e.isError ? "✗" : "✓"}{" "}
                <code className="ca-args">{e.content}</code>
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
    </div>
  );
}
