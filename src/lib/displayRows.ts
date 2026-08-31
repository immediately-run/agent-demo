// Transcript display rows (R3-473). The raw `LogEntry` stream renders tool
// interactions fully expanded — a `write_file` round-trip is kilobytes of JSON
// between two sentences of reply — so the UI folds each tool call behind a
// one-line summary, expandable on demand. This module is the pure half: pair
// every `tool` entry with the `result` it produced, and derive the one argument
// worth showing while folded. Rendering (the `<details>` rows) lives in
// `components/TranscriptRows.tsx`; both live appends and a replayed conversation
// feed the same `LogEntry[]`, so one pairing covers both.

import type { LogEntry } from './transcript';

/** A folded tool interaction: the call plus (once it lands) its result. */
export interface ToolCallRow {
  kind: 'toolcall';
  /**
   * Stable React key: the index of the `tool` entry in the source log. Indexes of
   * LATER rows shift when a result merges into its call, so the row identity has
   * to come from the entry that opened it or an open `<details>` would jump rows.
   */
  key: number;
  name: string;
  input: Record<string, unknown>;
  /** Absent while the call is in flight (live) — the row renders as running. */
  result?: { content: string; isError?: boolean };
}

/** A row of the transcript as displayed: a passthrough entry or a folded tool call. */
export type DisplayRow = { kind: 'entry'; key: number; entry: LogEntry } | ToolCallRow;

/**
 * Pair tool calls with their results. Adjacency is NOT enough: a parallel-tool
 * turn emits `tool A, tool B, result A, result B` (all `tool_use` blocks of the
 * assistant message precede the `tool_result`s of the reply), so each result
 * attaches to the EARLIEST unresulted call of the same name — results arrive in
 * call order, which `transcript.ts` preserves. A result whose call is missing
 * (a truncated replay) stays a passthrough row rather than being dropped.
 */
export function toDisplayRows(log: readonly LogEntry[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const unresulted = new Map<string, ToolCallRow[]>();
  log.forEach((entry, i) => {
    if (entry.kind === 'tool') {
      const row: ToolCallRow = { kind: 'toolcall', key: i, name: entry.name, input: entry.input };
      rows.push(row);
      const queue = unresulted.get(entry.name) ?? [];
      queue.push(row);
      unresulted.set(entry.name, queue);
    } else if (entry.kind === 'result') {
      const row = unresulted.get(entry.name)?.shift();
      if (row) row.result = { content: entry.content, isError: entry.isError };
      else rows.push({ kind: 'entry', key: i, entry });
    } else {
      rows.push({ kind: 'entry', key: i, entry });
    }
  });
  return rows;
}

// The argument worth showing while folded, tried in order. `from` pairs with
// `to` (move/copy read as a rename); `old_string` identifies an edit better than
// nothing when there is no path… there always is, so it stays off this list.
const SUMMARY_KEYS = ['path', 'pattern', 'glob', 'skill', 'query', 'url', 'command', 'method', 'name', 'title', 'id'] as const;
const SUMMARY_MAX = 72;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one;
};

/**
 * One short line identifying a call while folded: its most salient argument
 * (`path` for the file tools, `pattern` for glob/grep, `from → to` for
 * move/copy…), falling back to the first string argument, or nothing for a
 * no-argument call. Never the whole input — that is what expanding is for.
 */
export function summarizeToolInput(input: Record<string, unknown>): string {
  const from = input['from'];
  const to = input['to'];
  if (typeof from === 'string' && typeof to === 'string') return clip(`${from} → ${to}`);
  for (const key of SUMMARY_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return clip(v);
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return clip(v);
  }
  return '';
}
