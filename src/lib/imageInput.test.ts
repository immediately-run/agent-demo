// R3-339 — image input. Both ends already existed: `chat()` accepts image parts under
// `features.vision`, and the fs port reads bytes. What was missing was the middle — a
// tool result that carries an image, and a loop that passes it through instead of
// stringifying it.

import { describe, it, expect } from 'vitest';
import { createFsToolset, imageMimeFor, type FsDirent, type FsPortLike, type FsStat } from './fsTools';
import {
  compactTranscript,
  estimateTokens,
  runAgent,
  type ChatMessage,
  type ModelClient,
} from './agentLoop';
import { messagesToLog } from './transcript';
import type { AgentTool } from './agentTools';

class Mem implements FsPortLike {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/', '/app']);
  constructor(seed: Record<string, string | Uint8Array> = {}) {
    for (const [k, v] of Object.entries(seed)) {
      this.files.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v);
      let d = k.slice(0, k.lastIndexOf('/'));
      while (d) {
        this.dirs.add(d);
        d = d.slice(0, d.lastIndexOf('/'));
      }
    }
  }
  private err(code: string): Error {
    return Object.assign(new Error(code), { code });
  }
  async readFile(path: string, encoding?: 'utf8'): Promise<string & Uint8Array> {
    const b = this.files.get(path);
    if (!b) throw this.err('ENOENT');
    // `fatal: true` is what a real UTF-8 read does to non-text bytes: it throws.
    return (encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(b) : b) as string & Uint8Array;
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
  async rename(): Promise<void> {}
  async mkdir(): Promise<unknown> {
    return undefined;
  }
  async readdir(): Promise<FsDirent[]> {
    return [];
  }
  async stat(path: string): Promise<FsStat> {
    const b = this.files.get(path);
    if (!b) throw this.err('ENOENT');
    return { size: b.length, mtimeMs: 1, isFile: () => true, isDirectory: () => false };
  }
  async unlink(): Promise<void> {}
}

// A real PNG header — NUL byte and a lone 0xFF, so a UTF-8 read genuinely throws.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x42]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n';

const mk = (seed: Record<string, string | Uint8Array>, vision = true) =>
  createFsToolset({ root: '/app', fs: new Mem(seed), vision });

describe('imageMimeFor mirrors the SDK table for what the transport can carry', () => {
  it('recognises the raster types, case-insensitively', () => {
    expect(imageMimeFor('a/b/logo.PNG')).toBe('image/png');
    expect(imageMimeFor('x.jpg')).toBe('image/jpeg');
    expect(imageMimeFor('x.jpeg')).toBe('image/jpeg');
    for (const [ext, mime] of [
      ['gif', 'image/gif'],
      ['webp', 'image/webp'],
      ['avif', 'image/avif'],
      ['bmp', 'image/bmp'],
      ['ico', 'image/x-icon'],
    ] as const) {
      expect(imageMimeFor(`x.${ext}`)).toBe(mime);
    }
  });

  it('deliberately EXCLUDES .svg — it is text, and it is source you may want to edit', () => {
    expect(imageMimeFor('icon.svg')).toBeUndefined();
  });

  it('is not fooled by a path with no extension, or a directory that looks like one', () => {
    expect(imageMimeFor('Makefile')).toBeUndefined();
    expect(imageMimeFor('png/readme')).toBeUndefined();
  });
});

describe('exit 1 — read_file hands over a picture, not mangled bytes', () => {
  it('returns an image part with the right MIME and base64', async () => {
    const res = await mk({ '/app/assets/mock.png': PNG }).execute('read_file', { path: 'assets/mock.png' });
    expect(res.isError).toBeFalsy();
    expect(res.images).toHaveLength(1);
    expect(res.images![0].mimeType).toBe('image/png');
    // Round-trips byte-for-byte.
    const back = Uint8Array.from(atob(res.images![0].data), (c) => c.charCodeAt(0));
    expect([...back]).toEqual([...PNG]);
    // The text half tells the model what it is looking at.
    expect(res.content).toContain('assets/mock.png');
    expect(res.content).toContain('image/png');
  });

  it('the loop THREADS it into the next request instead of stringifying it', async () => {
    const ts = mk({ '/app/mock.png': PNG });
    const sent: ChatMessage[][] = [];
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        sent.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        turn++;
        if (turn === 1) {
          return {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'mock.png' } }],
          };
        }
        // The model can now answer about the image because it is in the request.
        const sawImage = req.messages.some((m) => m.content.some((b) => b.type === 'image'));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: sawImage ? 'It is a PNG.' : 'I cannot see it.' }] };
      },
    };
    const tools: AgentTool[] = ts.tools;
    const transcript = await runAgent({ client, tools, execute: ts.execute, prompt: 'what is in mock.png?', maxTurns: 4 });

    const image = sent[1].flatMap((m) => m.content).find((b) => b.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    // It rides in the SAME user message as the tool results, after them — the shape the
    // host adapters map.
    const userMsg = sent[1].find((m) => m.content.some((b) => b.type === 'image'))!;
    const kinds = userMsg.content.map((b) => b.type);
    expect(kinds.indexOf('tool_result')).toBeLessThan(kinds.indexOf('image'));
    expect(JSON.stringify(transcript)).toContain('It is a PNG.');
  });

  it('counts toward the context budget rather than escaping the accounting', () => {
    const withImage: ChatMessage[] = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(4000) }] }];
    expect(estimateTokens(withImage)).toBe(1000);
  });
});

