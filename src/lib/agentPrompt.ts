// The agent's system prompt, GENERATED from the live toolset + a host-authored
// platform-rules block + environment grounding (R3-221 / AHG-2). Shared by both
// surfaces (the standalone CodingAgent and the conversation Stage) so the two never
// drift.
//
// Why generated, not a static string (GAP_ANALYSIS §4):
//   (a) the old static prompt NAMED tools that may not be granted (`authoring__*`
//       "when granted") — so with the grant absent it misdescribed the toolset.
//       Now the "Available tools" section is generated from the ACTUAL merged
//       AgentTool[] the loop will send, so it never advertises a tool the app
//       didn't get.
//   (b) the old prompt never told the model the immediately.run HARD RULES (App.tsx
//       is the entry, no `import.meta`, one component per file, CSS-from-App.tsx),
//       so an in-browser agent shipped apps that pass `vite dev` but break on
//       immediately.run. These are PLATFORM INVARIANTS = host knowledge (they are
//       already trusted constants in this app's own `projectTools.ts` scaffold), so
//       the block is host-authored and ALWAYS trusted — no trust gate (F5).
//
// The actual *authority* is still the grant-filtered catalog + mount chroot
// (G12/T24), not this prose. NOTE: ingesting the *stage app's* own `CLAUDE.md` is a
// SEPARATE, trust-gated slice (R3-221c) and is deliberately NOT done here — that is
// app-authored content and a prompt-injection surface that must be fenced-as-data
// tiered by source trust; this file only ever emits HOST-authored text.

/** A tool as the prompt needs to describe it — just its name + one-line description.
 *  Structurally satisfied by `AgentTool` (name + description + input_schema). */
export interface PromptTool {
  name: string;
  description: string;
}

/** Everything the generated prompt needs. All fields the caller can cheaply supply;
 *  none is app-authored (host/parent-owned only), so the assembled prompt carries no
 *  untrusted instruction bytes. */
export interface PromptContext {
  /** The ACTUAL merged tool list the loop will send. The "Available tools" section is
   *  generated from exactly these, so the prompt never names a tool the app lacks. */
  tools: PromptTool[];
  /** The workspace mount root the fs tools are chrooted to (env grounding). */
  workspaceRoot?: string;
  /** Current date as `YYYY-MM-DD`. Passed in (not read from `new Date()` here) so the
   *  function stays pure + deterministically testable. */
  today?: string;
  /** The route/entry currently shown, if known (host/parent-owned, untainted). Route
   *  wiring is spec'd-not-yet-exposed as a simple getter; included when a caller has it. */
  route?: string;
}

// The host-authored immediately.run hard rules — platform invariants, NOT app bytes.
// Kept in lock-step with the `projectTools.ts` scaffold (`APP_TSX`/`MAIN_TSX` comments
// cite the same "CLAUDE.md rule 1"). Always trusted; safe to ship un-gated (F5).
const PLATFORM_RULES: string[] = [
  'immediately.run renders the DEFAULT EXPORT of `src/App.tsx` — that file is the entry point. Keep all app logic reachable from `App.tsx`.',
  '`src/main.tsx` / `index.html` are for LOCAL dev/build only and are IGNORED at runtime — never rely on them to wire up the app.',
  'NEVER use `import.meta` (e.g. `import.meta.env`, `import.meta.url`) — it is unavailable in the sandbox and will break the app.',
  'One React component per file (Fast Refresh): a component module should export only components. Put hooks/helpers/constants in their own files.',
  'Import global CSS from `App.tsx` (e.g. `import "./index.css"`), not from `main.tsx` or `index.html`.',
  'Declare every npm package you import with `add_dependency` (no install runs — it resolves on the next build). Do not hand-edit `package.json` versions.',
  'Use the immediately.run SDK (`@immediately-run/sdk`) for platform features; ordinary React/TS otherwise "just works".',
];

// Static workflow guidance (kept from the old prompt — it was good on *workflow*).
// Crucially it no longer NAMES specific optional tools (authoring__*); it refers to
// "the verify/typecheck tools when present", and the generated tool list is the
// source of truth for what actually exists.
const WORKFLOW_GUIDANCE: string[] = [
  'Explore before you edit: use `list_dir`/`glob`/`grep` and `read_file` to understand the code first.',
  'Use `write_file` for a NEW file or a full rewrite; to change part of an EXISTING file use `edit_file` (replace an exact, unique snippet) — never regenerate a large file just to add a few lines.',
  'To read a file larger than one window, page it with `read_file` `offset`/`limit` and follow the `continue with offset=` notice until you have the whole file.',
  'After editing, verify: run the typecheck/lint/format tools if they are in your tool list, and call `get_diagnostics` to confirm the app still builds; fix reported diagnostics before declaring the task done.',
  'If a tool returns `forbidden`, the app lacks that grant — do NOT retry it; explain what is missing instead.',
  'When the task is complete, say so plainly in one line and stop.',
];

/**
 * Assemble the system prompt from live context. Pure + deterministic (no `Date.now`),
 * so it is unit-testable and the two surfaces share one source of truth.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(
    'You are a coding agent embedded in an immediately.run app. You build and edit ' +
      'web apps in the browser using the tools below.',
  );

  sections.push(
    'immediately.run platform rules (these apps break `vite dev`-passing code that ignores them):\n' +
      PLATFORM_RULES.map((r) => `- ${r}`).join('\n'),
  );

  const env: string[] = [];
  if (ctx.today) env.push(`- Date: ${ctx.today}`);
  if (ctx.workspaceRoot) env.push(`- Workspace root: ${ctx.workspaceRoot} (paths you pass to file tools are relative to it)`);
  if (ctx.route) env.push(`- Current route: ${ctx.route}`);
  if (env.length) sections.push('Environment:\n' + env.join('\n'));

  // (a) The tool list is GENERATED from the actual toolset — never a static list.
  const toolLines = ctx.tools.length
    ? ctx.tools.map((t) => `- ${t.name}: ${firstLine(t.description)}`).join('\n')
    : '(no tools available)';
  sections.push('Available tools:\n' + toolLines);

  sections.push('How to work:\n' + WORKFLOW_GUIDANCE.map((g) => `- ${g}`).join('\n'));

  return sections.join('\n\n');
}

/** One-line-clamp a tool description so the generated list stays scannable. */
function firstLine(desc: string): string {
  const oneLine = desc.replace(/\s+/g, ' ').trim();
  return oneLine.length > 220 ? oneLine.slice(0, 217) + '…' : oneLine;
}

/** Today's date as `YYYY-MM-DD` for env grounding (impure — call at the run site). */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
