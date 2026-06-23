// Project tools (LLM_AND_AGENTS_SPEC §3.3, build phases 4–6): the agent's
// `add_dependency` and `scaffold`. Like fsTools, these operate ONLY inside the
// app's mount chroot and never run anything — they edit files the runtime reads
// on its next build. There is no install step: declaring a dependency in
// `package.json` is enough; the sandbox resolves ESM deps from the CDN on the
// next transpile (§3.2). `scaffold` writes a minimal, CLAUDE.md-rule-compliant
// skeleton WITHOUT clobbering anything that already exists.
//
// Confinement / input-trust: `add_dependency` validates the name + version as
// DATA (regex, parsed-not-executed — never a module path or script); `scaffold`'s
// `template` is a fixed enum and its file contents are app-local constants, so a
// prompt can't ask it to write arbitrary content through a "template" parameter.

import fs from 'fs';
import type { ToolExecutor } from './agentLoop';
import type { FsLike } from './fsTools';
import { normalizePosix, resolveWithin } from './fsTools';
import type { Toolset } from './toolset';

export interface ProjectToolsOptions {
  /** Absolute mount path the tools are chrooted to (the app working tree). */
  root: string;
  /** Defaults to the host `fs.promises`. Injected in tests. */
  fs?: FsLike;
  /** When the mount is `ro`, edits are refused locally (no raw EROFS). */
  readOnly?: boolean;
}

type ToolResult = { content: string; isError?: boolean };

// npm package name (optionally scoped). Deliberately strict: this is the gate
// that keeps a name from being anything other than a package identifier.
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// A version *value*, never code: a semver/range, an `x`-range, `*`, or a dist-tag.
const VERSION_VALUE = /^(?:[\w.\-+^~><=*x| ]+)$/;
const DIST_TAG = /^[a-z][a-z0-9-]*$/; // latest, next, beta, …

const message = (e: unknown): string => (e as Error)?.message ?? String(e);
const codeOf = (e: unknown): string | undefined => (e as { code?: string })?.code;

/** Stable, npm-style key sort so a re-add produces a minimal, deterministic diff. */
function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/**
 * Build the project {@link Toolset} chrooted to `opts.root`: `add_dependency`
 * (edits `package.json`) and `scaffold` (seeds an app skeleton).
 */
