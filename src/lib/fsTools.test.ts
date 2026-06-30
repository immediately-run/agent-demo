import { describe, it, expect } from 'vitest';
import { createFsToolset, resolveWorkingTreeMount, findConferredWorktree, type FsLike, type FsDirent, type FsStat } from './fsTools';

// AA-23: the workbench agent must author the STAGE app's conferred working tree
// (`type:'worktree'`), NOT its own repo — targeting `getAppMountPath()` was the bug
// that made it read `not found` for every grove path.
describe('resolveWorkingTreeMount (standalone, self-fallback)', () => {
  const OWN = '/mnt/own-agent-repo';

  it('targets the conferred stage-app worktree by identity (rw), not the agent\'s own repo', () => {
    const mounts = [
      { path: OWN, type: 'repo', mode: 'rw' as const },
      { path: '/mnt/stage-grove', type: 'worktree', mode: 'rw' as const },
    ];
    expect(resolveWorkingTreeMount(mounts, OWN)).toEqual({ root: '/mnt/stage-grove', readOnly: false });
  });

  it('honors a read-only conferred worktree', () => {
    const mounts = [{ path: '/mnt/stage-grove', type: 'worktree', mode: 'ro' as const }];
    expect(resolveWorkingTreeMount(mounts, OWN)).toEqual({ root: '/mnt/stage-grove', readOnly: true });
  });

  it('falls back to the agent\'s own repo when no worktree is conferred (standalone agent)', () => {
    const mounts = [{ path: OWN, type: 'repo', mode: 'rw' as const }];
    expect(resolveWorkingTreeMount(mounts, OWN)).toEqual({ root: OWN, readOnly: false });
  });

  it('fallback reports read-only when the own repo is ro', () => {
    const mounts = [{ path: OWN, type: 'repo', mode: 'ro' as const }];
    expect(resolveWorkingTreeMount(mounts, OWN)).toEqual({ root: OWN, readOnly: true });
  });

  it('fallback to appMountPath even when the own mount is absent from the list', () => {
    expect(resolveWorkingTreeMount([], OWN)).toEqual({ root: OWN, readOnly: false });
  });
});

// The stage agent uses findConferredWorktree and REFUSES (null) rather than ever
// authoring its own repo — the fix for the "silently authors itself" failure.
describe('findConferredWorktree (stage agent — never self)', () => {
  const OWN = '/mnt/own-agent-repo';

  it('returns the conferred stage tree (a worktree that is NOT the agent\'s own)', () => {
    const mounts = [
      { path: OWN, type: 'worktree', mode: 'rw' as const }, // the agent's OWN dual-mount
      { path: '/mnt/stage-grove', type: 'worktree', mode: 'rw' as const },
    ];
    // Even though BOTH are worktrees, it must pick the one that isn't the agent's own.
    expect(findConferredWorktree(mounts, OWN)).toEqual({ root: '/mnt/stage-grove', readOnly: false });
  });

  it('returns null when the ONLY worktree is the agent\'s own (collision → no stage tree)', () => {
    // The dev-override / dual-mount case that made the workbench author itself.
    const mounts = [{ path: OWN, type: 'worktree', mode: 'rw' as const }];
    expect(findConferredWorktree(mounts, OWN)).toBeNull();
  });

  it('returns null when no worktree is conferred at all (does NOT fall back to self)', () => {
    expect(findConferredWorktree([{ path: OWN, type: 'repo', mode: 'rw' as const }], OWN)).toBeNull();
    expect(findConferredWorktree([], OWN)).toBeNull();
  });
});

// A tiny in-memory fs implementing the FsLike subset the tools use. Paths are
// absolute POSIX. Good enough to exercise chroot resolution, walking, and the
// read-only / not-found branches without touching a real disk.
class MemFs implements FsLike {
  files = new Map<string, string>();
  dirs = new Set<string>(['/']);
  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) this.put(p, c);
  }
  put(p: string, c: string) {
    this.files.set(p, c);
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }
  private err(code: string): Error {
    return Object.assign(new Error(code), { code });
  }
  async readFile(path: string): Promise<string> {
    if (this.dirs.has(path) && !this.files.has(path)) throw this.err('EISDIR');
    if (!this.files.has(path)) throw this.err('ENOENT');
    return this.files.get(path)!;
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.put(path, data);
  }
  async mkdir(path: string): Promise<unknown> {
    let d = path;
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
    return undefined;
  }
  async readdir(path: string): Promise<FsDirent[]> {
    if (!this.dirs.has(path)) throw this.err(this.files.has(path) ? 'ENOTDIR' : 'ENOENT');
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (f.startsWith(prefix) && f !== path) names.add(f.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((name) => {
      const abs = prefix + name;
      const isDir = this.dirs.has(abs);
      return { name, isDirectory: () => isDir };
    });
  }
  async stat(path: string): Promise<FsStat> {
    if (this.files.has(path)) {
      const size = this.files.get(path)!.length;
      return { size, mtimeMs: 1, isFile: () => true, isDirectory: () => false };
    }
    if (this.dirs.has(path)) return { size: 0, mtimeMs: 1, isFile: () => false, isDirectory: () => true };
    throw this.err('ENOENT');
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw this.err('ENOENT');
  }
}

