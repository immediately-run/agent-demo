// The transcript rows shared by ConversationStage and the standalone CodingAgent
// (R3-473/R3-474). Renders a `LogEntry[]` as `<li>`s inside the caller's
// `.ca-log` list; the callers keep their own live rows (streaming text, in-flight
// thinking) after these.
//
// Two departures from the old inline rendering:
//   - Tool interactions fold (R3-473): each call+result pair collapses behind a
//     one-line summary (`<details>`, the same pattern as the reasoning rows).
//     An ERROR result renders open by default — a failed call folded away hides
//     exactly what the user needs to see — and stays user-collapsible (React only
//     resets `open` when the prop changes, so a toggle sticks).
//   - Assistant text renders as markdown (R3-474) through the platform's safe
//     renderer — content as DATA, no evaluator — with the raw text as the parse
//     fallback so nothing flashes empty. User turns stay plain: they are typed
//     text, not markup.
import { useMemo } from "react";
import { SafeContent } from "@immediately-run/sdk/safeContent/index";
import type { LogEntry } from "../lib/transcript";
import { toDisplayRows, summarizeToolInput, type ToolCallRow } from "../lib/displayRows";

function ToolCallItem({ row }: { row: ToolCallRow }) {
  const summary = summarizeToolInput(row.input);
  const status = row.result ? (row.result.isError ? "✗" : "✓") : "⋯";
  const statusClass = row.result ? (row.result.isError ? "ca-err" : "ca-ok") : "ca-tool-running";
  return (
    <details className="ca-toolcall" open={row.result?.isError ? true : undefined}>
      <summary>
        <span className={statusClass}>{status}</span> <code>{row.name}</code>
        {summary && <span className="ca-toolcall-arg">{summary}</span>}
      </summary>
      <div className="ca-toolcall-body">
        <pre className="ca-toolcall-pre">{JSON.stringify(row.input, null, 2)}</pre>
        {row.result && (
          <pre className={`ca-toolcall-pre${row.result.isError ? " ca-err" : ""}`}>{row.result.content}</pre>
        )}
      </div>
    </details>
  );
}

export default function TranscriptRows({ log }: { log: readonly LogEntry[] }) {
  const rows = useMemo(() => toDisplayRows(log), [log]);
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "toolcall") {
          return (
            <li key={row.key} className="ca-line ca-tool">
              <ToolCallItem row={row} />
            </li>
          );
        }
        const e = row.entry;
        return (
          <li key={row.key} className={`ca-line ca-${e.kind}`}>
            {e.kind === "user" && <span className="ca-user">{e.text}</span>}
            {e.kind === "text" && (
              <div className="ca-text ca-md">
                <SafeContent source={e.text} fallback={<span className="ca-text">{e.text}</span>} />
              </div>
            )}
            {/* An orphan result (its call fell off a truncated replay) — still shown. */}
            {e.kind === "result" && (
              <span className={e.isError ? "ca-err" : "ca-ok"}>
                <code>{e.name}</code> {e.isError ? "✗" : "✓"} <code className="ca-args">{e.content}</code>
              </span>
            )}
            {e.kind === "error" && <span className="ca-err">{e.text}</span>}
            {e.kind === "nudge" && <span className="ca-nudge">↺ nudging the model to continue…</span>}
            {e.kind === "compaction" && (
              <span className="ca-compaction" title={e.summary}>
                ⚑ compacted earlier turns to stay within the context window
              </span>
            )}
            {e.kind === "steer" && (
              <span className="ca-steer">
                {e.mode === "interrupt" ? "⟂ interrupted and steered:" : "↳ steered:"} {e.text}
              </span>
            )}
            {e.kind === "interrupted" && <span className="ca-interrupted">⟂ turn interrupted by you</span>}
            {e.kind === "reasoning" && (
              <details className="ca-reasoning">
                <summary>{e.redacted ? "thinking (redacted by the provider)" : "thinking"}</summary>
                {!e.redacted && <span className="ca-reasoning-body">{e.text}</span>}
              </details>
            )}
            {e.kind === "image" && (
              <img
                className="ca-image"
                src={`data:${e.mimeType};base64,${e.data}`}
                alt="Image the agent read from the workspace"
              />
            )}
          </li>
        );
      })}
    </>
  );
}
