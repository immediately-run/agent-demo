import { describe, it, expect } from 'vitest';
import { createProjectToolset } from './projectTools';
import type { FsLike, FsDirent, FsStat } from './fsTools';

// A tiny in-memory fs implementing the FsLike subset the project tools use
// (readFile / writeFile / mkdir / stat). Paths are absolute POSIX.
class MemFs implements FsLike {
  files = new Map<string, string>();
  dirs = new Set<string>(['/']);
  readonly = false;
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
    if (this.readonly) throw this.err('EROFS');
    this.put(path, data);
  }
  async mkdir(path: string): Promise<unknown> {
    if (this.readonly) throw this.err('EROFS');
    let d = path;
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
    return undefined;
  }
  async stat(path: string): Promise<FsStat> {
    const isFile = this.files.has(path);
    const isDir = this.dirs.has(path) && !isFile;
    if (!isFile && !isDir) throw this.err('ENOENT');
    return {
      size: isFile ? this.files.get(path)!.length : 0,
      mtimeMs: 0,
      isDirectory: () => isDir,
      isFile: () => isFile,
    };
  }
  async readdir(): Promise<FsDirent[]> {
    return [];
  }
  async unlink(): Promise<void> {}
}

const ROOT = '/mnt/app';
const run = (fs: MemFs, opts: { readOnly?: boolean } = {}) => {
  const ts = createProjectToolset({ root: ROOT, fs, readOnly: opts.readOnly });
  return (name: string, input: Record<string, unknown>) => ts.execute(name, input);
};

describe('add_dependency', () => {
  const pkg = (deps: Record<string, string> = {}) =>
    JSON.stringify({ name: 'app', dependencies: deps }, null, 2) + '\n';

  it('adds a dependency to package.json and reports no install', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg() });
    const r = await run(fs)('add_dependency', { name: 'zustand', version: '^4.5.0' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('added zustand@^4.5.0');
    expect(r.content).toContain('no install step');
    const written = JSON.parse(fs.files.get(`${ROOT}/package.json`)!);
    expect(written.dependencies.zustand).toBe('^4.5.0');
  });

  it('is idempotent for an unchanged name@version', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg({ zustand: '^4.5.0' }) });
    const r = await run(fs)('add_dependency', { name: 'zustand', version: '^4.5.0' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('already a dependency');
  });

  it('updates an existing dependency to a new version', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg({ zustand: '^4.0.0' }) });
    const r = await run(fs)('add_dependency', { name: 'zustand', version: '^4.5.0' });
    expect(r.content).toContain('updated zustand ^4.0.0 → ^4.5.0');
    expect(JSON.parse(fs.files.get(`${ROOT}/package.json`)!).dependencies.zustand).toBe('^4.5.0');
  });

  it('sorts dependency keys for a deterministic diff', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg({ react: '^19.0.0' }) });
    await run(fs)('add_dependency', { name: 'axios', version: '^1.0.0' });
    expect(Object.keys(JSON.parse(fs.files.get(`${ROOT}/package.json`)!).dependencies)).toEqual(['axios', 'react']);
  });

  it('defaults the version to "latest"', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg() });
    const r = await run(fs)('add_dependency', { name: 'lodash' });
    expect(r.content).toContain('lodash@latest');
  });

  it('rejects an invalid package name (input-trust: data, not a path/script)', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg() });
    for (const name of ['../evil', 'a b', './x.js', 'has/too/many/slashes', '']) {
      const r = await run(fs)('add_dependency', { name, version: '1.0.0' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('invalid package name');
    }
    // package.json untouched
    expect(JSON.parse(fs.files.get(`${ROOT}/package.json`)!).dependencies).toEqual({});
  });

  it('rejects a version value that is not a range/tag', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg() });
    const r = await run(fs)('add_dependency', { name: 'x', version: 'require("evil")' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('invalid version');
  });

  it('errors clearly when there is no package.json', async () => {
    const fs = new MemFs();
    const r = await run(fs)('add_dependency', { name: 'x', version: '1.0.0' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no package.json');
  });

  it('refuses on a read-only mount without a raw EROFS', async () => {
    const fs = new MemFs({ [`${ROOT}/package.json`]: pkg() });
    const r = await run(fs, { readOnly: true })('add_dependency', { name: 'x', version: '1.0.0' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('read-only');
  });
});

describe('scaffold', () => {
  it('writes a CLAUDE.md-compliant skeleton into an empty workspace', async () => {
    const fs = new MemFs();
    const r = await run(fs)('scaffold', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('created');
    // The four+ skeleton files exist...
    for (const rel of ['package.json', 'index.html', 'src/main.tsx', 'src/App.tsx', 'src/index.css']) {
      expect(fs.files.has(`${ROOT}/${rel}`)).toBe(true);
    }
    // ...and App.tsx satisfies the entry-point rule (default export, imports CSS).
    const app = fs.files.get(`${ROOT}/src/App.tsx`)!;
    expect(app).toContain('export default function App');
    expect(app).toContain('./index.css');
  });

  it('never clobbers an existing file — it skips and reports it', async () => {
    const fs = new MemFs({ [`${ROOT}/src/App.tsx`]: 'export default function App(){return null}' });
    const r = await run(fs)('scaffold', {});
    expect(r.content).toContain('skipped (already present): src/App.tsx');
    // the existing App.tsx is untouched
    expect(fs.files.get(`${ROOT}/src/App.tsx`)).toBe('export default function App(){return null}');
    // but the other files were created
    expect(fs.files.has(`${ROOT}/index.html`)).toBe(true);
  });

  it('rejects an unknown template (fixed enum, not caller-supplied content)', async () => {
    const fs = new MemFs();
    const r = await run(fs)('scaffold', { template: 'svelte' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unknown template');
    expect(fs.files.size).toBe(0);
  });

  it('refuses on a read-only mount', async () => {
    const fs = new MemFs();
    const r = await run(fs, { readOnly: true })('scaffold', {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('read-only');
  });
});

describe('dispatch', () => {
  it('returns forbidden for a tool the set does not own', async () => {
    const fs = new MemFs();
    const r = await run(fs)('rm_rf', { path: '/' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('forbidden');
  });

  it('exposes exactly add_dependency and scaffold', () => {
    const ts = createProjectToolset({ root: ROOT, fs: new MemFs() });
    expect(ts.tools.map((t) => t.name).sort()).toEqual(['add_dependency', 'scaffold']);
  });
});
