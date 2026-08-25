// git-READ tools (R3-332 / AHG-T2-2): `git_status`, `git_log`, `git_diff`.
//
// WHY. The agent could write files and it could `contribute` them; it could not read
// what it had changed. `contribute` is a write-only surface, so nothing in the loop
// answered the questions that precede any competent handoff: what did I touch, is
// anything half-finished, did that `edit_file` land where I meant it. The review's
// phrasing is the whole case — *"the gate is only as good as the agent seeing its
// diff"* — and it is also the cheapest fix for a class of silent errors, because a
// slightly-wrong `edit_file`/`replace_all` still builds and still typechecks.
//
// SHAPE. Diagnostics-shaped (R3-74), not a new channel: the HOST holds the
// capability and the app receives DATA. `git_status`/`git_log` read the `vcs:read`
// push channel the host already projects (`getVcsState()`); `git_diff` calls the
// host's `vcs:diff` catalog method, which renders the SAME `DiffResult` the
// contribute modal shows into unified-diff text.
//
// READ-ONLY, deliberately. Branching, staging and commit shaping stay where they
// are — the host-owned `contribute` action, and GitHub for anything resembling
// conflict resolution (product value 7). This adds sight, not new write paths.
// `vcs:reset` — the destructive vcs verb — is first-party-`panel.contribute`-only
// and is not reachable from here at all.

import { getVcsState, invoke, type ApiMethod, type VcsState } from '@immediately-run/sdk';
import type { ToolExecutor } from './agentLoop';
import type { Toolset } from './toolset';
import { normalizePosix } from './fsTools';

/** The host `vcs:diff` reply (site-main `UnifiedDiffResult`). */
export interface VcsDiffReply {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextOffset: number | null;
  files: Array<{ path: string; status: string; rendered: string }>;
}

