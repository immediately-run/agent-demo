// Diagnostics tool (LLM_AND_AGENTS_SPEC §3.3, R3-74 `diagnostics:read`). A
// read-only tool that hands the model the previewed app's build/transpile errors
// and captured console warnings/errors, so it can notice a broken build and fix it
// before declaring the task done.
//
// Backed by the host diagnostics channel (SDK `getDiagnostics`), gated by
// `diagnostics:read`: without the grant the host answers the empty snapshot, so the
// tool DEGRADES to "no diagnostics available" rather than crashing — like fsTools
// with no mount (plan 06-C). The channel is scoped to the paired previewed app, so
// there is no cross-app bleed (R3-74 exit criteria); this app-local tool adds no new
// authority beyond the `diagnostics:read` grant the app already holds.

import { getDiagnostics, type Diagnostics } from '@immediately-run/sdk';
import type { ToolExecutor } from './agentLoop';
import type { Toolset } from './toolset';

export interface DiagnosticsToolsOptions {
  /** The current diagnostics snapshot reader. Defaults to the SDK host channel
   *  (`getDiagnostics`); injected in tests. */
  read?: () => Diagnostics;
}

// Cap how much we spill into a tool result — a wedged app can emit hundreds of
// console lines, and the model only needs enough to locate the problem.
const MAX_ITEMS = 50;

const errLoc = (e: Diagnostics['buildErrors'][number]): string => {
  if (!e.path) return '(no location)';
  if (e.line == null) return e.path;
  return `${e.path}:${e.line}${e.column != null ? `:${e.column}` : ''}`;
};

/** Render a diagnostics snapshot to a compact, model-legible text block. */
export function formatDiagnostics(d: Diagnostics): string {
  const parts: string[] = [];

  const errs = d.buildErrors ?? [];
  if (errs.length) {
    const shown = errs.slice(0, MAX_ITEMS).map((e) => `${errLoc(e)} — ${e.message}`);
    parts.push(`${errs.length} build error(s):\n${shown.join('\n')}`);
    if (errs.length > MAX_ITEMS) parts.push(`…and ${errs.length - MAX_ITEMS} more build error(s).`);
  } else {
    parts.push('No build errors — the app compiles.');
  }

  const noisy = (d.consoleEntries ?? []).filter((c) => c.level === 'error' || c.level === 'warn');
  if (noisy.length) {
    const shown = noisy.slice(0, MAX_ITEMS).map((c) => `[${c.level}] ${c.text}`);
    parts.push(`${noisy.length} console warning/error(s):\n${shown.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the diagnostics {@link Toolset}: a single read-only `get_diagnostics` tool.
 * The reader defaults to the SDK host channel; a missing `diagnostics:read` grant
 * yields the empty snapshot, so the tool degrades gracefully.
 */
export function createDiagnosticsToolset(opts: DiagnosticsToolsOptions = {}): Toolset {
  const read = opts.read ?? getDiagnostics;

  const tools: Toolset['tools'] = [
    {
      name: 'get_diagnostics',
      description:
        "Read the previewed app's current build/transpile errors and captured console " +
        'warnings/errors. Read-only — takes no arguments. Call it after writing files to ' +
        'confirm the app still compiles, and before declaring the task done: fix any build ' +
        'error it reports. Returns an empty result when no app is being previewed or ' +
        "diagnostics aren't available.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const execute: ToolExecutor = async (name) => {
    if (name !== 'get_diagnostics') {
      return { content: `forbidden: "${name}" is not a diagnostics tool`, isError: true };
    }
    try {
      return { content: formatDiagnostics(read()) };
    } catch (e) {
      return { content: (e as Error)?.message ?? String(e), isError: true };
    }
  };

  return { tools, execute };
}
