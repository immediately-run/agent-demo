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
import { useCatalog, useMounts, getAppMountPath, describeChat } from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset, resolveWorkingTreeMount } from "../lib/fsTools";
import { createProjectToolset } from "../lib/projectTools";
import { createDiagnosticsToolset } from "../lib/diagnosticsTools";
import { buildSystemPrompt, todayIso } from "../lib/agentPrompt";
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
  // R3-224 (§3.3): the stop button's abort controller for the in-flight run.
  const abortRef = useRef<AbortController | null>(null);
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

  // Merge the platform catalog with filesystem + project tools chrooted to the working
  // tree. When a stage app's tree is conferred (`type:'worktree'`, AA-23) author THAT;
  // otherwise (standalone agent) fall back to this app's own repo. Re-derived when the
  // conferred mount or its writability changes.
  const toolset = useMemo(() => {
    const { root, readOnly } = resolveWorkingTreeMount(mounts, getAppMountPath());
    const fsTools = createFsToolset({ root, readOnly });
    const projectTools = createProjectToolset({ root, readOnly });
    const diagnosticsTools = createDiagnosticsToolset();
    return mergeToolsets(catalogToolset(catalog), fsTools, projectTools, diagnosticsTools);
  }, [catalog, mounts]);

  // The workspace root the fs tools are chrooted to — env grounding for the prompt.
  const workspaceRoot = useMemo(
    () => resolveWorkingTreeMount(mounts, getAppMountPath()).root,
    [mounts],
  );

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const run = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setLog([]);
    setStreaming("");
    append({ kind: "user", text: prompt });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const transcript = await runAgent({
        client: createChatModelClient(),
        tools: toolset.tools,
        execute: toolset.execute,
        system: buildSystemPrompt({ tools: toolset.tools, workspaceRoot, today: todayIso() }),
        prompt,
        // R3-224 (§3.3): the stop button aborts the loop AND the in-flight LLM turn.
        signal: controller.signal,
        // Token accounting + auto-compaction let the loop run past ~12 turns
        // (R3-220): the resolved provider's window drives when to compact.
        contextWindow: describeChat()?.features.maxContextTokens,
        events: {
          onAssistantDelta: (text) => setStreaming((s) => s + text),
          onAssistantText: (text) => {
            if (text.trim()) append({ kind: "text", text });
            setStreaming("");
          },
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) =>
            append({ kind: "result", name, content: r.content, isError: r.isError }),
          onNudge: () => append({ kind: "nudge" }),
          onCompact: ({ summarizedCount }) =>
            append({ kind: "compaction", summary: `${summarizedCount} earlier messages summarized` }),
        },
      });
      await persist(transcript);
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setStreaming("");
      setRunning(false);
      abortRef.current = null;
    }
  };

  // R3-224 (§3.3): abort the in-flight run — the loop AND the upstream LLM request.
  const stop = () => abortRef.current?.abort();

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
        <span className="ca-sub">{toolset.tools.length} tools (catalog + files + project + diagnostics)</span>
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
        <button
          type="button"
          className="ca-run"
          // While running, this is a live Stop control (R3-224) — abort the in-flight turn.
          onClick={() => (running ? stop() : void run())}
        >
          {running ? "Stop" : "Run"}
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
    </div>
  );
}
