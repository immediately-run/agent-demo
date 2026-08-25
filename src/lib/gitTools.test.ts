// R3-332 — git-read tools. The exit criteria are decided here (1: the diff is the
// same changeset `contribute` would send; 2: bounded with an explicit continuation;
// 3: absent without the grant; 4: nothing outside the working tree is reachable).

import { describe, it, expect, vi } from 'vitest';
import type { ApiMethod, VcsState } from '@immediately-run/sdk';

vi.mock('@immediately-run/sdk', () => ({ invoke: vi.fn(), getVcsState: vi.fn() }));

import {
  createGitToolset,
  formatDiff,
  formatLog,
  formatStatus,
  hasVcsRead,
  normalizeRepoPath,
  VCS_DIFF_METHOD,
  type VcsDiffReply,
} from './gitTools';

const CATALOG_WITH_VCS: ApiMethod[] = [
  { name: 'vcs:diff', capability: 'vcs:read' },
  { name: 'vcs:refreshDiff', capability: 'vcs:read' },
  { name: 'spaces:share', capability: 'spaces:admin' },
];
const CATALOG_WITHOUT: ApiMethod[] = [
  { name: 'spaces:share', capability: 'spaces:admin' },
  { name: 'contribute:run', capability: 'contribute:self' },
];

const state = (over: Partial<VcsState> = {}): VcsState => ({
  changes: [],
  branch: null,
  prs: [],
  diffLoading: false,
  ...over,
});

const reply = (over: Partial<VcsDiffReply> = {}): VcsDiffReply => ({
  text: '',
  startLine: 1,
  endLine: 0,
  totalLines: 0,
  nextOffset: null,
  files: [],
  ...over,
});

