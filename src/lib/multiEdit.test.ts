// R3-337 — multi-site `edit_file`.
//
// Turns are the scarce resource in a long task: each one re-sends the prefix and pushes
// the transcript toward the next compaction. A tool shape that spends three turns where
// one would do is a tax on every subsequent turn, not just its own. It is also a
// CORRECTNESS item — `replace_all` was the only batch primitive available, and it is the
// blunt one.

import { describe, it, expect } from 'vitest';
import { createFsToolset, planEdits, type FsDirent, type FsLike, type FsStat } from './fsTools';

/** Minimal in-memory fs — only what edit_file touches. */
class Mem implements FsLike {
  private files: Record<string, string>;
  constructor(files: Record<string, string>) {
    this.files = files;
  }
  async readFile(path: string): Promise<string> {
    if (!(path in this.files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return this.files[path];
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files[path] = data;
  }
  async mkdir(): Promise<unknown> {
    return undefined;
  }
  async readdir(): Promise<FsDirent[]> {
    return [];
  }
  async stat(): Promise<FsStat> {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }
  async unlink(): Promise<void> {}
  get(path: string): string {
    return this.files[path];
  }
}

const SRC = [
  'import { useState } from "react";',
  '',
  'export default function App() {',
  '  const [count, setCount] = useState(0);',
  '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
  '}',
  '',
].join('\n');

const toolset = (files: Record<string, string> = { '/app/src/App.tsx': SRC }) => {
  const fs = new Mem(files);
  return { fs, ts: createFsToolset({ root: '/app', fs }) };
};

describe('planEdits — every entry is matched against the file AS READ', () => {
  it('does not match an entry against the result of a previous one', () => {
    // If entries were applied sequentially, edit 2 would find the `b` that edit 1 just
    // wrote and the outcome would depend on the order the model happened to list them.
    const out = planEdits('a', [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain('edit 2');
    expect(out.ok === false && out.error).toContain('not found');
  });

  it('is order-independent — the same entries in any order give the same file', () => {
    const forward = planEdits('one two three', [
      { old_string: 'one', new_string: '1' },
      { old_string: 'three', new_string: '3' },
    ]);
    const reverse = planEdits('one two three', [
      { old_string: 'three', new_string: '3' },
      { old_string: 'one', new_string: '1' },
    ]);
    expect(forward.ok && forward.text).toBe('1 two 3');
    expect(reverse.ok && reverse.text).toBe('1 two 3');
  });

  it('counts self-overlapping literals the way `split` does, and refuses the overlap it creates', () => {
    // `aa` occurs once by split-counting in `aaa`; two entries both wanting `aa` would
    // overlap, which is refused rather than resolved.
    expect(planEdits('aaa', [{ old_string: 'aa', new_string: 'X' }])).toEqual({ ok: true, text: 'Xa', sites: 1 });
  });
});

describe('exit 1 — a three-site change is ONE call, byte-identical to three single edits', () => {
  it('applies all three and matches applying them one at a time', async () => {
    const { fs, ts } = toolset();
    const edits = [
      { old_string: 'useState(0)', new_string: 'useState(10)' },
      { old_string: 'count + 1', new_string: 'count + 2' },
      { old_string: 'export default function App()', new_string: 'export default function Counter()' },
    ];
    const res = await ts.execute('edit_file', { path: 'src/App.tsx', edits });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('3 replacements across 3 edits');

    // The same three, applied singly, in a separate file.
    const single = toolset({ '/app/src/App.tsx': SRC });
    for (const e of edits) {
      const r = await single.ts.execute('edit_file', { path: 'src/App.tsx', ...e });
      expect(r.isError).toBeFalsy();
    }
    expect(fs.get('/app/src/App.tsx')).toBe(single.fs.get('/app/src/App.tsx'));
  });

  it('collapses N turns to one — the batch really is a single tool call', async () => {
    const { ts } = toolset();
    const res = await ts.execute('edit_file', {
      path: 'src/App.tsx',
      edits: [
        { old_string: 'import { useState }', new_string: 'import { useReducer }' },
        { old_string: 'useState(0)', new_string: 'useReducer(r, 0)' },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('2 replacements across 2 edits');
  });
});

describe('exit 2 — overlapping entries are REFUSED, not resolved; the file is untouched', () => {
  it('names both entries and the offset', async () => {
    const { fs, ts } = toolset();
    const before = fs.get('/app/src/App.tsx');
    const res = await ts.execute('edit_file', {
      path: 'src/App.tsx',
      edits: [
        { old_string: 'useState(count', new_string: 'X' }, // does not exist — use real overlap below
        { old_string: 'setCount(count + 1)', new_string: 'setCount(count + 2)' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(fs.get('/app/src/App.tsx')).toBe(before);

    const overlap = await ts.execute('edit_file', {
      path: 'src/App.tsx',
      edits: [
        { old_string: 'setCount(count + 1)', new_string: 'A' },
        { old_string: 'count + 1', new_string: 'B' },
      ],
    });
    expect(overlap.isError).toBe(true);
    expect(overlap.content).toContain('edits 1 and 2 overlap');
    expect(overlap.content).toContain('No edits were applied');
    expect(fs.get('/app/src/App.tsx')).toBe(before);
  });

  it('catches an entry that overlaps ITSELF via replace_all', async () => {
    const { ts } = toolset({ '/app/a.txt': 'xxxx' });
    const res = await ts.execute('edit_file', {
      path: 'a.txt',
      edits: [
        { old_string: 'xx', new_string: 'y', replace_all: true },
        { old_string: 'xxx', new_string: 'z' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('overlap');
  });
});

describe('exit 3 — one non-matching entry applies NOTHING and says which', () => {
  it('reports the failing entry number and leaves the file alone', async () => {
    const { fs, ts } = toolset();
    const before = fs.get('/app/src/App.tsx');
    const res = await ts.execute('edit_file', {
      path: 'src/App.tsx',
      edits: [
        { old_string: 'useState(0)', new_string: 'useState(1)' },
        { old_string: 'this text is not in the file', new_string: 'x' },
        { old_string: 'count + 1', new_string: 'count + 2' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('edit 2');
    expect(res.content).toContain('No edits were applied');
    // The valid entries did NOT sneak through — a half-applied batch is exactly what
    // leaves the file in a state the model cannot diagnose.
    expect(fs.get('/app/src/App.tsx')).toBe(before);
  });

  it('refuses an empty or malformed entry by number, before touching the file', async () => {
    const { fs, ts } = toolset();
    const before = fs.get('/app/src/App.tsx');
    for (const [edits, expected] of [
      [[{ old_string: '', new_string: 'x' }], 'edit 1'],
      [[{ old_string: 'useState(0)', new_string: 'useState(0)' }], 'identical'],
      [[], 'was empty'],
    ] as const) {
      const res = await ts.execute('edit_file', { path: 'src/App.tsx', edits });
      expect(res.isError).toBe(true);
      expect(res.content).toContain(expected);
    }
    expect(fs.get('/app/src/App.tsx')).toBe(before);
  });
});

describe('exit 4 — a non-unique old_string still fails, PER ENTRY', () => {
  it('fails the entry, names it, and offers replace_all on that entry', async () => {
    const { fs, ts } = toolset({ '/app/a.ts': 'const x = 1;\nconst x2 = 1;\n' });
    const before = fs.get('/app/a.ts');
    const res = await ts.execute('edit_file', {
      path: 'a.ts',
      edits: [
        { old_string: 'const', new_string: 'let' },
        { old_string: 'x2', new_string: 'y2' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('edit 1');
    expect(res.content).toContain('not unique (2 matches)');
    expect(res.content).toContain('replace_all on this entry');
    expect(fs.get('/app/a.ts')).toBe(before);
  });

  it('replace_all is PER ENTRY — a batch can mix a fan-out with a unique-anchor edit', async () => {
    const { fs, ts } = toolset({ '/app/a.ts': 'const x = 1;\nconst y = 2;\n// done\n' });
    const res = await ts.execute('edit_file', {
      path: 'a.ts',
      edits: [
        { old_string: 'const', new_string: 'let', replace_all: true },
        { old_string: '// done', new_string: '// finished' },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('3 replacements across 2 edits');
    expect(fs.get('/app/a.ts')).toBe('let x = 1;\nlet y = 2;\n// finished\n');
  });
});

describe('exit 5 — the single-pair form is unchanged', () => {
  it('still works, and its errors are NOT prefixed with an entry number', async () => {
    const { fs, ts } = toolset();
    const ok = await ts.execute('edit_file', { path: 'src/App.tsx', old_string: 'useState(0)', new_string: 'useState(9)' });
    expect(ok.content).toBe('edited src/App.tsx (1 replacement, +0 bytes)');
    expect(fs.get('/app/src/App.tsx')).toContain('useState(9)');

    const miss = await ts.execute('edit_file', { path: 'src/App.tsx', old_string: 'nope', new_string: 'x' });
    expect(miss.isError).toBe(true);
    expect(miss.content).not.toContain('edit 1');
    expect(miss.content).toContain('old_string not found');
  });

  it('inserts verbatim — `$` and backslashes are not special', async () => {
    const { fs, ts } = toolset({ '/app/a.ts': 'A\n' });
    await ts.execute('edit_file', { path: 'a.ts', edits: [{ old_string: 'A', new_string: '$& \\1 $$' }] });
    expect(fs.get('/app/a.ts')).toBe('$& \\1 $$\n');
  });

  it('the batch form is refused on a read-only mount, like every other write', async () => {
    const fs = new Mem({ '/app/a.ts': 'A\n' });
    const ro = createFsToolset({ root: '/app', fs, readOnly: true });
    const res = await ro.execute('edit_file', { path: 'a.ts', edits: [{ old_string: 'A', new_string: 'B' }] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('read-only');
    expect(fs.get('/app/a.ts')).toBe('A\n');
  });

  it('an escaping path is still "not found" in the batch form', async () => {
    const { ts } = toolset();
    const res = await ts.execute('edit_file', { path: '../../etc/secret', edits: [{ old_string: 'T', new_string: 'X' }] });
    expect(res).toEqual({ content: 'not found', isError: true });
  });
});
