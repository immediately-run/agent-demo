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
import type { ImageBlock, ToolExecutor, ToolOutcome } from './agentLoop';
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

/**
 * The wider slice these tools reach for since R3-338 — the same `fs.promises`, minus the
 * agent's own narrowing.
 *
 * `FsLike` above stayed as it was because `projectTools` shares it and needs none of
 * this. What is added here is exactly what the refactoring primitives require and the
 * port has always had:
 *
 *  - `rename`, so a move is ONE call. Doing it as read + write + delete round-trips the
 *    whole file through the model's context for no reason and has three chances to
 *    half-finish.
 *  - a BYTE-mode `readFile` + a `Uint8Array`-accepting `writeFile`, so copying an image
 *    or any other binary asset does not corrupt it. Reading a PNG as UTF-8 and writing
 *    it back mangles it *silently* — the file still exists, at roughly the right size.
 */
export interface FsPortLike extends Omit<FsLike, 'readFile' | 'writeFile'> {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
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

/** The mount fields this resolver reads (a narrow slice of the SDK `SandboxMount`). */
export interface MountInfo {
  path: string;
  type?: string;
  mode?: 'ro' | 'rw';
  /** Human-readable label — for a worktree, the EDITED repo's `owner/repo` (§3.5). */
  name?: string;
}

/**
 * The **conferred stage-app working tree** — the `type:'worktree'` mount the host
 * attaches for the workbench (AA-23 / `exposesWorkingTree`), or `null` if none is
 * conferred yet.
 *
 * We select by identity (`type === 'worktree'`) AND **exclude the agent's own mount**
 * (`m.path !== appMountPath`): the agent's own repo can also surface as a worktree (its
 * dual mount, or — under a `--region` dev-override — the local dev-source tree), and
 * picking it makes the workbench author *itself*. Returning the agent's own tree here is
 * never correct for the stage agent, so this function refuses to.
 */
export function findConferredWorktree(
  mounts: readonly MountInfo[],
  appMountPath: string,
): { root: string; readOnly: boolean } | null {
  const m = mounts.find((m) => m.type === 'worktree' && m.path !== appMountPath);
  // Deliberately returns the FILESYSTEM facts only. It used to also hand back the
  // mount's `owner/repo` label as the conversation scoping key (R3-475), which made
  // the panel's scope depend on a filesystem port it should never have needed — the
  // coupling R3-491 removed. Both halves now read the scoping key from
  // `useWorkspace()`; this answers only "which tree does the agent author".
  return m ? { root: m.path, readOnly: m.mode === 'ro' } : null;
}

/**
 * Resolve which working tree to author, with a **self-fallback** — for the *standalone*
 * `CodingAgent`, which legitimately edits its OWN app. Prefer the conferred stage tree
 * (so a standalone agent that *is* given one uses it); else the agent's own repo.
 *
 * The **stage** agent (`ConversationStage`) must NOT use this — it uses
 * {@link findConferredWorktree} and refuses when null, rather than silently authoring
 * itself (which read `not found` for every stage-app path and confused the model).
 */
export function resolveWorkingTreeMount(
  mounts: readonly MountInfo[],
  appMountPath: string,
): { root: string; readOnly: boolean } {
  const conferred = findConferredWorktree(mounts, appMountPath);
  if (conferred) return conferred;
  const own = mounts.find((m) => m.path === appMountPath);
  return { root: appMountPath, readOnly: own?.mode === 'ro' };
}

export interface FsToolsOptions {
  /** Absolute mount path the tools are chrooted to (e.g. the app working tree). */
  root: string;
  /** Defaults to the host `fs.promises`. Injected in tests. */
  fs?: FsPortLike;
  /** When the mount is `ro`, writes/deletes are refused locally (no raw EROFS). */
  readOnly?: boolean;
  /**
   * Does the resolved model accept images (R3-339)? From
   * `describeChat().features.vision`. When false, `read_file` on an image SAYS SO in the
   * tool result rather than sending something that errors upstream — absent rather than
   * fake, like the rest of the toolset. Defaults to false: a caller that does not know
   * must not gamble the user's request on a guess.
   */
  vision?: boolean;
}

type ToolResult = ToolOutcome;

// Caps that keep a single tool result from blowing the model's context.
const READ_CAP = 64 * 1024; // bytes of a file returned by read_file
// R3-339 — the largest image `read_file` will hand the model. Images are big and count
// against the context budget R3-220 manages, so there has to be a ceiling, and it has to
// be NAMED in the refusal rather than silently truncating (a truncated image is not a
// smaller image, it is a corrupt one). ~1.5 MB of source bytes ≈ 2 MB of base64, which
// comfortably covers a screenshot or a design mockup.
const IMAGE_CAP = 1_500 * 1024;
/**
 * Image types the transport can carry, mirroring the SDK's `mimeTypeFor` table.
 *
 * WHY A LOCAL COPY rather than importing `mimeTypeFor` from `@immediately-run/sdk`:
 * this module is deliberately dependency-light so it unit-tests without a host — every
 * suite that touches it (and `projectTools`, which shares its types) would otherwise
 * have to mock the whole SDK barrel to exercise a path lookup. Eleven lines of table is
 * the cheaper honesty. `mimeTypeFor` is the source it mirrors; `imageMime.test.ts`
 * pins the agreement.
 *
 * `.svg` is deliberately ABSENT even though the SDK's table names it — see `read_file`.
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** The image MIME type for a path, or `undefined` when it is not a viewable image. */
export function imageMimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return IMAGE_MIME_BY_EXT[path.slice(dot + 1).toLowerCase()];
}
const LIST_CAP = 1000; // entries from list_dir
const MATCH_CAP = 200; // glob paths / grep hits
const WALK_CAP = 5000; // files visited by a glob/grep walk
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** Collapse `.`/`..` segments in a POSIX path (no fs access). */
export function normalizePosix(p: string): string {
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
 *  chroot. A model path is relative to the app's WORKSPACE, which the app sees as
 *  `/` — the real mount path is never exposed to it. So a leading-slash path
 *  (`/README.md`) means `<root>/README.md`, NOT a filesystem-absolute path; both
 *  `src/App.tsx` and `/src/App.tsx` resolve under `root`, and anything that climbs
 *  out via `..` is rejected (reads back as "not found", never a disclosure — T24). */
export function resolveWithin(root: string, rel: string): string | null {
  const base = normalizePosix(root);
  const joined = normalizePosix(`${base}/${rel}`);
  if (joined !== base && !joined.startsWith(`${base}/`)) return null;
  return joined;
}

/** Name a non-viewable binary by its extension, so the refusal says WHAT it is rather
 *  than just "unreadable" — the model can then decide whether it even needed it. */
function describeBinary(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return ext ? `a .${ext} file` : 'no file extension';
}

/** base64 without Node's Buffer — the sandbox has `btoa`, not Buffer. Chunked so a
 *  megabyte-scale image does not blow the argument limit of `String.fromCharCode`. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Did a UTF-8 read fail because the bytes are not text? ZenFS/node surface this as a
 *  TypeError from the decoder rather than an errno, so it needs its own recognition. */
function isDecodeError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
  return /utf-?8|decode|invalid.*byte|malformed/.test(msg);
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

/** One requested replacement. `replace_all` applies per ENTRY, so a batch can mix a
 *  unique-anchor edit with a fan-out rename. */
export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Where one entry matched, resolved against the ORIGINAL text. */
interface EditSpan {
  start: number;
  end: number;
  replacement: string;
  /** 1-indexed entry number, for error messages the model can act on. */
  entry: number;
}

/** All non-overlapping occurrences of `needle` in `haystack` (same counting as
 *  `split(needle)`, so a self-overlapping literal like `aa` in `aaa` matches once). */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    out.push(i);
  }
  return out;
}

