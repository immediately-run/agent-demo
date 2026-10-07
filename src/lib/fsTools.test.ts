import { describe, it, expect } from 'vitest';
import { createFsToolset, resolveWorkingTreeMount, findConferredWorktree, BINARY_IMAGE_EXTENSIONS, type FsPortLike, type FsDirent, type FsStat } from './fsTools';

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

  // R3-491: this answers "which tree does the agent author", and NOTHING else. It
  // used to also hand back the mount's `owner/repo` label as the conversation
  // scoping key, which made the panel's scope depend on a filesystem port it should
  // never have needed. Both halves read that key from `useWorkspace()` now, and the
  // label must not come back here — otherwise the coupling silently returns the
  // first time someone reaches for the convenient field.
  it('does NOT return the mount label — the scoping key is not a filesystem fact', () => {
    const mounts = [
      { path: OWN, type: 'worktree', mode: 'rw' as const, name: 'immediately-run/agent-demo' },
      { path: '/mnt/stage-grove', type: 'worktree', mode: 'ro' as const, name: 'neumark-family/recipes' },
    ];
    const conferred = findConferredWorktree(mounts, OWN);
    // Exactly the filesystem facts — a `name`/`repo` field would fail this.
    expect(conferred).toEqual({ root: '/mnt/stage-grove', readOnly: true });
    expect(Object.keys(conferred!).sort()).toEqual(['readOnly', 'root']);
  });
});