const seed = () =>
  new MemFs({
    '/app/package.json': '{"name":"x"}',
    '/app/src/App.tsx': 'export default function App(){ return null }\nconst TODO = 1\n',
    '/app/src/lib/util.ts': 'export const add = (a:number,b:number)=>a+b // TODO refactor\n',
    '/etc/secret': 'TOPSECRET',
  });

const ts = (fs: MemFs, readOnly = false) => createFsToolset({ root: '/app', fs, readOnly });

describe('fsTools — mount-chroot filesystem tools (§3.3 phase 2)', () => {
  it('exposes the eight file tools', () => {
    const names = ts(seed()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['delete_file', 'edit_file', 'glob', 'grep', 'list_dir', 'read_file', 'stat', 'write_file']);
  });

  it('read_file returns content; missing path → not found', async () => {
    const { execute } = ts(seed());
    expect(await execute('read_file', { path: 'package.json' })).toEqual({ content: '{"name":"x"}' });
    const miss = await execute('read_file', { path: 'nope.ts' });
    expect(miss).toEqual({ content: 'not found', isError: true });
  });

  it('a leading-slash path is workspace-root-relative, not filesystem-absolute', async () => {
    // The app sees its mount as "/"; "/package.json" means <root>/package.json,
    // matching how models naturally address files (and how list_dir reports them).
    const { execute } = ts(seed());
    expect(await execute('read_file', { path: '/package.json' })).toEqual({ content: '{"name":"x"}' });
    expect(await execute('read_file', { path: '/src/App.tsx' })).toEqual({
      content: 'export default function App(){ return null }\nconst TODO = 1\n',
    });
  });

  it('write_file creates parents and writes; reports bytes', async () => {
    const fs = seed();
    const res = await ts(fs).execute('write_file', { path: 'src/new/x.ts', content: 'hello' });
    expect(res.isError).toBeUndefined();
    expect(fs.files.get('/app/src/new/x.ts')).toBe('hello');
  });

  it('write_file and delete_file are refused on a read-only mount (no raw EROFS)', async () => {
    const fs = seed();
    const w = await ts(fs, true).execute('write_file', { path: 'src/App.tsx', content: 'x' });
    expect(w).toMatchObject({ isError: true });
    expect(w.content).toContain('read-only');
    const d = await ts(fs, true).execute('delete_file', { path: 'src/App.tsx' });
    expect(d).toMatchObject({ isError: true });
    // unchanged
    expect(fs.files.has('/app/src/App.tsx')).toBe(true);
  });

  it('list_dir lists directories first, then files', async () => {
    const { content } = await ts(seed()).execute('list_dir', { path: 'src' });
    expect(content).toBe('lib/\nApp.tsx');
  });

  it('stat reports type and size', async () => {
    const { content } = await ts(seed()).execute('stat', { path: 'package.json' });
    expect(JSON.parse(content)).toMatchObject({ path: 'package.json', type: 'file' });
  });

  it('glob matches across the tree', async () => {
    const { content } = await ts(seed()).execute('glob', { pattern: 'src/**/*.ts' });
    expect(content.split('\n').sort()).toEqual(['src/lib/util.ts']);
    const tsx = await ts(seed()).execute('glob', { pattern: 'src/*.tsx' });
    expect(tsx.content).toBe('src/App.tsx');
  });

  it('grep returns path:line: text hits', async () => {
    const { content } = await ts(seed()).execute('grep', { pattern: 'TODO' });
    const lines = content.split('\n').sort();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^src\/App\.tsx:2: /);
    expect(lines[1]).toMatch(/^src\/lib\/util\.ts:1: /);
  });

  it('delete_file removes a file', async () => {
    const fs = seed();
    const res = await ts(fs).execute('delete_file', { path: 'package.json' });
    expect(res.isError).toBeUndefined();
    expect(fs.files.has('/app/package.json')).toBe(false);
  });

  it('cannot escape the chroot via .. or an absolute outside path (T24)', async () => {
    const { execute } = ts(seed());
    expect(await execute('read_file', { path: '../etc/secret' })).toEqual({ content: 'not found', isError: true });
    expect(await execute('read_file', { path: '/etc/secret' })).toEqual({ content: 'not found', isError: true });
    expect(await execute('read_file', { path: 'src/../../etc/secret' })).toEqual({ content: 'not found', isError: true });
  });

  it('an unknown tool name is forbidden without touching fs', async () => {
    const res = await ts(seed()).execute('rm_rf', {});
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toContain('forbidden');
  });
});

