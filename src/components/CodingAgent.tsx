// A real in-browser coding-agent loop (LLM_AND_AGENTS_SPEC §3.3). It hands the
// model two tool sources merged into one list: the app's grant-filtered §5.5
// catalog (driven through the host's gated `invoke()`) and mount-scoped
// filesystem tools (read/write/list/stat/glob/grep/delete over the app's working
// tree). Confinement is automatic (G12/T24): the model can only drive methods in
// this app's catalog or files inside its mount chroot; anything else returns
// `forbidden`/`not found`.
//
// The LLM key is host-mediated (SECRETS_SPEC §6): the app never holds it — the
// host injects `x-api-key` from the `injectSecret` rule declared in package.json.
// If the user hasn't stored an Anthropic key yet, we offer the host's "add secret"
// modal (the value is typed into host chrome, never here).
import { useEffect, useMemo, useRef, useState } from "react";
import { useCatalog, useMounts, getAppMountPath } from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset } from "../lib/fsTools";
import { createModelClient } from "../lib/modelClient";
import { useProviderConnection } from "../lib/useProviderConnection";
import { runAgent } from "../lib/agentLoop";
import { openConversationStore, deriveTitle, type ConversationStore } from "../lib/conversationStore";
import type { Conversation } from "../lib/conversationModel";
import { messagesToLog, type LogEntry } from "../lib/transcript";
import "./CodingAgent.css";

const SYSTEM =
  "You are a coding agent embedded in an immediately.run app. You have two kinds " +
  "of tools: filesystem tools (read_file, write_file, list_dir, stat, glob, grep, " +
  "delete_file) scoped to this app's workspace, and platform methods this app has " +
  "been granted. Explore with list_dir/glob/grep before editing, make focused " +
  "edits with write_file, then stop. If a tool returns `forbidden`, the app lacks " +
  "that grant — do not retry it; explain what's missing instead.";

export default function CodingAgent() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  // Provider-key connection (default OpenRouter): `connect` binds the user's
  // stored key to this app before the first model call (see the hook).
  const { provider, connected, hasStoredKey, keyMsg, connect } = useProviderConnection();

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

  // Merge the platform catalog with filesystem tools chrooted to the app's
  // working tree. Re-derived when grants or the mount's writability change.
  const toolset = useMemo(() => {
    const root = getAppMountPath();
    const appMount = mounts.find((m) => m.path === root);
    const fsTools = createFsToolset({ root, readOnly: appMount?.mode === "ro" });
    return mergeToolsets(catalogToolset(catalog), fsTools);
  }, [catalog, mounts]);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const run = async () => {
    if (!prompt.trim() || running) return;
    // Ensure the provider key is bound to this app before the first call — the
    // browser-direct injectSecret path needs the use-grant or the host refuses
    // the fetch ("outside manifest ∩ grant allowlist").
    if (!connected && !(await connect())) return;
    setRunning(true);
    setLog([]);
    setStreaming("");
    append({ kind: "user", text: prompt });
    try {
      const transcript = await runAgent({
        client: createModelClient(), // no apiKey: the host injects it (injectSecret)
        tools: toolset.tools,
        execute: toolset.execute,
        system: SYSTEM,
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
