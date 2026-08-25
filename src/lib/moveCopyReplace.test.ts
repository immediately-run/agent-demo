// R3-338 — the refactoring primitives: `move_file`, `copy_file`, `replace_in_files`.
//
// The platform side already existed; what blocked the agent was its own narrowing of the
// fs port. These tests pin the four things that would otherwise go wrong quietly: bytes
// survive a copy, a move is one call that never routes content through the model, the
// chroot holds on BOTH arguments of a two-path write, and a project-wide replace is
// reviewable rather than a bare "done".

import { describe, it, expect } from 'vitest';
import { createFsToolset, type FsDirent, type FsPortLike, type FsStat } from './fsTools';

/** In-memory fs holding real BYTES, so a binary round-trip is actually testable. */
class Mem implements FsPortLike {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/', '/app']);
  reads: string[] = [];

  constructor(seed: Record<string, string | Uint8Array> = {}) {
    for (const [k, v] of Object.entries(seed)) this.put(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  private put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
    let d = path.slice(0, path.lastIndexOf('/'));
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }
  private err(code: string): Error {
    return Object.assign(new Error(code), { code });
  }
  async readFile(path: string, encoding?: 'utf8'): Promise<string & Uint8Array> {
    this.reads.push(path);
    const b = this.files.get(path);
    if (!b) throw this.err('ENOENT');
    return (encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(b) : b) as string & Uint8Array;
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.put(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
  async rename(from: string, to: string): Promise<void> {
    const b = this.files.get(from);
    if (!b) throw this.err('ENOENT');
    this.put(to, b);
    this.files.delete(from);
  }
  async mkdir(path: string): Promise<unknown> {
    this.dirs.add(path);
    return undefined;
  }
  async readdir(path: string): Promise<FsDirent[]> {
    if (!this.dirs.has(path)) throw this.err('ENOENT');
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (f.startsWith(prefix) && f !== path) names.add(f.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((name) => ({ name, isDirectory: () => this.dirs.has(prefix + name) }));
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
  text(path: string): string | undefined {
    const b = this.files.get(path);
    return b && new TextDecoder().decode(b);
  }
}

// A tiny but genuinely binary payload: a PNG signature plus a NUL and a lone high byte
// that is NOT valid UTF-8 — reading this as text and writing it back would mangle it.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x42]);

const mk = (seed: Record<string, string | Uint8Array>, readOnly = false) => {
  const fs = new Mem(seed);
  return { fs, ts: createFsToolset({ root: '/app', fs, readOnly }) };
};

describe('exit 1 — move_file relocates in ONE call, without routing the content through the model', () => {
  it('moves the file: source gone, destination identical', async () => {
    const { fs, ts } = mk({ '/app/src/a.ts': 'export const a = 1;\n' });
    const res = await ts.execute('move_file', { from: 'src/a.ts', to: 'src/b.ts' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('moved src/a.ts → src/b.ts');
    expect(fs.text('/app/src/a.ts')).toBeUndefined();
    expect(fs.text('/app/src/b.ts')).toBe('export const a = 1;\n');
  });

  it('never READS the file — that is the whole point of using the port\'s rename', async () => {
    const { fs, ts } = mk({ '/app/big.ts': 'x'.repeat(100_000) });
    await ts.execute('move_file', { from: 'big.ts', to: 'moved.ts' });
    // read + write + delete would have pulled 100 KB through the model's context.
    expect(fs.reads).toEqual([]);
  });

  it('creates parent directories, the way write_file already does', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'A' });
    await ts.execute('move_file', { from: 'a.ts', to: 'deep/nested/a.ts' });
    expect(fs.text('/app/deep/nested/a.ts')).toBe('A');
  });

  it('REFUSES to clobber an existing file unless asked', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'A', '/app/b.ts': 'B' });
    const refused = await ts.execute('move_file', { from: 'a.ts', to: 'b.ts' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('already exists');
    expect(fs.text('/app/a.ts')).toBe('A');
    expect(fs.text('/app/b.ts')).toBe('B');

    const forced = await ts.execute('move_file', { from: 'a.ts', to: 'b.ts', overwrite: true });
    expect(forced.isError).toBeFalsy();
    expect(fs.text('/app/b.ts')).toBe('A');
  });

  it('reports a missing source as "not found", not a raw errno', async () => {
    const { ts } = mk({});
    expect(await ts.execute('move_file', { from: 'nope.ts', to: 'x.ts' })).toEqual({ content: 'not found', isError: true });
  });
});

describe('exit 2 — copy_file is byte-for-byte, so a binary asset survives', () => {
  it('copies a PNG unchanged, including its NUL and its invalid-UTF-8 byte', async () => {
    const { fs, ts } = mk({ '/app/logo.png': PNG });
    const res = await ts.execute('copy_file', { from: 'logo.png', to: 'assets/logo.png' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(`${PNG.length} bytes`);
    expect([...fs.files.get('/app/assets/logo.png')!]).toEqual([...PNG]);
    // …and the original is still there.
    expect([...fs.files.get('/app/logo.png')!]).toEqual([...PNG]);
  });

  it('refuses to clobber unless asked, like move_file', async () => {
    const { fs, ts } = mk({ '/app/a.png': PNG, '/app/b.png': new Uint8Array([1, 2]) });
    const refused = await ts.execute('copy_file', { from: 'a.png', to: 'b.png' });
    expect(refused.isError).toBe(true);
    expect([...fs.files.get('/app/b.png')!]).toEqual([1, 2]);
    await ts.execute('copy_file', { from: 'a.png', to: 'b.png', overwrite: true });
    expect([...fs.files.get('/app/b.png')!]).toEqual([...PNG]);
  });
});

describe('exit 3 — project-wide replace is REVIEWABLE, and has a dry run', () => {
  const tree = () => ({
    '/app/src/a.ts': 'const oldName = 1;\nexport { oldName };\n',
    '/app/src/b.ts': 'import { oldName } from "./a";\n',
    '/app/src/deep/c.tsx': 'oldName + oldName + oldName\n',
    '/app/README.md': 'oldName is documented here\n',
  });

  it('reports WHICH files changed and how many sites in each', async () => {
    const { fs, ts } = mk(tree());
    const res = await ts.execute('replace_in_files', { old_string: 'oldName', new_string: 'newName' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('changed 7 site(s) in 4 file(s)');
    expect(res.content).toContain('src/a.ts: 2');
    expect(res.content).toContain('src/deep/c.tsx: 3');
    expect(fs.text('/app/src/b.ts')).toBe('import { newName } from "./a";\n');
  });

  it('a DRY RUN shows what it would change and writes nothing', async () => {
    const { fs, ts } = mk(tree());
    const res = await ts.execute('replace_in_files', { old_string: 'oldName', new_string: 'newName', dry_run: true });
    expect(res.content).toContain('would change 7 site(s) in 4 file(s) — nothing written');
    expect(res.content).toContain('src/a.ts: 2');
    expect(fs.text('/app/src/a.ts')).toBe('const oldName = 1;\nexport { oldName };\n');
  });

  it('scopes by subtree and by glob', async () => {
    const { fs, ts } = mk(tree());
    const scoped = await ts.execute('replace_in_files', {
      old_string: 'oldName',
      new_string: 'newName',
      path: 'src',
      glob: 'src/**/*.ts',
    });
    expect(scoped.content).toContain('2 file(s)');
    expect(fs.text('/app/README.md')).toContain('oldName'); // out of scope, untouched
    expect(fs.text('/app/src/deep/c.tsx')).toContain('oldName'); // wrong extension
  });

  it('says so plainly when nothing matches', async () => {
    const { ts } = mk(tree());
    expect((await ts.execute('replace_in_files', { old_string: 'zzz', new_string: 'y' })).content).toBe('(no matches)');
  });

  it('is literal, not a regex — and inserts verbatim', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'a.b()\n' });
    await ts.execute('replace_in_files', { old_string: 'a.b', new_string: '$& \\1' });
    expect(fs.text('/app/a.ts')).toBe('$& \\1()\n');
  });

  it('skips files it cannot decode as text rather than corrupting them', async () => {
    const { fs, ts } = mk({ '/app/logo.png': PNG, '/app/a.ts': 'oldName\n' });
    const res = await ts.execute('replace_in_files', { old_string: 'oldName', new_string: 'newName' });
    expect(res.content).toContain('1 file(s)');
    expect([...fs.files.get('/app/logo.png')!]).toEqual([...PNG]);
  });

  it('refuses an empty or no-op replacement', async () => {
    const { ts } = mk({ '/app/a.ts': 'x' });
    expect((await ts.execute('replace_in_files', { old_string: '', new_string: 'y' })).isError).toBe(true);
    expect((await ts.execute('replace_in_files', { old_string: 'x', new_string: 'x' })).isError).toBe(true);
  });
});

describe('exit 4 — the chroot holds on BOTH arguments of a two-path write', () => {
  const ESCAPES = ['../../etc/secret', '/../etc/secret', 'src/../../etc/secret'];

  it('a move that escapes on EITHER side reads back as "not found"', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'A', '/etc/secret': 'TOPSECRET' });
    for (const bad of ESCAPES) {
      expect(await ts.execute('move_file', { from: bad, to: 'stolen.ts' })).toEqual({ content: 'not found', isError: true });
      // The destination side is the dangerous one: a move must not become the tool that
      // writes outside the mount by naming a clever destination.
      expect(await ts.execute('move_file', { from: 'a.ts', to: bad })).toEqual({ content: 'not found', isError: true });
    }
    expect(fs.text('/etc/secret')).toBe('TOPSECRET');
    expect(fs.text('/app/a.ts')).toBe('A');
    expect(fs.text('/app/stolen.ts')).toBeUndefined();
  });

  it('a copy that escapes on either side reads back as "not found"', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'A', '/etc/secret': 'TOPSECRET' });
    for (const bad of ESCAPES) {
      expect(await ts.execute('copy_file', { from: bad, to: 'stolen.ts' })).toEqual({ content: 'not found', isError: true });
      expect(await ts.execute('copy_file', { from: 'a.ts', to: bad })).toEqual({ content: 'not found', isError: true });
    }
    expect(fs.text('/etc/secret')).toBe('TOPSECRET');
    expect(fs.text('/app/stolen.ts')).toBeUndefined();
  });

  it('a replace scoped outside the mount reads back as "not found" and touches nothing', async () => {
    const { fs, ts } = mk({ '/etc/secret': 'TOPSECRET' });
    expect(await ts.execute('replace_in_files', { old_string: 'TOP', new_string: 'x', path: '../../etc' })).toEqual({
      content: 'not found',
      isError: true,
    });
    expect(fs.text('/etc/secret')).toBe('TOPSECRET');
  });

  it('refuses a same-path move or copy rather than destroying the file', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'A' });
    expect((await ts.execute('move_file', { from: 'a.ts', to: '/a.ts' })).isError).toBe(true);
    expect((await ts.execute('copy_file', { from: 'a.ts', to: './a.ts' })).isError).toBe(true);
    expect(fs.text('/app/a.ts')).toBe('A');
  });
});

describe('exit 5 — all three refuse cleanly on a read-only mount', () => {
  it('each says "read-only", never a raw EROFS, and changes nothing', async () => {
    const { fs, ts } = mk({ '/app/a.ts': 'oldName\n', '/app/b.ts': 'B' }, true);
    for (const [name, input] of [
      ['move_file', { from: 'a.ts', to: 'c.ts' }],
      ['copy_file', { from: 'a.ts', to: 'c.ts' }],
      ['replace_in_files', { old_string: 'oldName', new_string: 'newName' }],
    ] as const) {
      const res = await ts.execute(name, input);
      expect(res.isError).toBe(true);
      expect(res.content).toBe('read-only: this mount cannot be written');
      expect(res.content).not.toContain('EROFS');
    }
    expect(fs.text('/app/a.ts')).toBe('oldName\n');
    expect(fs.text('/app/c.ts')).toBeUndefined();
  });

  it('a DRY RUN is still allowed on a read-only mount — it is a read', async () => {
    const { ts } = mk({ '/app/a.ts': 'oldName\n' }, true);
    const res = await ts.execute('replace_in_files', { old_string: 'oldName', new_string: 'newName', dry_run: true });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('would change');
  });
});