// edit_file — the surgical string-replace that lets the agent change part of a large
// file without regenerating the whole thing (the fix for the big-file write_file stall).
describe('edit_file', () => {
  it('replaces a unique snippet in place without rewriting the whole file', async () => {
    const fs = seed();
    const res = await ts(fs).execute('edit_file', {
      path: 'src/lib/util.ts',
      old_string: '(a:number,b:number)=>a+b',
      new_string: '(a:number,b:number)=>a + b',
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('1 replacement');
    expect(fs.files.get('/app/src/lib/util.ts')).toBe('export const add = (a:number,b:number)=>a + b // TODO refactor\n');
  });

  it('inserts by anchoring: old_string → anchor + addition (large-file insert)', async () => {
    const fs = seed();
    // Simulate adding a CSS rule after an existing one without resending the file.
    fs.put('/app/src/GroveApp.css', '.grove-quote { color: red; }\n/* code block */\n');
    const res = await ts(fs).execute('edit_file', {
      path: 'src/GroveApp.css',
      old_string: '.grove-quote { color: red; }\n',
      new_string: '.grove-quote { color: red; }\n.grove-keyvalue { margin: 1rem 0; }\n',
    });
    expect(res.isError).toBeUndefined();
    expect(fs.files.get('/app/src/GroveApp.css')).toBe(
      '.grove-quote { color: red; }\n.grove-keyvalue { margin: 1rem 0; }\n/* code block */\n',
    );
  });

  it('inserts new_string verbatim — `$` and backslashes are not special (no String.replace pattern surprises)', async () => {
    const fs = seed();
    fs.put('/app/src/money.ts', 'const a = MARK;\n');
    const res = await ts(fs).execute('edit_file', {
      path: 'src/money.ts',
      old_string: 'MARK',
      new_string: "'$1 \\n $& cost'",
    });
    expect(res.isError).toBeUndefined();
    expect(fs.files.get('/app/src/money.ts')).toBe("const a = '$1 \\n $& cost';\n");
  });

  it('refuses a non-unique old_string unless replace_all is set', async () => {
    const fs = seed();
    fs.put('/app/dup.txt', 'x\nx\nx\n');
    const ambiguous = await ts(fs).execute('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y' });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(ambiguous.content).toContain('not unique');
    expect(fs.files.get('/app/dup.txt')).toBe('x\nx\nx\n'); // untouched on refusal

    const all = await ts(fs).execute('edit_file', { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true });
    expect(all.isError).toBeUndefined();
    expect(all.content).toContain('3 replacements');
    expect(fs.files.get('/app/dup.txt')).toBe('y\ny\ny\n');
  });

  it('errors when old_string is not found, leaving the file untouched', async () => {
    const fs = seed();
    const res = await ts(fs).execute('edit_file', { path: 'package.json', old_string: 'nope', new_string: 'x' });
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toContain('not found');
    expect(fs.files.get('/app/package.json')).toBe('{"name":"x"}');
  });

  it('rejects an empty old_string and a no-op (old === new)', async () => {
    const { execute } = ts(seed());
    expect(await execute('edit_file', { path: 'package.json', old_string: '', new_string: 'x' })).toMatchObject({ isError: true });
    expect(await execute('edit_file', { path: 'package.json', old_string: 'x', new_string: 'x' })).toMatchObject({ isError: true });
  });

  it('refuses on a read-only mount and never writes', async () => {
    const fs = seed();
    const res = await ts(fs, true).execute('edit_file', { path: 'package.json', old_string: 'x', new_string: 'y' });
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toContain('read-only');
    expect(fs.files.get('/app/package.json')).toBe('{"name":"x"}');
  });

  it('cannot escape the chroot', async () => {
    const res = await ts(seed()).execute('edit_file', { path: '../etc/secret', old_string: 'TOPSECRET', new_string: 'leak' });
    expect(res).toEqual({ content: 'not found', isError: true });
  });
});
