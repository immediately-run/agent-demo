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
import { useMemo, useState } from "react";
import {
  useCatalog,
  useMounts,
  useSecrets,
  getAppMountPath,
  requestAddSecret,
} from "@immediately-run/sdk";
import { catalogToolset, mergeToolsets } from "../lib/toolset";
import { createFsToolset } from "../lib/fsTools";
import { createClaudeClient } from "../lib/claudeClient";
import { runAgent } from "../lib/agentLoop";
import "./CodingAgent.css";

const SYSTEM =
  "You are a coding agent embedded in an immediately.run app. You have two kinds " +
  "of tools: filesystem tools (read_file, write_file, list_dir, stat, glob, grep, " +
  "delete_file) scoped to this app's workspace, and platform methods this app has " +
  "been granted. Explore with list_dir/glob/grep before editing, make focused " +
  "edits with write_file, then stop. If a tool returns `forbidden`, the app lacks " +
  "that grant — do not retry it; explain what's missing instead.";

type LogEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "result"; name: string; content: string; isError?: boolean }
  | { kind: "error"; text: string };

export default function CodingAgent() {
  const catalog = useCatalog();
  const mounts = useMounts();
  const secrets = useSecrets();
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [running, setRunning] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  // Merge the platform catalog with filesystem tools chrooted to the app's
  // working tree. Re-derived when grants or the mount's writability change.
  const toolset = useMemo(() => {
    const root = getAppMountPath();
    const appMount = mounts.find((m) => m.path === root);
    const fsTools = createFsToolset({ root, readOnly: appMount?.mode === "ro" });
    return mergeToolsets(catalogToolset(catalog), fsTools);
  }, [catalog, mounts]);

  // Best-effort: do we already have an Anthropic api-key the host can inject?
  // (secrets:list is elevated; if it's withheld the list stays empty and we just
  // show the "add" affordance — injection still works once a key exists.)
  const hasKey = secrets.some(
    (s) =>
      s.type === "api-key" &&
      (s.family === "anthropic" || (s.boundOrigin ?? "").includes("anthropic.com")),
  );

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const addKey = async () => {
    setKeyMsg(null);
    try {
      await requestAddSecret({
        type: "api-key",
        family: "anthropic",
        suggestedOrigin: "https://api.anthropic.com",
        description: "Anthropic API key for the coding agent",
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      setKeyMsg(
        code === "cancelled"
          ? "Key setup cancelled."
          : code === "forbidden"
            ? "This app can't manage secrets here; add an Anthropic key in host settings."
            : `Couldn't add key: ${(e as Error)?.message ?? String(e)}`,
      );
    }
  };

  const run = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setLog([]);
    setStreaming("");
    try {
      await runAgent({
        client: createClaudeClient(), // no apiKey: the host injects it (injectSecret)
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
        <span className="ca-title">Coding agent</span>
        <span className="ca-sub">{toolset.tools.length} tools (catalog + files)</span>
      </header>

      {!hasKey && (
        <div className="ca-key">
          <button type="button" className="ca-keybtn" onClick={() => void addKey()}>
            Add Anthropic API key
          </button>
          <span className="ca-keyhint">
            Stored by the host and injected per request — never held by this app.
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