/**
 * Plan a batch of edits against the file AS READ (R3-337).
 *
 * Every entry is matched against the ORIGINAL text, never against the result of the
 * previous entry — otherwise the outcome would be order-dependent and hard for a model
 * to reason about. The plan is then all-or-nothing: any failure returns an error naming
 * WHICH entry and why, and nothing is written, because a half-applied batch leaves the
 * file in a state the model did not intend and cannot easily diagnose.
 *
 * Overlaps are REFUSED rather than resolved. Two entries whose spans intersect are a
 * mistake in the request, and silently picking one is exactly the near-invisible wrong
 * result this tool exists to reduce.
 */
export function planEdits(text: string, edits: EditSpec[]): { ok: true; text: string; sites: number } | { ok: false; error: string } {
  const spans: EditSpan[] = [];
  for (let i = 0; i < edits.length; i++) {
    const entry = i + 1;
    const { old_string: oldStr, new_string: newStr } = edits[i];
    if (typeof oldStr !== 'string' || oldStr === '') {
      return { ok: false, error: `edit ${entry}: "old_string" must be a non-empty string` };
    }
    if (typeof newStr !== 'string') {
      return { ok: false, error: `edit ${entry}: "new_string" must be a string` };
    }
    if (oldStr === newStr) {
      return { ok: false, error: `edit ${entry}: "old_string" and "new_string" are identical — nothing to do` };
    }
    const at = occurrences(text, oldStr);
    if (at.length === 0) {
      return { ok: false, error: `edit ${entry}: old_string not found — it must match the file exactly (whitespace included). No edits were applied.` };
    }
    if (at.length > 1 && edits[i].replace_all !== true) {
      return {
        ok: false,
        error: `edit ${entry}: old_string is not unique (${at.length} matches) — add surrounding context to make it unique, or set replace_all on this entry. No edits were applied.`,
      };
    }
    for (const start of at) spans.push({ start, end: start + oldStr.length, replacement: newStr, entry });
  }
  if (spans.length === 0) return { ok: false, error: 'no edits supplied' };

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      const [a, b] = [spans[i - 1].entry, spans[i].entry];
      return {
        ok: false,
        error:
          a === b
            ? `edit ${a} overlaps itself at offset ${spans[i].start} — no edits were applied`
            : `edits ${a} and ${b} overlap at offset ${spans[i].start} — they cannot both apply. Rewrite them as one edit. No edits were applied.`,
      };
    }
  }

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { ok: true, text: out, sites: spans.length };
}