// A tiny in-memory fs implementing the FsPortLike subset the tools use. Paths are
// absolute POSIX. Good enough to exercise chroot resolution, walking, and the
// read-only / not-found branches without touching a real disk.
class MemFs implements FsPortLike {
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
  // R3-338 added a BYTE-mode read to the port; the fake mirrors both overloads so a
  // binary round-trip is testable without a real fs.
  async readFile(path: string, encoding?: 'utf8'): Promise<string & Uint8Array> {
    if (this.dirs.has(path) && !this.files.has(path)) throw this.err('EISDIR');
    if (!this.files.has(path)) throw this.err('ENOENT');
    const text = this.files.get(path)!;
    return (encoding === 'utf8' ? text : new TextEncoder().encode(text)) as string & Uint8Array;
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.put(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
  async rename(from: string, to: string): Promise<void> {
    if (!this.files.has(from)) throw this.err('ENOENT');
    this.put(to, this.files.get(from)!);
    this.files.delete(from);
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
  it('exposes the file tools — the original eight plus R3-338\'s three refactoring primitives', () => {
    const names = ts(seed()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'copy_file',
      'delete_file',
      'edit_file',
      'glob',
      'grep',
      'list_dir',
      'move_file',
      'read_file',
      'replace_in_files',
      'stat',
      'write_file',
    ]);
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

describe('read_file offset/limit paging (R3-223)', () => {
  // A 10-line file (no trailing newline) → deterministic line addressing.
  const linesFs = () => new MemFs({ '/app/lines.txt': Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') });

  it('read_file advertises offset/limit in its schema', () => {
    const tool = ts(seed()).tools.find((t) => t.name === 'read_file')!;
    const props = (tool.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('offset');
    expect(props).toHaveProperty('limit');
  });

  it('offset+limit returns exactly the requested line window', async () => {
    const { execute } = ts(linesFs());
    const res = await execute('read_file', { path: 'lines.txt', offset: 3, limit: 2 });
    expect(res.content.split('\n\n')[0]).toBe('L3\nL4'); // exactly lines 3–4
    expect(res.content).toContain('continue with offset=5'); // names the next offset
  });

  it('a window that reaches EOF is marked end-of-file, not "continue"', async () => {
    const { execute } = ts(linesFs());
    const res = await execute('read_file', { path: 'lines.txt', offset: 9, limit: 5 });
    expect(res.content.split('\n\n')[0]).toBe('L9\nL10');
    expect(res.content).toContain('end of file');
    expect(res.content).not.toContain('continue with offset');
  });

  it('offset past EOF returns an explicit empty notice', async () => {
    const { execute } = ts(linesFs());
    const res = await execute('read_file', { path: 'lines.txt', offset: 99 });
    expect(res.content).toContain('past end of file');
  });

  it('omitting offset AND limit preserves verbatim behavior for a small file', async () => {
    const { execute } = ts(seed());
    // No annotation, byte-for-byte content (the fast path).
    expect(await execute('read_file', { path: '/src/App.tsx' })).toEqual({
      content: 'export default function App(){ return null }\nconst TODO = 1\n',
    });
  });

  it('a >READ_CAP file is FULLY readable by paging offset until EOF', async () => {
    // ~98 KB across 1000 lines (each ~97 bytes) — larger than the 64 KB window, so
    // the old whole-file read truncated the tail irrecoverably.
    const NLINES = 1000;
    const original = Array.from({ length: NLINES }, (_, i) => `line ${i + 1} ` + 'x'.repeat(90)).join('\n');
    const { execute } = ts(new MemFs({ '/app/big.txt': original }));

    const collected: string[] = [];
    let offset = 1;
    let guard = 0;
    for (;;) {
      if (guard++ > 100) throw new Error('paging did not terminate');
      const res = await execute('read_file', { path: 'big.txt', offset });
      const body = res.content.replace(/\n\n\[[^\]]*\]$/, ''); // strip the trailing notice
      collected.push(body);
      const m = /continue with offset=(\d+)/.exec(res.content);
      if (!m) break; // reached EOF
      offset = Number(m[1]);
    }
    expect(collected.join('\n')).toBe(original); // every byte recovered
  });
});

// R3-856 — tool calls whose intent is clear are not refused. Three failures
// from one owner session (the movie-night-report build): `edits: []` beside a
// complete pair, grep's `flags: "n"` read as a RegExp flag, and text written
// into an image path after a failed fetch.
describe('fsError unwraps a SuppressedError (R3-1026)', () => {
  // ZenFS disposal wraps the REAL write failure in a SuppressedError whose own
  // message is the constant "An error was suppressed during disposal." — live on
  // the venue 2026-10-07, edit_file surfaced exactly that, twice, and the cause
  // never reached the model.
  const suppressed = (cause: unknown) =>
    Object.assign(new Error('An error was suppressed during disposal.'), {
      suppressed: cause,
      error: new Error('disposal also failed'),
    });
  const throwingFs = (thrown: unknown): MemFs => {
    const fs = seed();
    fs.writeFile = async () => {
      throw thrown;
    };
    return fs;
  };

  it('write_file surfaces the innermost code, not the disposal constant', async () => {
    const cause = Object.assign(new Error('permission on overlay'), { code: 'EACCES' });
    const res = await ts(throwingFs(suppressed(cause))).execute('write_file', { path: 'src/x.ts', content: 'x' });
    expect(res).toEqual({ content: 'read-only: this mount cannot be written', isError: true });
  });

  it('edit_file surfaces the innermost MESSAGE when no cause carries a code', async () => {
    const res = await ts(throwingFs(suppressed(new Error('overlay write failed: backing store vanished')))).execute('edit_file', {
      path: 'src/lib/util.ts',
      old_string: 'TODO refactor',
      new_string: 'cleaned',
    });
    expect(res.isError).toBe(true);
    expect(res.content).toBe('error: overlay write failed: backing store vanished');
    expect(res.content).not.toContain('suppressed during disposal');
  });

  it('a plain (unwrapped) error behaves exactly as before', async () => {
    const res = await ts(throwingFs(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).execute('write_file', {
      path: 'src/x.ts',
      content: 'x',
    });
    expect(res).toEqual({ content: 'ENOSPC: disk full', isError: true });
  });
});

describe('edit_file — an empty edits[] carries no intent (R3-856)', () => {
  it('old_string/new_string with edits: [] applies the single edit', async () => {
    const fs = seed();
    const res = await ts(fs).execute('edit_file', {
      path: 'src/lib/util.ts',
      old_string: '(a:number,b:number)=>a+b',
      new_string: '(a:number,b:number)=>a + b',
      edits: [],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('1 replacement');
    expect(fs.files.get('/app/src/lib/util.ts')).toBe('export const add = (a:number,b:number)=>a + b // TODO refactor\n');
  });

  it('both forms non-empty is refused with the either-or message', async () => {
    const fs = seed();
    const res = await ts(fs).execute('edit_file', {
      path: 'src/lib/util.ts',
      old_string: '(a:number,b:number)=>a+b',
      new_string: '(a:number,b:number)=>a + b',
      edits: [{ old_string: 'TODO refactor', new_string: 'clean up' }],
    });
    expect(res).toEqual({ content: 'pass either old_string/new_string or edits, not both', isError: true });
    // nothing applied — the all-or-nothing rule holds for the refusal too
    expect(fs.files.get('/app/src/lib/util.ts')).toBe('export const add = (a:number,b:number)=>a+b // TODO refactor\n');
  });

  it('neither form is still refused', async () => {
    const res = await ts(seed()).execute('edit_file', { path: 'src/lib/util.ts', edits: [] });
    expect(res).toEqual({
      content: 'edit_file requires a non-empty "old_string" (or an "edits" array)',
      isError: true,
    });
  });
});

describe('grep — flags normalised, not trusted (R3-856)', () => {
  it('flags: "n" returns hits with the ignored note — the transcript case', async () => {
    const { content } = await ts(seed()).execute('grep', { pattern: 'TODO', flags: 'n' });
    const lines = content.split('\n');
    expect(lines).toHaveLength(3); // two hits + the note
    expect(lines[0]).toMatch(/^src\/App\.tsx:2: /);
    expect(lines[2]).toBe('(ignored flags: n — line numbers are always shown)');
  });

  it('flags: "g" over two consecutive matching lines returns both (stateful re.test regression)', async () => {
    const fs = new MemFs({
      '/app/notes.txt': 'alpha match\nalpha match\nalpha match\nuntouched\n',
    });
    const { content } = await ts(fs).execute('grep', { pattern: 'match', flags: 'g' });
    const hitLines = content.split('\n').filter((l) => l.startsWith('notes.txt:'));
    expect(hitLines).toEqual([
      'notes.txt:1: alpha match',
      'notes.txt:2: alpha match',
      'notes.txt:3: alpha match',
    ]);
    expect(content).toContain('(ignored flags: g');
  });

  it('an invalid pattern still errors, with the note appended when flags were ignored', async () => {
    const res = await ts(seed()).execute('grep', { pattern: '(unclosed', flags: 'n' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('invalid regex');
    expect(res.content).toContain('ignored flags: n');
  });
});

describe('write_file — text into an image path is refused (R3-856)', () => {
  it('a string into src/assets/posters/avatar.jpg is refused, the file untouched', async () => {
    const fs = seed();
    const res = await ts(fs).execute('write_file', {
      path: 'src/assets/posters/avatar.jpg',
      content: 'https://example.com/avatar.jpg',
    });
    expect(res).toEqual({
      // No fetch:fetch in this toolset's catalog → the refusal does not name
      // the tool the model was never given (review round 1).
      content: 'write_file writes text; to add an image, copy an existing asset with copy_file',
      isError: true,
    });
    expect(fs.files.has('/app/src/assets/posters/avatar.jpg')).toBe(false);
  });

  it('names download_file in the refusal only when the tool was listed', async () => {
    const withFetch = createFsToolset({ root: '/app', fs: seed(), catalog: [{ name: 'fetch:fetch' }], fetchBytes: async () => { throw new Error('unused'); } });
    const res = await withFetch.execute('write_file', { path: 'a.jpg', content: 'x' });
    expect(res.content).toContain('download_file');
  });

  it('.svg is text and stays writable', async () => {
    const fs = seed();
    const res = await ts(fs).execute('write_file', { path: 'src/logo.svg', content: '<svg/>' });
    expect(res.isError).toBeUndefined();
    expect(fs.files.get('/app/src/logo.svg')).toBe('<svg/>');
  });

  it('every image extension the table names is refused — derived from the producer', async () => {
    // R2: the cases come from BINARY_IMAGE_EXTENSIONS itself, so an extension
    // added to the table ships refused WITH coverage, not before it.
    expect(BINARY_IMAGE_EXTENSIONS.length).toBeGreaterThanOrEqual(8);
    for (const ext of BINARY_IMAGE_EXTENSIONS) {
      const res = await ts(seed()).execute('write_file', { path: `a.${ext}`, content: 'x' });
      expect(res.isError, `a.${ext}`).toBe(true);
    }
    // case-insensitive on the extension
    expect((await ts(seed()).execute('write_file', { path: 'a.JPG', content: 'x' })).isError).toBe(true);
  });
});

// ── R3-862 — download_file: bytes from the network into the workspace ────────
// The movie-night-report failure: the agent wrote a poster's URL string into
// avatar.jpg. The bytes never enter the model's context — only the one-line
// result does. `fetchBytes` is the mocked hostFetch(bytes) adapter.
describe('download_file (R3-862)', () => {
  // A byte-faithful fake fs (the shared MemFs stores strings).
  class BytesFs {
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>(['/']);
    private err(code: string): Error {
      return Object.assign(new Error(code), { code });
    }
    async readFile(path: string): Promise<Uint8Array> {
      const f = this.files.get(path);
      if (!f) throw this.err(this.dirs.has(path) ? 'EISDIR' : 'ENOENT');
      return f;
    }
    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      let d = path.slice(0, path.lastIndexOf('/'));
      while (d) {
        this.dirs.add(d);
        d = d.slice(0, d.lastIndexOf('/'));
      }
    }
    async mkdir(): Promise<unknown> {
      return undefined;
    }
    async readdir(): Promise<never[]> {
      return [];
    }
    async stat(path: string): Promise<FsStat> {
      if (this.files.has(path)) {
        return { size: this.files.get(path)!.length, mtimeMs: 1, isFile: () => true, isDirectory: () => false };
      }
      if (this.dirs.has(path)) return { size: 0, mtimeMs: 1, isFile: () => false, isDirectory: () => true };
      throw this.err('ENOENT');
    }
    async unlink(path: string): Promise<void> {
      if (!this.files.delete(path)) throw this.err('ENOENT');
    }
  }

  // The real 1×1 transparent PNG, 70 bytes.
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const CATALOG = [{ name: 'fetch:fetch' }];
  const okFetch = (bytes: Uint8Array = PNG, contentType = 'image/png') => async () =>
    ({ status: 200, statusText: 'OK', headers: { 'content-type': contentType }, bodyBytes: bytes });
  const mk = (fetchBytes: unknown, catalog: readonly { name: string }[] = CATALOG) =>
    createFsToolset({ root: '/app', fs: new BytesFs() as unknown as FsPortLike, catalog, fetchBytes: fetchBytes as never });

  it('a real PNG downloads byte-identical, and the model sees one line', async () => {
    const fs = new BytesFs();
    const tsx = createFsToolset({ root: '/app', fs: fs as unknown as FsPortLike, catalog: CATALOG, fetchBytes: okFetch() });
    const res = await tsx.execute('download_file', { url: 'https://example.com/p.png', path: 'src/assets/p.png' });
    expect(res).toEqual({ content: 'saved 70 bytes (image/png) to src/assets/p.png' });
    expect(fs.files.get('/app/src/assets/p.png')).toEqual(PNG);
  });

  it('an image path receiving text/html is refused and writes nothing', async () => {
    const fs = new BytesFs();
    const tsx = createFsToolset({ root: '/app', fs: fs as unknown as FsPortLike, catalog: CATALOG, fetchBytes: okFetch(PNG, 'text/html') });
    const res = await tsx.execute('download_file', { url: 'https://example.com/page', path: 'posters/avatar.jpg' });
    expect(res).toEqual({ content: 'the URL returned text/html, not an image', isError: true });
    expect(fs.files.size).toBe(0);
  });

  it('a 404 is refused with the status named', async () => {
    const tsx = mk(async () => ({ status: 404, statusText: 'Not Found', headers: {}, bodyBytes: undefined }));
    const res = await tsx.execute('download_file', { url: 'https://example.com/gone.png', path: 'gone.png' });
    expect(res).toEqual({ content: 'the server answered 404', isError: true });
  });

  it('a forbidden refusal carries the allowlist hint', async () => {
    const tsx = mk(async () => {
      throw Object.assign(new Error('outside the allowlist'), { code: 'forbidden' });
    });
    const res = await tsx.execute('download_file', { url: 'https://tracker.example/x.png', path: 'x.png' });
    expect(res.content).toContain("forbidden: this host is not in the app's net:fetch allowlist");
    expect(res.isError).toBe(true);
  });

  it('an existing path without overwrite is refused before the fetch', async () => {
    let fetched = 0;
    const fs = new BytesFs();
    await fs.writeFile('/app/existing.png', PNG);
    const tsx = createFsToolset({
      root: '/app',
      fs: fs as unknown as FsPortLike,
      catalog: CATALOG,
      fetchBytes: (async () => {
        fetched++;
        return { status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, bodyBytes: PNG };
      }) as never,
    });
    const res = await tsx.execute('download_file', { url: 'https://example.com/p.png', path: 'existing.png' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('already exists');
    expect(fetched).toBe(0);
  });

  it('a catalog without fetch:fetch does not list download_file', () => {
    expect(mk(okFetch(), []).tools.some((t) => t.name === 'download_file')).toBe(false);
    expect(mk(okFetch()).tools.some((t) => t.name === 'download_file')).toBe(true);
    // And no transport wired at all → not listed either.
    const bare = createFsToolset({ root: '/app', fs: new BytesFs() as unknown as FsPortLike });
    expect(bare.tools.some((t) => t.name === 'download_file')).toBe(false);
  });
});
