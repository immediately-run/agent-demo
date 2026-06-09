// A real in-browser coding-agent loop (LLM_AND_AGENTS_SPEC §3.3) — the successor
// to the scripted tool-runner in AgentDemo. It hands the app's grant-filtered
// catalog to Claude as the tool list and runs a genuine tool-use loop over the
// §5.11 BYOK proxy. Confinement is automatic (G12/T24): the model can only drive
// methods in this app's catalog; anything else returns `forbidden` at the host.
//
// Interim: the user pastes their own Anthropic key (first-party BYOK). When the
// host-owned secret store ships (P1.E), the key moves behind `injectSecret` and
// this input goes away. Streaming + in-worker fs/typecheck/lint tools are the
// next phases (P3-71 host emitter; a real mount-fs primitive).
import { useState } from "react";
import { useCatalog } from "@immediately-run/sdk";
import { catalogToTools, createCatalogExecutor } from "../lib/agentTools";
import { createClaudeClient } from "../lib/claudeClient";
import { runAgent } from "../lib/agentLoop";
import "./CodingAgent.css";

const SYSTEM =
  "You are a coding agent embedded in an immediately.run app. Your tools are the " +
  "platform methods this app has been granted. Use them to accomplish the user's " +
  "request, then stop. If a tool returns `forbidden`, the app lacks that grant — " +
  "do not retry it; explain what's missing instead.";

type LogEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "result"; name: string; content: string; isError?: boolean }
  | { kind: "error"; text: string };

export default function CodingAgent() {
  const catalog = useCatalog();
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);

  const append = (e: LogEntry) => setLog((l) => [...l, e]);

  const run = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setLog([]);
    try {
      await runAgent({
        client: createClaudeClient({ apiKey: apiKey || undefined }),
        tools: catalogToTools(catalog),
        execute: createCatalogExecutor(catalog),
        system: SYSTEM,
        prompt,
        events: {
          onAssistantText: (text) => append({ kind: "text", text }),
          onToolUse: (name, input) => append({ kind: "tool", name, input }),
          onToolResult: (name, r) =>
            append({ kind: "result", name, content: r.content, isError: r.isError }),
        },
      });
    } catch (e) {
      append({ kind: "error", text: (e as Error)?.message ?? String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="ca">
      <header className="ca-hd">
        <span className="ca-title">Coding agent</span>
        <span className="ca-sub">{catalogToTools(catalog).length} tools (your grants)</span>
      </header>

      <input
        className="ca-key"
        type="password"
        placeholder="Anthropic API key (BYOK — stays in this app)"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        aria-label="Anthropic API key"
      />

      <div className="ca-prompt-row">
        <input
          className="ca-prompt"
          placeholder="Ask the agent to do something with your granted tools…"
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
                <code>{e.name}</code> {e.isError ? "✗" : "✓"} <code className="ca-args">{e.content}</code>
              </span>
            )}
            {e.kind === "error" && <span className="ca-err">{e.text}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
