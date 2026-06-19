// Filesystem tools (LLM_AND_AGENTS_SPEC §3.3, build phase 2): the agent's
// `read_file`/`write_file`/`list_dir`/`stat`/`glob`/`grep`/`delete_file`, bounded
// to the app's mount chroot. The host attaches the working tree into the sandbox
// filesystem at an absolute `path`; we reach it through the `fs` module
// (ZenFS in the sandbox; the @immediately-run/dev-fs bridge under local `vite dev`).
//
// Confinement is BOTH host-side and here. Host-side: outside the mount chroot is
// unnameable and a `ro` mount fails writes with `EROFS` (§8.7). Here (defense in
// depth): every tool path is resolved relative to `root` and rejected if it
// escapes (`..`/absolute outside) — an escape reads back as "not found", never a
// disclosure. Writes are refused locally when the mount is read-only rather than
// surfacing a raw `EROFS` to the model.

import fs from 'fs';
import type { ToolExecutor } from './agentLoop';
import type { Toolset } from './toolset';

/** The slice of `fs.promises` these tools use — narrowed so tests can inject an
 *  in-memory fake without pulling in the whole node surface. */
export interface FsLike {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<FsDirent[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  stat(path: string): Promise<FsStat>;
  unlink(path: string): Promise<void>;
}
export interface FsDirent {
  name: string;
  isDirectory(): boolean;
}
export interface FsStat {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FsToolsOptions {
  /** Absolute mount path the tools are chrooted to (e.g. the app working tree). */
  root: string;
  /** Defaults to the host `fs.promises`. Injected in tests. */
  fs?: FsLike;
  /** When the mount is `ro`, writes/deletes are refused locally (no raw EROFS). */
  readOnly?: boolean;
}

type ToolResult = { content: string; isError?: boolean };

// Caps that keep a single tool result from blowing the model's context.
const READ_CAP = 64 * 1024; // bytes of a file returned by read_file
const LIST_CAP = 1000; // entries from list_dir
const MATCH_CAP = 200; // glob paths / grep hits
const WALK_CAP = 5000; // files visited by a glob/grep walk
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** Collapse `.`/`..` segments in a POSIX path (no fs access). */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

/** Resolve a model-supplied path against `root`, or `null` if it escapes the
 *  chroot. Accepts repo-relative (`src/App.tsx`) and in-root absolute paths. */
function resolveWithin(root: string, rel: string): string | null {
  const base = normalizePosix(root);
  const joined = rel.startsWith('/') ? normalizePosix(rel) : normalizePosix(`${base}/${rel}`);
  if (joined !== base && !joined.startsWith(`${base}/`)) return null;
  return joined;
}

const code = (e: unknown): string | undefined => (e as { code?: string })?.code;
const message = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Map a thrown fs error to a model-readable result (no chroot disclosure). */
function fsError(e: unknown): ToolResult {
  const c = code(e);
  if (c === 'ENOENT') return { content: 'not found', isError: true };
  if (c === 'EROFS' || c === 'EACCES' || c === 'EPERM') return { content: 'read-only: this mount cannot be written', isError: true };
  if (c === 'EISDIR') return { content: 'that path is a directory, not a file', isError: true };
  if (c === 'ENOTDIR') return { content: 'a path segment is a file, not a directory', isError: true };
  return { content: `${c ?? 'error'}: ${message(e)}`, isError: true };
}

const notFound: ToolResult = { content: 'not found', isError: true };

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; // ** — across path separators
        i++;
        if (glob[i + 1] === '/') i++; // collapse `**/`
      } else {
        re += '[^/]*'; // * — within a path segment
      }
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Build the filesystem {@link Toolset} chrooted to `opts.root`. The returned
 * `tools` are handed to the model; `execute` runs them through the host `fs`.
 */
export function createFsToolset(opts: FsToolsOptions): Toolset {
  const root = normalizePosix(opts.root);
  const p: FsLike = opts.fs ?? (fs.promises as unknown as FsLike);
  const readOnly = opts.readOnly ?? false;

  const rel = (abs: string): string => {
    const r = abs === root ? '' : abs.slice(root.length + 1);
    return r === '' ? '.' : r;
  };

  // Depth-first file walk, bounded by WALK_CAP and skipping heavy dirs. Yields
  // absolute file paths under `dir`.
  async function walk(dir: string, out: string[], budget: { n: number }): Promise<void> {
    if (budget.n <= 0) return;
    let entries: FsDirent[];
    try {
      entries = await p.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const ent of entries) {
      if (budget.n <= 0) return;
      const abs = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(abs, out, budget);
      } else {
        budget.n--;
        out.push(abs);
      }
    }
  }

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> = {
    async read_file(input) {
      const abs = resolveWithin(root, String(input.path ?? ''));
      if (!abs) return notFound;
      try {
        const text = await p.readFile(abs, 'utf8');
        if (text.length > READ_CAP) {
          return { content: `${text.slice(0, READ_CAP)}\n\n[truncated — file is ${text.length} bytes; read a smaller range or specific file]` };
        }
        return { content: text };
      } catch (e) {
        return fsError(e);
      }
    },

    async write_file(input) {
      if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
      const abs = resolveWithin(root, String(input.path ?? ''));
      if (!abs) return notFound;
      const content = typeof input.content === 'string' ? input.content : String(input.content ?? '');
      try {
        const slash = abs.lastIndexOf('/');
        if (slash > 0) await p.mkdir(abs.slice(0, slash), { recursive: true });
        await p.writeFile(abs, content);
        return { content: `wrote ${content.length} bytes to ${rel(abs)}` };
      } catch (e) {
        return fsError(e);
      }
    },

    async list_dir(input) {
      const abs = resolveWithin(root, String(input.path ?? '.'));
      if (!abs) return notFound;
      try {
        const entries = await p.readdir(abs, { withFileTypes: true });
        const lines = entries
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
          .slice(0, LIST_CAP)
          .map((e) => (e.dir ? `${e.name}/` : e.name));
        const more = entries.length > LIST_CAP ? `\n[+${entries.length - LIST_CAP} more]` : '';
        return { content: (lines.join('\n') || '(empty)') + more };
      } catch (e) {
        return fsError(e);
      }
    },

    async stat(input) {
      const abs = resolveWithin(root, String(input.path ?? ''));
      if (!abs) return notFound;
      try {
        const st = await p.stat(abs);
        const kind = st.isDirectory() ? 'dir' : 'file';
        return { content: JSON.stringify({ path: rel(abs), type: kind, size: st.size, mtimeMs: st.mtimeMs }) };
      } catch (e) {
        return fsError(e);
      }
    },

    async glob(input) {
      const pattern = String(input.pattern ?? '');
      if (!pattern) return { content: 'glob requires a "pattern"', isError: true };
      const matcher = globToRegExp(pattern);
      const files: string[] = [];
      await walk(root, files, { n: WALK_CAP });
      const hits = files
        .map(rel)
        .filter((r) => matcher.test(r))
        .slice(0, MATCH_CAP);
      return { content: hits.length ? hits.join('\n') : '(no matches)' };
    },

    async grep(input) {
      const pattern = String(input.pattern ?? '');
      if (!pattern) return { content: 'grep requires a "pattern"', isError: true };
      let re: RegExp;
      try {
        re = new RegExp(pattern, typeof input.flags === 'string' ? input.flags : '');
      } catch (e) {
        return { content: `invalid regex: ${message(e)}`, isError: true };
      }
      const start = resolveWithin(root, String(input.path ?? '.'));
      if (!start) return notFound;
      const files: string[] = [];
      await walk(start, files, { n: WALK_CAP });
      const hits: string[] = [];
      for (const abs of files) {
        if (hits.length >= MATCH_CAP) break;
        let text: string;
        try {
          text = await p.readFile(abs, 'utf8');
        } catch {
          continue; // binary/unreadable — skip
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < MATCH_CAP; i++) {
          if (re.test(lines[i])) hits.push(`${rel(abs)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
      return { content: hits.length ? hits.join('\n') : '(no matches)' };
    },

    async delete_file(input) {
      if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
      const abs = resolveWithin(root, String(input.path ?? ''));
      if (!abs) return notFound;
      try {
        await p.unlink(abs);
        return { content: `deleted ${rel(abs)}` };
      } catch (e) {
        return fsError(e);
      }
    },
  };

  const obj = (props: Record<string, unknown>): { type: 'object'; properties: Record<string, unknown>; additionalProperties: boolean } => ({
    type: 'object',
    properties: props,
    additionalProperties: false,
  });
  const str = (description: string) => ({ type: 'string', description });

  const tools: Toolset['tools'] = [
    { name: 'read_file', description: 'Read a UTF-8 text file from the workspace. `path` is workspace-relative.', input_schema: obj({ path: str('Workspace-relative file path.') }) },
    { name: 'write_file', description: 'Create or overwrite a workspace file (parent dirs are created). Edits trigger the app rebuild/HMR.', input_schema: obj({ path: str('Workspace-relative file path.'), content: str('Full new file contents.') }) },
    { name: 'list_dir', description: 'List a workspace directory (directories first). Omit `path` for the workspace root.', input_schema: obj({ path: str('Workspace-relative directory (default: root).') }) },
    { name: 'stat', description: 'Stat a workspace path: returns its type, size, and mtime.', input_schema: obj({ path: str('Workspace-relative path.') }) },
    { name: 'glob', description: 'Find workspace files matching a glob (`**`, `*`, `?`), e.g. "src/**/*.ts".', input_schema: obj({ pattern: str('Glob pattern, workspace-relative.') }) },
    { name: 'grep', description: 'Search workspace file contents with a JS regex. Returns `path:line: text` hits.', input_schema: obj({ pattern: str('JS regular expression.'), path: str('Subtree to search (default: root).'), flags: str('Regex flags, e.g. "i".') }) },
    { name: 'delete_file', description: 'Delete a workspace file.', input_schema: obj({ path: str('Workspace-relative file path.') }) },
  ];

  const execute: ToolExecutor = async (name, input) => {
    const handler = handlers[name];
    if (!handler) return { content: `forbidden: "${name}" is not a filesystem tool`, isError: true };
    try {
      return await handler(input);
    } catch (e) {
      return fsError(e);
    }
  };

  return { tools, execute };
}