export function createProjectToolset(opts: ProjectToolsOptions): Toolset {
  const root = normalizePosix(opts.root);
  const p: FsLike = opts.fs ?? (fs.promises as unknown as FsLike);
  const readOnly = opts.readOnly ?? false;

  const exists = async (abs: string): Promise<boolean> => {
    try {
      await p.stat(abs);
      return true;
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return false;
      throw e;
    }
  };

  async function addDependency(input: Record<string, unknown>): Promise<ToolResult> {
    if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
    const name = String(input.name ?? '').trim();
    const version = String(input.version ?? 'latest').trim() || 'latest';
    if (!NPM_NAME.test(name)) return { content: `invalid package name: ${JSON.stringify(name)}`, isError: true };
    if (!(VERSION_VALUE.test(version) || DIST_TAG.test(version))) {
      return { content: `invalid version: ${JSON.stringify(version)} (use a semver range like "^1.2.3", an x-range, "*", or a dist-tag)`, isError: true };
    }
    const pkgPath = resolveWithin(root, 'package.json');
    if (!pkgPath) return { content: 'not found', isError: true };

    let raw: string;
    try {
      raw = await p.readFile(pkgPath, 'utf8');
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return { content: 'no package.json in this workspace — run scaffold first', isError: true };
      return { content: `${codeOf(e) ?? 'error'}: ${message(e)}`, isError: true };
    }
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      return { content: `package.json is not valid JSON: ${message(e)}`, isError: true };
    }

    const deps = { ...((pkg.dependencies as Record<string, string>) ?? {}) };
    if (deps[name] === version) {
      return { content: `${name}@${version} is already a dependency` };
    }
    const prior = deps[name];
    deps[name] = version;
    pkg.dependencies = sortKeys(deps);

    try {
      await p.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch (e) {
      const c = codeOf(e);
      if (c === 'EROFS' || c === 'EACCES' || c === 'EPERM') return { content: 'read-only: this mount cannot be written', isError: true };
      return { content: `${c ?? 'error'}: ${message(e)}`, isError: true };
    }
    const verb = prior ? `updated ${name} ${prior} → ${version}` : `added ${name}@${version}`;
    return { content: `${verb} in dependencies; it resolves on the next build (no install step runs)` };
  }

  async function scaffold(input: Record<string, unknown>): Promise<ToolResult> {
    if (readOnly) return { content: 'read-only: this mount cannot be written', isError: true };
    const template = String(input.template ?? 'react-ts');
    const files = SCAFFOLDS[template];
    if (!files) return { content: `unknown template ${JSON.stringify(template)} (available: ${Object.keys(SCAFFOLDS).join(', ')})`, isError: true };

    const created: string[] = [];
    const skipped: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolveWithin(root, rel);
      if (!abs) continue; // unreachable for our fixed rels, but never write outside the chroot
      try {
        if (await exists(abs)) {
          skipped.push(rel);
          continue;
        }
        const slash = abs.lastIndexOf('/');
        if (slash > 0) await p.mkdir(abs.slice(0, slash), { recursive: true });
        await p.writeFile(abs, content);
        created.push(rel);
      } catch (e) {
        const c = codeOf(e);
        if (c === 'EROFS' || c === 'EACCES' || c === 'EPERM') return { content: 'read-only: this mount cannot be written', isError: true };
        return { content: `${c ?? 'error'}: ${message(e)}`, isError: true };
      }
    }
    const parts = [
      created.length ? `created ${created.join(', ')}` : null,
      skipped.length ? `skipped (already present): ${skipped.join(', ')}` : null,
    ].filter(Boolean);
    return { content: parts.join('; ') || 'nothing to do' };
  }

  const obj = (props: Record<string, unknown>): { type: 'object'; properties: Record<string, unknown>; additionalProperties: boolean } => ({
    type: 'object',
    properties: props,
    additionalProperties: false,
  });

  const tools: Toolset['tools'] = [
    {
      name: 'add_dependency',
      description:
        'Declare an npm dependency in package.json. No install runs — the runtime resolves it from the CDN on the next build. `version` is a semver range (e.g. "^1.2.3"), x-range, "*", or a dist-tag like "latest".',
      input_schema: obj({
        name: { type: 'string', description: 'npm package name (e.g. "zustand" or "@scope/pkg").' },
        version: { type: 'string', description: 'Version range or dist-tag (default "latest").' },
      }),
    },
    {
      name: 'scaffold',
      description:
        'Seed a minimal immediately.run app skeleton (default-export src/App.tsx, index.css, package.json, index.html) into the workspace. Never overwrites existing files — already-present files are skipped. Use once on an empty workspace before building.',
      input_schema: obj({
        template: { type: 'string', description: 'Skeleton template id (default "react-ts").' },
      }),
    },
  ];

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> = {
    add_dependency: addDependency,
    scaffold,
  };

  const execute: ToolExecutor = async (name, input) => {
    const handler = handlers[name];
    if (!handler) return { content: `forbidden: "${name}" is not a project tool`, isError: true };
    try {
      return await handler(input);
    } catch (e) {
      return { content: `${codeOf(e) ?? 'error'}: ${message(e)}`, isError: true };
    }
  };

  return { tools, execute };
}

// ---- Fixed, app-local skeleton templates (kernel-reviewed in the sense that they
// ship in this app's own source; `template` selects one, callers can't supply files).

const APP_TSX = `import "./index.css";

// immediately.run renders this file's default export. Keep app logic reachable
// from here (CLAUDE.md rule 1). main.tsx is for local dev only and is ignored
// at runtime.
export default function App() {
  return (
    <main className="app">
      <h1>New app.</h1>
      <p>Edit src/App.tsx to start building.</p>
    </main>
  );
}
`;

const INDEX_CSS = `:root {
  color-scheme: dark;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
}

.app {
  max-width: 40rem;
  margin: 4rem auto;
  padding: 0 1.5rem;
}
`;

const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Local dev/build entry only — immediately.run renders App's default export
// directly and ignores this file (CLAUDE.md rule 1).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>New app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'new-app',
    private: true,
    version: '0.0.0',
    type: 'module',
    'immediately.run': { requireLatest: 'stale_ok' },
    scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
    dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
  },
  null,
  2,
) + '\n';

const SCAFFOLDS: Record<string, Record<string, string>> = {
  'react-ts': {
    'package.json': PACKAGE_JSON,
    'index.html': INDEX_HTML,
    'src/main.tsx': MAIN_TSX,
    'src/App.tsx': APP_TSX,
    'src/index.css': INDEX_CSS,
  },
};