/**
 * Build the filesystem {@link Toolset} chrooted to `opts.root`. The returned
 * `tools` are handed to the model; `execute` runs them through the host `fs`.
 */
export function createFsToolset(opts: FsToolsOptions): Toolset {
  const root = normalizePosix(opts.root);
  const p: FsPortLike = opts.fs ?? (fs.promises as unknown as FsPortLike);
  const readOnly = opts.readOnly ?? false;
  const vision = opts.vision ?? false;

  const rel = (abs: string): string => {
    const r = abs === root ? '' : abs.slice(root.length + 1);
    return r === '' ? '.' : r;
  };

  /** Does a path exist? Used to refuse a clobbering move/copy unless asked (R3-338). */
  const exists = async (abs: string): Promise<boolean> => {
    try {
      await p.stat(abs);
      return true;
    } catch {
      return false;
    }
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
      const relPath = String(input.path ?? '');
      const abs = resolveWithin(root, relPath);
      if (!abs) return notFound;

      // R3-339 — an IMAGE is read as bytes and handed over as an image part, not
      // mangled through UTF-8 and not silently skipped. `.svg` is deliberately excluded
      // from IMAGE_MIME even though the SDK's table names it: an SVG is TEXT, and it is
      // also source the agent may want to EDIT, so it reads as text and stays editable.
      // Making that predictable is the point — the surprise would be the failure.
      const mime = imageMimeFor(relPath);
      if (mime) {
        if (!vision) {
          return {
            content: `${rel(abs)} is a ${mime} image, but the model in use cannot accept images — describe it in words or work from the file's name and the code that references it.`,
            isError: true,
          };
        }
        let bytes: Uint8Array;
        try {
          bytes = await p.readFile(abs);
        } catch (e) {
          return fsError(e);
        }
        if (bytes.length > IMAGE_CAP) {
          // Refused BEFORE it is sent, and the cap is named. Truncating an image does
          // not make a smaller image, it makes a corrupt one.
          return {
            content: `${rel(abs)} is ${bytes.length} bytes, over the ${IMAGE_CAP}-byte image limit — resize or crop it first.`,
            isError: true,
          };
        }
        const image: ImageBlock = { type: 'image', mimeType: mime, data: toBase64(bytes) };
        return { content: `[image ${rel(abs)} — ${mime}, ${bytes.length} bytes]`, images: [image] };
      }

      const offsetGiven = input.offset !== undefined && input.offset !== null;
      const limitGiven = input.limit !== undefined && input.limit !== null;
      try {
        const text = await p.readFile(abs, 'utf8');
        // Fast path: a small whole file with no paging requested reads verbatim,
        // exactly as before — the common case is untouched.
        if (!offsetGiven && !limitGiven && text.length <= READ_CAP) {
          return { content: text };
        }
        // Otherwise page by line: `offset` (1-indexed start line) + `limit` (line
        // count), each optional. This makes a >READ_CAP file FULLY readable — the
        // old code truncated at 64 KB with no way to see the tail. READ_CAP stays a
        // per-window byte guard; when a window is cut short (by the cap or `limit`)
        // the notice names the exact `offset=` to continue from (Pi's read-until-
        // complete pattern), so the model can page through to EOF.
        const lines = text.split('\n');
        const totalLines = lines.length;
        const start = Math.max(1, Math.trunc(Number(input.offset ?? 1)) || 1);
        if (start > totalLines) {
          return { content: `[empty — offset ${start} is past end of file (${totalLines} lines)]` };
        }
        const wantCount = limitGiven
          ? Math.max(0, Math.trunc(Number(input.limit)) || 0)
          : totalLines - (start - 1);

        const windowLines: string[] = [];
        let bytes = 0;
        let emitted = 0;
        let singleLineOverCap = false;
        for (let i = start - 1; i < totalLines && emitted < wantCount; i++) {
          const ln = lines[i];
          const lnBytes = ln.length + 1; // + the joining newline
          if (emitted > 0 && bytes + lnBytes > READ_CAP) break; // page boundary
          if (emitted === 0 && ln.length > READ_CAP) {
            // A single line larger than the whole window: emit it truncated (there
            // is no finer unit than a line) and report it, rather than loop forever.
            windowLines.push(ln.slice(0, READ_CAP));
            emitted = 1;
            singleLineOverCap = true;
            break;
          }
          windowLines.push(ln);
          bytes += lnBytes;
          emitted++;
        }

        if (emitted === 0) {
          return { content: `[empty window — offset ${start}, limit ${wantCount}]` };
        }
        const body = windowLines.join('\n');
        const last = start + emitted - 1;
        if (singleLineOverCap) {
          return { content: `${body}\n\n[truncated — line ${start} is ${lines[start - 1].length} bytes and exceeds the ${READ_CAP}-byte window; it cannot be split further by line]` };
        }
        if (last < totalLines) {
          return { content: `${body}\n\n[showing lines ${start}–${last} of ${totalLines}; continue with offset=${last + 1}]` };
        }
        // Reached EOF. Annotate only when the caller was paging (offset/limit given);
        // a full small-file read stays un-annotated.
        if (offsetGiven || limitGiven) {
          return { content: `${body}\n\n[lines ${start}–${totalLines} of ${totalLines} — end of file]` };
        }
        return { content: body };
      } catch (e) {
        // R3-339 — a non-image binary is still refused, but by NAME rather than as a
        // bare decode failure: "unreadable" tells the model nothing it can act on.
        if (isDecodeError(e)) {
          return {
            content: `${rel(abs)} is not UTF-8 text and is not an image type the model can view (${describeBinary(relPath)}) — read_file cannot show it.`,
            isError: true,
          };
        }
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

    // Surgical edit: replace an exact snippet without rewriting the whole file.
    // The reason this tool exists — `write_file` is whole-file overwrite, so editing
    // a large existing file (e.g. a 50KB shared stylesheet) means faithfully
    // regenerating every byte, which models won't do; they loop hunting for an
    // "insertion point" `write_file` can't express. `edit_file` is the editor's
    // string-replace: supply a unique `old_string` + its `new_string`.
    async edit_file(input) {
      if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
      const abs = resolveWithin(root, String(input.path ?? ''));
      if (!abs) return notFound;
      // R3-337 — one call, N sites. `edits[]` is the batch form; the single
      // `old_string`/`new_string` pair is kept because it is the right shape for a
      // one-site change and the prompt already teaches it. Both go through the same
      // planner, so the batch of one and the single pair cannot diverge.
      const batch = Array.isArray(input.edits) ? (input.edits as unknown[]) : null;
      const specs: EditSpec[] = batch
        ? batch.map((e) => {
            const o = (e ?? {}) as Record<string, unknown>;
            return {
              old_string: typeof o.old_string === 'string' ? o.old_string : '',
              new_string: typeof o.new_string === 'string' ? o.new_string : '',
              replace_all: o.replace_all === true,
            };
          })
        : [
            {
              old_string: typeof input.old_string === 'string' ? input.old_string : '',
              new_string: typeof input.new_string === 'string' ? input.new_string : '',
              replace_all: input.replace_all === true,
            },
          ];
      if (batch && specs.length === 0) {
        return { content: 'edit_file "edits" was empty — supply at least one { old_string, new_string }', isError: true };
      }
      if (!batch && !specs[0].old_string) {
        return { content: 'edit_file requires a non-empty "old_string" (or an "edits" array)', isError: true };
      }
      let text: string;
      try {
        text = await p.readFile(abs, 'utf8');
      } catch (e) {
        return fsError(e);
      }
      // Literal matching throughout — never a regex — so a `$`/backslash in
      // `new_string` is not reinterpreted the way String.replace would.
      const plan = planEdits(text, specs);
      if (!plan.ok) {
        // All-or-nothing: nothing has been written, and the message names the entry.
        // The single-pair form has no entry to number, so its message reads as it always
        // did. A one-entry BATCH still numbers, because the caller wrote `edits[0]`.
        return { content: batch ? plan.error : plan.error.replace(/^edit 1: /, ''), isError: true };
      }
      try {
        await p.writeFile(abs, plan.text);
      } catch (e) {
        return fsError(e);
      }
      const delta = plan.text.length - text.length;
      const where = plan.sites === 1 ? '1 replacement' : `${plan.sites} replacements`;
      const across = specs.length > 1 ? ` across ${specs.length} edits` : '';
      return { content: `edited ${rel(abs)} (${where}${across}, ${delta >= 0 ? '+' : ''}${delta} bytes)` };
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

    // R3-338 — move/copy/replace: the refactoring primitives. The port already had
    // `rename`; the agent's own `FsLike` narrowing is what hid it.
    async move_file(input) {
      if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
      // BOTH paths go through the resolver. A move is the one write that names two
      // places, so it is also the one that could become a way to write outside the
      // mount by naming a clever destination — an escape on either side reads back as
      // "not found", never a disclosure (T24).
      const from = resolveWithin(root, String(input.from ?? ''));
      const to = resolveWithin(root, String(input.to ?? ''));
      if (!from || !to) return notFound;
      if (from === to) return { content: '"from" and "to" are the same path — nothing to do', isError: true };
      try {
        if (input.overwrite !== true && (await exists(to))) {
          return { content: `${rel(to)} already exists — pass overwrite: true to replace it`, isError: true };
        }
        const slash = to.lastIndexOf('/');
        if (slash > 0) await p.mkdir(to.slice(0, slash), { recursive: true });
        await p.rename(from, to);
        return { content: `moved ${rel(from)} → ${rel(to)}` };
      } catch (e) {
        return fsError(e);
      }
    },

    async copy_file(input) {
      if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
      const from = resolveWithin(root, String(input.from ?? ''));
      const to = resolveWithin(root, String(input.to ?? ''));
      if (!from || !to) return notFound;
      if (from === to) return { content: '"from" and "to" are the same path — nothing to do', isError: true };
      try {
        if (input.overwrite !== true && (await exists(to))) {
          return { content: `${rel(to)} already exists — pass overwrite: true to replace it`, isError: true };
        }
        // BYTES, not text. Reading a PNG as UTF-8 and writing it back mangles it, and
        // the mangling is silent — the file still exists, at roughly the right size.
        const bytes = await p.readFile(from);
        const slash = to.lastIndexOf('/');
        if (slash > 0) await p.mkdir(to.slice(0, slash), { recursive: true });
        await p.writeFile(to, bytes);
        return { content: `copied ${rel(from)} → ${rel(to)} (${bytes.length} bytes)` };
      } catch (e) {
        return fsError(e);
      }
    },

    async replace_in_files(input) {
      const dryRun = input.dry_run === true;
      if (readOnly && !dryRun) return { content: 'read-only: this mount cannot be written', isError: true };
      const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
      const newStr = typeof input.new_string === 'string' ? input.new_string : '';
      if (!oldStr) return { content: 'replace_in_files requires a non-empty "old_string"', isError: true };
      if (oldStr === newStr) return { content: '"old_string" and "new_string" are identical — nothing to do', isError: true };
      const start = resolveWithin(root, String(input.path ?? '.'));
      if (!start) return notFound;
      const matcher = typeof input.glob === 'string' && input.glob ? globToRegExp(input.glob) : null;

      const files: string[] = [];
      await walk(start, files, { n: WALK_CAP });
      const changed: Array<{ path: string; sites: number }> = [];
      let total = 0;
      for (const abs of files) {
        const r = rel(abs);
        if (matcher && !matcher.test(r)) continue;
        let text: string;
        try {
          text = await p.readFile(abs, 'utf8');
        } catch {
          continue; // binary/unreadable — a text replace has nothing to say about it
        }
        const sites = text.split(oldStr).length - 1;
        if (sites === 0) continue;
        changed.push({ path: r, sites });
        total += sites;
        if (changed.length >= MATCH_CAP) break;
        if (dryRun) continue;
        try {
          await p.writeFile(abs, text.split(oldStr).join(newStr));
        } catch (e) {
          // Report what already changed rather than pretending the whole run failed.
          const partial = changed.map((c) => `${c.path}: ${c.sites}`).join('\n');
          return { content: `failed writing ${r}: ${message(e)}\nchanged so far:\n${partial}`, isError: true };
        }
      }
      if (changed.length === 0) return { content: '(no matches)' };
      // Per-file counts, always. A replace that reports only "done" is unreviewable —
      // and this is exactly the operation whose blast radius should be read back as a
      // diff before it is proposed.
      const lines = changed.map((c) => `${c.path}: ${c.sites}`).join('\n');
      const head = dryRun
        ? `would change ${total} site(s) in ${changed.length} file(s) — nothing written`
        : `changed ${total} site(s) in ${changed.length} file(s)`;
      const more = changed.length >= MATCH_CAP ? `\n[stopped at ${MATCH_CAP} files — narrow with "path" or "glob"]` : '';
      return { content: `${head}\n${lines}${more}` };
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
    { name: 'read_file', description: 'Read a workspace file. An IMAGE (png/jpeg/gif/webp/avif/bmp/ico) comes back as a picture you can look at, when the model in use accepts images; an `.svg` reads as text, because it is source you may want to edit. `path` is workspace-relative. For a large file, page through it with `offset` (1-indexed start line) and `limit` (line count): when a read is cut short the result names the exact `offset=` to continue from, so keep reading until you have the whole file.', input_schema: obj({ path: str('Workspace-relative file path.'), offset: { type: 'integer', description: '1-indexed line to start reading from (default 1).' }, limit: { type: 'integer', description: 'Number of lines to read from `offset` (default: to end of file, still capped per window — the notice names the next offset).' } }) },
    { name: 'write_file', description: 'Create or **overwrite** a whole workspace file (parent dirs are created). Use for NEW files or full rewrites. To change part of an EXISTING file, prefer `edit_file` — do not regenerate a large file just to add a few lines. Edits trigger the app rebuild/HMR.', input_schema: obj({ path: str('Workspace-relative file path.'), content: str('Full new file contents.') }) },
    { name: 'edit_file', description: 'Make surgical edits to an existing file by replacing exact snippets — the right tool for changing or adding lines in a large file (no whole-file rewrite). `old_string` must match the file EXACTLY, whitespace included, and be unique unless `replace_all` is set; `new_string` replaces it (inserted verbatim — `$`/backslashes are not special). To insert, set `old_string` to a unique nearby anchor and `new_string` to that anchor plus your addition. **To change several places in one file, pass `edits` and do it in ONE call** — every entry is matched against the file as it is now, overlapping entries are refused, and if any entry fails NOTHING is applied.', input_schema: obj({ path: str('Workspace-relative file path.'), old_string: str('Exact text to replace; include enough surrounding context to be unique. Omit when using `edits`.'), new_string: str('Replacement text, inserted verbatim. Omit when using `edits`.'), replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false).' }, edits: { type: 'array', description: 'Several replacements applied in one call, each matched against the ORIGINAL file (not against each other). All-or-nothing.', items: obj({ old_string: str('Exact text to replace; unique unless replace_all is set on this entry.'), new_string: str('Replacement text, inserted verbatim.'), replace_all: { type: 'boolean', description: 'Replace every occurrence of THIS entry (default false).' } }) } }) },
    { name: 'list_dir', description: 'List a workspace directory (directories first). Omit `path` for the workspace root.', input_schema: obj({ path: str('Workspace-relative directory (default: root).') }) },
    { name: 'stat', description: 'Stat a workspace path: returns its type, size, and mtime.', input_schema: obj({ path: str('Workspace-relative path.') }) },
    { name: 'glob', description: 'Find workspace files matching a glob (`**`, `*`, `?`), e.g. "src/**/*.ts".', input_schema: obj({ pattern: str('Glob pattern, workspace-relative.') }) },
    { name: 'grep', description: 'Search workspace file contents with a JS regex. Returns `path:line: text` hits.', input_schema: obj({ pattern: str('JS regular expression.'), path: str('Subtree to search (default: root).'), flags: str('Regex flags, e.g. "i".') }) },
    { name: 'move_file', description: 'Move or RENAME a workspace file in one call — the content never passes through you, so prefer this over read + write + delete. Parent directories are created. Refuses to clobber an existing file unless `overwrite` is set.', input_schema: obj({ from: str('Workspace-relative source path.'), to: str('Workspace-relative destination path.'), overwrite: { type: 'boolean', description: 'Replace the destination if it already exists (default false).' } }) },
    { name: 'copy_file', description: 'Copy a workspace file byte-for-byte — safe for images and other binary assets, which a read-then-write through text would corrupt. Parent directories are created. Refuses to clobber an existing file unless `overwrite` is set.', input_schema: obj({ from: str('Workspace-relative source path.'), to: str('Workspace-relative destination path.'), overwrite: { type: 'boolean', description: 'Replace the destination if it already exists (default false).' } }) },
    { name: 'replace_in_files', description: 'Replace an exact literal string across many files — the tool for renaming a symbol project-wide. Scope it with `path` and/or `glob`. Reports WHICH files changed and how many sites in each. Run it with `dry_run: true` first to see the blast radius, and read the result back with a diff before proposing it.', input_schema: obj({ old_string: str('Exact literal text to replace (not a regex).'), new_string: str('Replacement text, inserted verbatim.'), path: str('Subtree to search (default: workspace root).'), glob: str('Only files whose workspace-relative path matches this glob, e.g. "src/**/*.ts".'), dry_run: { type: 'boolean', description: 'Report what WOULD change without writing anything (default false).' } }) },
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