describe('exit 2 — a non-image binary is refused BY NAME, not as "unreadable"', () => {
  it('says what it is and that read_file cannot show it', async () => {
    const res = await mk({ '/app/archive.zip': ZIP }).execute('read_file', { path: 'archive.zip' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('a .zip file');
    expect(res.content).toContain('not UTF-8 text');
    expect(res.images).toBeUndefined();
  });

  it('an .svg reads as TEXT — predictably, because it is also source', async () => {
    const res = await mk({ '/app/icon.svg': SVG }).execute('read_file', { path: 'icon.svg' });
    expect(res.isError).toBeFalsy();
    expect(res.images).toBeUndefined();
    expect(res.content).toContain('<rect');
  });

  it('ordinary text files are untouched by any of this', async () => {
    const res = await mk({ '/app/a.ts': 'export const a = 1;\n' }).execute('read_file', { path: 'a.ts' });
    expect(res.content).toBe('export const a = 1;\n');
    expect(res.images).toBeUndefined();
  });
});

describe('exit 3 — on a provider without vision the tool SAYS so and the loop continues', () => {
  it('refuses with an explanation rather than sending something that errors upstream', async () => {
    const res = await mk({ '/app/mock.png': PNG }, false).execute('read_file', { path: 'mock.png' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('cannot accept images');
    expect(res.images).toBeUndefined();
  });

  it('the run carries on — no image part is ever produced', async () => {
    const ts = mk({ '/app/mock.png': PNG }, false);
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        if (turn === 1) {
          return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'mock.png' } }] };
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'I described it from the code instead.' }] };
      },
    };
    const transcript = await runAgent({ client, tools: ts.tools, execute: ts.execute, prompt: 'look', maxTurns: 4 });
    expect(transcript.flatMap((m) => m.content).some((b) => b.type === 'image')).toBe(false);
    expect(JSON.stringify(transcript)).toContain('described it from the code');
  });

  it('defaults to no vision — a caller that does not know must not gamble', async () => {
    const ts = createFsToolset({ root: '/app', fs: new Mem({ '/app/a.png': PNG }) });
    expect((await ts.execute('read_file', { path: 'a.png' })).isError).toBe(true);
  });
});

describe('exit 4 — an oversize image is refused BEFORE it is sent, and the cap is named', () => {
  it('names the size and the limit', async () => {
    const huge = new Uint8Array(1_500 * 1024 + 1);
    huge[0] = 0x89;
    const res = await mk({ '/app/huge.png': huge }).execute('read_file', { path: 'huge.png' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('1536000-byte image limit');
    expect(res.content).toContain(String(huge.length));
    // Truncating an image does not make a smaller image, it makes a corrupt one.
    expect(res.images).toBeUndefined();
  });
});

describe('exit 5 — replay and compaction do not corrupt a conversation containing an image', () => {
  it('renders the image as its own row on replay', () => {
    const stored: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.png' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '[image a.png — image/png, 11 bytes]' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      },
    ];
    expect(messagesToLog(stored).map((e) => e.kind)).toEqual(['tool', 'result', 'image']);
    expect(JSON.parse(JSON.stringify(messagesToLog(stored)))).toEqual(messagesToLog(stored));
  });

  it('compaction DROPS image parts by an explicit rule, without breaking the sequence', async () => {
    const summarizer: ModelClient = {
      async createMessage() {
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'SUMMARY' }] };
      },
    };
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] });
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: `[image ${i}.png]` },
          { type: 'image', mimeType: 'image/png', data: 'Z'.repeat(50) },
        ],
      });
    }
    const out = await compactTranscript(messages, summarizer, 4);
    expect(out.summarizedCount).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).not.toContain('ZZZ');
    // The tool_result that NAMED the image survives, so the model still knows it looked.
    expect(JSON.stringify(out.messages)).toContain('[image');
    // Every tool_use still has its tool_result, and no message was left content-less.
    const uses = out.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use');
    const results = out.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results.length).toBe(uses.length);
    for (const m of out.messages) expect(m.content.length).toBeGreaterThan(0);
  });
});

describe('the tool description tells the model what will happen', () => {
  it('names the image types and the .svg exception', () => {
    const desc = mk({}).tools.find((t) => t.name === 'read_file')!.description;
    expect(desc).toContain('png');
    expect(desc).toContain('.svg');
  });

  it('an escaping path is still just "not found", image or not', async () => {
    const res = await mk({ '/etc/secret.png': PNG }).execute('read_file', { path: '../../etc/secret.png' });
    expect(res).toEqual({ content: 'not found', isError: true });
  });
});