export interface GitToolsOptions {
  /** The app's grant-filtered §5.5 catalog — the source of truth for whether this
   *  app holds `vcs:read` at all. */
  catalog: ApiMethod[];
  /** Reads the current source-control snapshot. Defaults to the SDK host channel. */
  readState?: () => VcsState;
  /** Calls a host catalog method. Defaults to the SDK `invoke`. */
  call?: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

/** The catalog name of the host's diff method (`protocol-vcs` → `vcs:`). */
export const VCS_DIFF_METHOD = 'vcs:diff';

/**
 * Does this app hold `vcs:read`? Decided from the CATALOG, which is already
 * capability-filtered host-side — so "the tool is absent when the grant is absent"
 * falls out of the same source the platform tools use, rather than a second list
 * that could drift (T24/G12).
 */
export const hasVcsRead = (catalog: ApiMethod[]): boolean =>
  catalog.some((m) => m.capability === 'vcs:read');

/** Normalise a model-supplied repo-relative path, or `null` if it escapes the tree.
 *  The host enforces the same rule; doing it here too means an escape never even
 *  becomes a host call (defense in depth, exactly like `fsTools.resolveWithin`). */
export function normalizeRepoPath(p: string): string | null {
  const collapsed = normalizePosix(p.startsWith('/') ? p : `/${p}`);
  // `normalizePosix` pops `..` past the root silently, so re-derive the escape by
  // checking whether the input tried to climb out of it.
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  let depth = 0;
  for (const s of segs) {
    if (s === '..') {
      if (depth === 0) return null;
      depth--;
    } else depth++;
  }
  return collapsed.replace(/^\//, '');
}

const STATUS_LETTER: Record<string, string> = { created: 'A', modified: 'M', deleted: 'D' };

/** Render `getVcsState()` as a `git status`-shaped block. */
export function formatStatus(state: VcsState): string {
  const lines: string[] = [];
  if (state.branch) {
    lines.push(
      `On branch ${state.branch.name} (based on ${state.branch.parentRepo}@${state.branch.parentRef})`,
    );
  } else {
    lines.push('No immediately.run branch yet — changes are held in the working tree.');
  }
  if (state.diffLoading) lines.push('(the host is still recomputing the diff — counts may be incomplete)');
  if (state.changes.length === 0) {
    lines.push('', 'No changes in the working tree.');
    return lines.join('\n');
  }
  lines.push('', `${state.changes.length} changed path(s):`);
  for (const c of state.changes) {
    lines.push(`${STATUS_LETTER[c.status] ?? '?'} ${c.path}`);
  }
  return lines.join('\n');
}

/** Render the branch lineage — "what is this working tree based on". */
export function formatLog(state: VcsState): string {
  if (!state.branch) {
    return (
      'This working tree is not on an immediately.run branch yet, so there is no ' +
      'branch lineage to report. Changes still show in `git_status`.'
    );
  }
  const b = state.branch;
  const lines = [
    `branch:  ${b.name}`,
    `based on: ${b.parentRepo}@${b.parentRef}`,
    `base commit: ${b.parentCommitSha}`,
    `push access to upstream: ${b.upstreamPushable === null ? 'still being probed' : b.upstreamPushable ? 'yes' : 'no'}`,
  ];
  if (state.prs.length) {
    lines.push('', `${state.prs.length} pull request(s) open from this branch:`);
    for (const pr of state.prs) {
      lines.push(`  #${pr.number} ${pr.state}${pr.draft ? ' (draft)' : ''} — ${pr.title}\n    ${pr.url}`);
    }
  } else {
    lines.push('', 'No pull request open from this branch yet.');
  }
  lines.push(
    '',
    'Only the branch lineage is available here — immediately.run works from a working ' +
      'tree over a base commit, not a local commit history.',
  );
  return lines.join('\n');
}

/** Render a `vcs:diff` reply, with the honest truncation notice `read_file` uses. */
export function formatDiff(reply: VcsDiffReply): string {
  const notes: string[] = [];
  for (const f of reply.files) {
    if (f.rendered === 'ok') continue;
    notes.push(
      f.rendered === 'binary'
        ? `${f.path}: binary — no textual diff`
        : f.rendered === 'too-large'
          ? `${f.path}: too large to diff`
          : `${f.path}: prior version unreadable — diff unavailable`,
    );
  }
  if (reply.totalLines === 0) {
    const empty = reply.files.length
      ? 'No textual diff for the paths in scope.'
      : 'No changes in the working tree.';
    return notes.length ? `${empty}\n\n${notes.join('\n')}` : empty;
  }
  const parts = [reply.text];
  if (notes.length) parts.push(`[not diffed]\n${notes.join('\n')}`);
  if (reply.nextOffset !== null) {
    parts.push(
      `[showing lines ${reply.startLine}–${reply.endLine} of ${reply.totalLines}; ` +
        `continue with offset=${reply.nextOffset}]`,
    );
  } else if (reply.startLine > 1) {
    parts.push(`[lines ${reply.startLine}–${reply.endLine} of ${reply.totalLines} — end of diff]`);
  }
  return parts.join('\n\n');
}

const isDiffReply = (v: unknown): v is VcsDiffReply =>
  !!v && typeof v === 'object' && typeof (v as VcsDiffReply).text === 'string' && Array.isArray((v as VcsDiffReply).files);

/**
 * Build the git-read {@link Toolset}.
 *
 * Returns an EMPTY toolset when the app does not hold `vcs:read`, so the three
 * tools are simply ABSENT from the model's list rather than present-and-failing —
 * the T24/G12 confinement invariant the other catalog tools follow.
 */
export function createGitToolset(opts: GitToolsOptions): Toolset {
  if (!hasVcsRead(opts.catalog)) {
    return { tools: [], execute: async () => ({ content: 'forbidden: no vcs:read grant', isError: true }) };
  }
  const readState = opts.readState ?? getVcsState;
  const call = opts.call ?? ((name, params) => invoke(name, params));

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>> = {
    async git_status() {
      return { content: formatStatus(readState()) };
    },
    async git_log() {
      return { content: formatLog(readState()) };
    },
    async git_diff(input) {
      const params: Record<string, unknown> = {};
      if (typeof input.path === 'string' && input.path !== '') {
        const rel = normalizeRepoPath(input.path);
        // An escaping path is refused HERE — it never becomes a host call.
        if (rel === null) return { content: 'not found', isError: true };
        params.path = rel;
      }
      for (const key of ['offset', 'limit'] as const) {
        const v = input[key];
        if (v === undefined || v === null) continue;
        const n = Math.trunc(Number(v));
        if (!Number.isFinite(n)) return { content: `${key} must be a number`, isError: true };
        params[key] = n;
      }
      const reply = await call(VCS_DIFF_METHOD, params);
      if (!isDiffReply(reply)) return { content: 'the host returned no diff', isError: true };
      return { content: formatDiff(reply) };
    },
  };

  const tools: Toolset['tools'] = [
    {
      name: 'git_status',
      description:
        'List every path you have changed in this working tree (added / modified / deleted) and the branch it sits on. ' +
        'Read-only, no arguments. Call it before proposing a contribution to see the whole shape of what you changed.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'git_log',
      description:
        'Report what this working tree is based on: the branch, the upstream repo and ref, the base commit, and any open pull request. ' +
        'Read-only, no arguments.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'git_diff',
      description:
        'Read your accumulated changes as a unified diff — the same change `contribute` would send. ' +
        'Use it to REVIEW your own work before proposing it, and to check that an `edit_file` landed where you meant. ' +
        'Scope it with `path`, and page a large diff with `offset`/`limit`: when the diff is cut short the result names the exact `offset=` to continue from.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file or directory to scope the diff to. Omit for everything.' },
          offset: { type: 'integer', description: '1-indexed first line of the diff to return (default 1).' },
          limit: { type: 'integer', description: 'How many lines to return from `offset`.' },
        },
        additionalProperties: false,
      },
    },
  ];

  const execute: ToolExecutor = async (name, input) => {
    const handler = handlers[name];
    if (!handler) return { content: `forbidden: "${name}" is not a git tool`, isError: true };
    try {
      return await handler(input);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const msg = (e as Error)?.message ?? String(e);
      return { content: code ? `${code}: ${msg}` : msg, isError: true };
    }
  };

  return { tools, execute };
}