describe('exit 3 — grant-gated, and simply ABSENT when the grant is absent', () => {
  it('detects vcs:read from the capability-filtered catalog, not a second list', () => {
    expect(hasVcsRead(CATALOG_WITH_VCS)).toBe(true);
    expect(hasVcsRead(CATALOG_WITHOUT)).toBe(false);
    expect(hasVcsRead([])).toBe(false);
  });

  it('offers no tools at all without the grant — not present-and-failing', () => {
    const ts = createGitToolset({ catalog: CATALOG_WITHOUT });
    expect(ts.tools).toEqual([]);
  });

  it('offers exactly the three read tools with the grant, and nothing that writes', () => {
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state() });
    expect(ts.tools.map((t) => t.name)).toEqual(['git_status', 'git_log', 'git_diff']);
    // Nothing here NAMES a write verb — this item adds sight, not write paths.
    expect(ts.tools.map((t) => t.name).join(' ')).not.toMatch(/reset|commit|stage|push|checkout|merge/i);
  });

  it('refuses a name it does not own without touching the host', async () => {
    const call = vi.fn();
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state(), call });
    const res = await ts.execute('vcs__reset', {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain('forbidden');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('git_status — the whole shape of what changed', () => {
  it('lists every changed path with its status letter, and the branch it sits on', () => {
    const out = formatStatus(
      state({
        changes: [
          { path: 'src/App.tsx', status: 'modified' },
          { path: 'src/new.ts', status: 'created' },
          { path: 'src/old.ts', status: 'deleted' },
        ],
        branch: {
          name: 'immediately-run/edit-1',
          parentRepo: 'acme/app',
          parentRef: 'main',
          parentCommitSha: 'abc123',
          upstreamPushable: true,
        },
      }),
    );
    expect(out).toContain('On branch immediately-run/edit-1 (based on acme/app@main)');
    expect(out).toContain('3 changed path(s)');
    expect(out).toContain('M src/App.tsx');
    expect(out).toContain('A src/new.ts');
    expect(out).toContain('D src/old.ts');
  });

  it('says so plainly when nothing changed', () => {
    expect(formatStatus(state())).toContain('No changes in the working tree.');
  });

  it('admits when the host is still recomputing rather than reporting a stale count as final', () => {
    expect(formatStatus(state({ diffLoading: true }))).toContain('still recomputing');
  });
});

describe('git_log — what this working tree is based on', () => {
  it('reports branch, upstream, base commit, push access and open PRs', () => {
    const out = formatLog(
      state({
        branch: {
          name: 'ir/edit-2',
          parentRepo: 'acme/app',
          parentRef: 'main',
          parentCommitSha: 'deadbeef',
          upstreamPushable: false,
        },
        prs: [{ number: 7, url: 'https://x/7', title: 'Add a thing', state: 'open', draft: true }],
      }),
    );
    expect(out).toContain('branch:  ir/edit-2');
    expect(out).toContain('based on: acme/app@main');
    expect(out).toContain('deadbeef');
    expect(out).toContain('push access to upstream: no');
    expect(out).toContain('#7 open (draft) — Add a thing');
  });

  it('is honest that there is no local commit history to report', () => {
    const out = formatLog(state({ branch: { name: 'b', parentRepo: 'a/b', parentRef: 'main', parentCommitSha: 's', upstreamPushable: null } }));
    expect(out).toContain('not a local commit history');
    expect(out).toContain('still being probed');
  });

  it('degrades cleanly before a branch exists', () => {
    expect(formatLog(state())).toContain('not on an immediately.run branch yet');
  });
});

describe('exit 1/2 — git_diff reads the accumulated change, bounded and continuable', () => {
  it('passes a scoped, paged request to the host method verbatim', async () => {
    const call = vi.fn(async () => reply({ text: 'diff --git a/x b/x', totalLines: 1, endLine: 1 }));
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state(), call });
    await ts.execute('git_diff', { path: 'src/App.tsx', offset: 5, limit: 20 });
    expect(call).toHaveBeenCalledWith(VCS_DIFF_METHOD, { path: 'src/App.tsx', offset: 5, limit: 20 });
  });

  it('names the exact offset to continue from — never a silent cut', () => {
    const out = formatDiff(reply({ text: 'a\nb', startLine: 1, endLine: 2, totalLines: 400, nextOffset: 3 }));
    expect(out).toContain('[showing lines 1–2 of 400; continue with offset=3]');
  });

  it('says end-of-diff on the last page of a paged read', () => {
    const out = formatDiff(reply({ text: 'z', startLine: 400, endLine: 400, totalLines: 400, nextOffset: null }));
    expect(out).toContain('[lines 400–400 of 400 — end of diff]');
  });

  it('adds no notice at all when the whole diff fitted', () => {
    const out = formatDiff(reply({ text: 'a\nb', startLine: 1, endLine: 2, totalLines: 2, nextOffset: null }));
    expect(out).toBe('a\nb');
  });

  it('reports files it could NOT diff instead of letting them vanish', () => {
    const out = formatDiff(
      reply({
        text: 'diff --git a/a.ts b/a.ts',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        files: [
          { path: 'a.ts', status: 'modified', rendered: 'ok' },
          { path: 'logo.png', status: 'created', rendered: 'binary' },
          { path: 'huge.json', status: 'modified', rendered: 'too-large' },
          { path: 'gone.ts', status: 'deleted', rendered: 'unreadable' },
        ],
      }),
    );
    expect(out).toContain('logo.png: binary');
    expect(out).toContain('huge.json: too large to diff');
    expect(out).toContain('gone.ts: prior version unreadable');
  });

  it('distinguishes "nothing changed" from "nothing changed in this path"', () => {
    expect(formatDiff(reply())).toBe('No changes in the working tree.');
    expect(formatDiff(reply({ files: [{ path: 'a.png', status: 'created', rendered: 'binary' }] }))).toContain(
      'No textual diff for the paths in scope.',
    );
  });

  it('surfaces a host refusal as an error result the model can act on, not a throw', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    });
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state(), call });
    const res = await ts.execute('git_diff', {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain('forbidden');
  });

  it('refuses a non-numeric page argument before calling the host', async () => {
    const call = vi.fn();
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state(), call });
    const res = await ts.execute('git_diff', { offset: 'lots' });
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('exit 4 — a path outside the working tree is unreachable', () => {
  it('normalises inside the tree and REFUSES anything that climbs out', () => {
    expect(normalizeRepoPath('src/./a/../b.ts')).toBe('src/b.ts');
    expect(normalizeRepoPath('/src/App.tsx')).toBe('src/App.tsx');
    expect(normalizeRepoPath('../secrets')).toBeNull();
    expect(normalizeRepoPath('src/../../etc/passwd')).toBeNull();
  });

  it('an escaping path never becomes a host call — it reads back as "not found"', async () => {
    const call = vi.fn(async () => reply());
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state(), call });
    for (const path of ['../../etc/passwd', '/../root/.ssh/id_rsa', 'src/../../x']) {
      const res = await ts.execute('git_diff', { path });
      expect(res).toEqual({ content: 'not found', isError: true });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('git_status and git_log take no path at all — there is nothing to point outward', () => {
    const ts = createGitToolset({ catalog: CATALOG_WITH_VCS, readState: () => state() });
    for (const name of ['git_status', 'git_log']) {
      const schema = ts.tools.find((t) => t.name === name)!.input_schema as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      };
      expect(schema.properties).toEqual({});
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
