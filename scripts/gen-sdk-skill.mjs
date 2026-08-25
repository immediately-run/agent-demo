// Generate the SDK API-map skill body from the INSTALLED @immediately-run/sdk
// package's type declarations (R3-331).
//
// Why generated and not hand-written (the item's maintenance question, answered):
// a hand-written API map drifts silently against the SDK, and "a stale API map the
// model trusts absolutely is a worse failure than no map at all". agent-demo pins
// the SDK version in package.json, so deriving the map from `node_modules/
// @immediately-run/sdk/dist/*.d.ts` makes the skill exactly as current as the pin —
// it CANNOT drift, and `skills.sdkApiMap.test.ts` fails the build when the checked-in
// artifact and the installed SDK disagree.
//
// It reads only the package's own published .d.ts files — no network, no mount, no
// app-controlled path. The output is host bytes committed to this repo.
//
//   node scripts/gen-sdk-skill.mjs            # write src/lib/skills/sdkApiMap.generated.ts
//   node scripts/gen-sdk-skill.mjs --check    # exit 1 if the checked-in file is stale

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sdkRoot = join(repoRoot, 'node_modules', '@immediately-run', 'sdk');
const outFile = join(repoRoot, 'src', 'lib', 'skills', 'sdkApiMap.generated.ts');

/** Modules whose exports are internal plumbing rather than app-author API. */
const SKIP_MODULES = new Set(['runtime', 'protocolStream', 'injectedBundler', 'hostRuntime', 'irMarkers']);
/** Exports an app author should not reach for (test seams, internals). */
const SKIP_EXPORTS = /^(__|SDK_PROTOCOL_VERSION$)/;
/** Cap on how many members of one interface the map spells out. */
const MAX_INTERFACE_MEMBERS = 24;

/** `export { A, B } from './mod.js';` → { module: 'mod', names: ['A','B'] } */
function parseBarrel(text) {
  const out = [];
  const re = /export\s*\{([^}]*)\}\s*from\s*'\.\/(.+?)\.js';/g;
  for (let m; (m = re.exec(text)); ) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !SKIP_EXPORTS.test(s));
    const module = m[2];
    if (!names.length || SKIP_MODULES.has(module)) continue;
    out.push({ module, names });
  }
  return out;
}

