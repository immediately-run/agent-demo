import { describe, it, expect, vi, afterEach } from 'vitest';

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import { createConversationStore, deriveTitle, type StoreFs } from './conversationStore';
import type { Conversation } from './conversationModel';
import type { ChatMessage } from './agentLoop';

// In-memory StoreFs (same shape as fsTools.test.ts's MemFs, narrowed to the store's
// surface). Paths are absolute POSIX; directories are tracked so readdir works.
class MemFs implements StoreFs {
  files = new Map<string, string>();
  dirs = new Set<string>(['/']);
  private err(c: string): Error {
    return Object.assign(new Error(c), { code: c });
  }
  private addDirs(p: string) {
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
  }
  async readFile(path: string): Promise<string> {
    if (!this.files.has(path)) throw this.err('ENOENT');
    return this.files.get(path)!;
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.addDirs(path);
    this.files.set(path, data);
  }
  async mkdir(path: string): Promise<unknown> {
    let d = path;
    while (d) {
      this.dirs.add(d);
      d = d.slice(0, d.lastIndexOf('/'));
    }
    return undefined;
  }
  async readdir(path: string): Promise<{ name: string; isDirectory(): boolean }[]> {
    if (!this.dirs.has(path)) throw this.err('ENOENT');
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      if (f.startsWith(prefix) && f !== path) names.add(f.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((name) => ({ name, isDirectory: () => this.dirs.has(prefix + name) }));
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw this.err('ENOENT');
  }
}

const store = (fs: MemFs) => createConversationStore({ root: '/settings', fs });
const userMsg = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

afterEach(() => vi.useRealTimers());

describe('conversationStore — durable file-per-conversation store (Phase 01)', () => {
  it('create then load round-trips all fields', async () => {
    const s = store(new MemFs());
    const made = await s.create();
    const back = await s.load(made.id);
    expect(back).toEqual(made);
    expect(back?.schema).toBe(1);
    expect(back?.messages).toEqual([]);
  });

  it('list returns newest-first and skips a corrupt file', async () => {
    const fs = new MemFs();
    const s = store(fs);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const a = await s.create('older');
    vi.setSystemTime(2000);
    const b = await s.create('newer');
    // a hand-written corrupt record must not break list()
    fs.files.set('/settings/conversations/bad.json', '{ not json');
    const metas = await s.list();
    expect(metas.map((m) => m.id)).toEqual([b.id, a.id]);
    expect(metas).toHaveLength(2);
  });

  it('save bumps updatedAt', async () => {
    const s = store(new MemFs());
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const conv = await s.create();
    vi.setSystemTime(5000);
    await s.save({ ...conv, messages: [userMsg('hi')] });
    const back = await s.load(conv.id);
    expect(back?.updatedAt).toBe(5000);
    expect(back?.createdAt).toBe(1000);
  });

  it('rename changes only the title; remove deletes', async () => {
    const s = store(new MemFs());
    const conv = await s.create('first');
    await s.rename(conv.id, 'renamed');
    expect((await s.load(conv.id))?.title).toBe('renamed');
    await s.remove(conv.id);
    expect(await s.load(conv.id)).toBeNull();
    await expect(s.remove(conv.id)).resolves.toBeUndefined(); // idempotent
  });

  it('persists across a fresh store over the same fs (durability / reload)', async () => {
    const fs = new MemFs();
    const written: Conversation = { ...(await store(fs).create('keep')), messages: [userMsg('remember me')] };
    await store(fs).save(written);
    // a brand-new store instance over the same backing fs sees the prior write
    const reloaded = await store(fs).load(written.id);
    expect(reloaded?.title).toBe('keep');
    expect(reloaded?.messages).toEqual([userMsg('remember me')]);
  });

  it('deriveTitle uses the first user text, truncated; empty → default', () => {
    expect(deriveTitle([userMsg('Add a dark mode toggle')])).toBe('Add a dark mode toggle');
    expect(deriveTitle([])).toBe('New conversation');
    const long = 'x'.repeat(120);
    const title = deriveTitle([userMsg(long)]);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });
});
