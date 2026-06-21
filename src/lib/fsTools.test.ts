import { describe, it, expect } from 'vitest';
import { createFsToolset, type FsLike, type FsDirent, type FsStat } from './fsTools';

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
  it('exposes the seven file tools', () => {
    const names = ts(seed()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['delete_file', 'glob', 'grep', 'list_dir', 'read_file', 'stat', 'write_file']);
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