/** Join a declaration that TS wrapped over several lines into one line. */
function collapse(sig) {
  return sig.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Pull the one-line signature of each named value declaration out of a module's
 * `.d.ts`. Handles both `declare function f(...): T;` and `declare const f: (...) => T;`,
 * including declarations TS emitted across several lines.
 */
function signaturesFor(moduleFile) {
  const path = join(sdkRoot, 'dist', `${moduleFile}.d.ts`);
  if (!existsSync(path)) return new Map();
  const text = readFileSync(path, 'utf8');
  const sigs = new Map();
  const lines = text.split('\n');
  const start = /^declare (?:function|const) ([A-Za-z_$][\w$]*)\b/;
  for (let i = 0; i < lines.length; i++) {
    const head = start.exec(lines[i]);
    if (!head) continue;
    // Accumulate until the declaration is BALANCED and terminated. A `;` inside an
    // inline object/return type (`useRoute: () => { name: string; … }`) is not the end
    // of the declaration — depth-tracking is what keeps such a signature whole.
    let depth = 0;
    const buf = [];
    for (let j = i; j < lines.length; j++) {
      const ln = lines[j];
      buf.push(ln);
      for (const ch of ln) {
        // Only bracket pairs — NOT `<`/`>`, because `=>` appears in almost every
        // signature and would close a depth that was never opened.
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
      }
      if (depth <= 0 && ln.trimEnd().endsWith(';')) { i = j; break; }
      if (j - i > 60) { i = j; break; } // pathological — give up on this decl
    }
    sigs.set(head[1], collapse(buf.join('\n')).replace(/^declare (?:function|const) /, ''));
  }
  return sigs;
}

/**
 * Type-only exports (interface/type/enum/class). Interfaces are EXPANDED to their
 * member list, aliases are only named: an interface is usually the thing an author
 * has to get right (`MountFs`, `ChatRequest`, `SandboxMount` — the shapes a call
 * takes or returns), while a union alias adds nothing a signature did not already say.
 */
function typesFor(moduleFile) {
  const path = join(sdkRoot, 'dist', `${moduleFile}.d.ts`);
  if (!existsSync(path)) return { names: new Set(), members: new Map() };
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const names = new Set();
  const members = new Map();
  const decl = /^(?:declare )?(?:interface|type|enum|class) ([A-Za-z_$][\w$]*)\b/;
  const iface = /^(?:declare )?interface ([A-Za-z_$][\w$]*)\b[^{]*\{$/;
  for (let i = 0; i < lines.length; i++) {
    const d = decl.exec(lines[i]);
    if (!d) continue;
    names.add(d[1]);
    const isIface = iface.exec(lines[i]);
    if (!isIface) continue;
    const body = [];
    let depth = 1;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      for (const ch of lines[j]) {
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      if (depth <= 0) { i = j; break; }
      const t = lines[j].trim();
      // Members only — drop the doc-comment lines TS emits between them.
      if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
      body.push(t);
    }
    if (body.length) members.set(d[1], body.slice(0, MAX_INTERFACE_MEMBERS));
  }
  return { names, members };
}

function build() {
  const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
  const barrel = readFileSync(join(sdkRoot, 'dist', 'index.d.ts'), 'utf8');
  const groups = parseBarrel(barrel);

  const lines = [];
  lines.push(`# @immediately-run/sdk ${pkg.version} — API map`);
  lines.push('');
  lines.push(
    'Everything below is exported from the package root: `import { chat, openFs } from "@immediately-run/sdk"`. ' +
      'Grouped by area. Signatures are the SDK\'s own published types for the exact version this app depends on — ' +
      'prefer them over anything you remember. A name that is not in this list does not exist.',
  );
  for (const { module, names } of groups) {
    const sigs = signaturesFor(module);
    const { names: typeNames, members } = typesFor(module);
    const values = [];
    const typeOnly = [];
    const expanded = [];
    for (const n of names) {
      if (sigs.has(n)) values.push(`  ${sigs.get(n)}`);
      else if (members.has(n)) expanded.push([n, members.get(n)]);
      else if (typeNames.has(n)) typeOnly.push(n);
      else values.push(`  ${n}`);
    }
    if (!values.length && !typeOnly.length && !expanded.length) continue;
    lines.push('');
    lines.push(`## ${module}`);
    if (values.length) lines.push(...values);
    for (const [n, body] of expanded) {
      lines.push(`  interface ${n} { ${collapse(body.join(' '))} }`);
    }
    if (typeOnly.length) lines.push(`  types: ${typeOnly.join(', ')}`);
  }
  lines.push('');

  const body = lines.join('\n');
  const banner =
    '// GENERATED by scripts/gen-sdk-skill.mjs from the installed @immediately-run/sdk\n' +
    '// type declarations — DO NOT EDIT. Regenerate with `npm run gen:sdk-skill`.\n' +
    '// `sdkApiMap.test.ts` fails when this file and the installed SDK disagree, so the\n' +
    '// map cannot drift away from the version this app pins (R3-331).\n';
  return (
    banner +
    `\n/** The SDK version this map was generated from. */\nexport const SDK_API_MAP_VERSION = ${JSON.stringify(pkg.version)};\n` +
    `\n/** Host-authored (machine-derived) SDK API map — the body of the \`sdk\` skill. */\nexport const SDK_API_MAP = ${JSON.stringify(body)};\n`
  );
}

const next = build();
if (process.argv.includes('--check')) {
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  if (current !== next) {
    console.error('sdkApiMap.generated.ts is STALE — run `npm run gen:sdk-skill`.');
    process.exit(1);
  }
  console.log('sdkApiMap.generated.ts is current.');
} else {
  writeFileSync(outFile, next);
  console.log(`wrote ${outFile} (${next.length} bytes)`);
}
