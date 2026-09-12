import { describe, it, expect, vi } from 'vitest';

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import { scopeConversations } from './conversationScope';
import { createConversationStore } from './conversationStore';
import { MemFs } from './testing/memStoreFs';
import type { ConversationMeta } from './conversationModel';

const meta = (id: string, repo: string | undefined, updatedAt: number): ConversationMeta => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  repo,
});

describe('scopeConversations', () => {
  it('keeps the current repo and legacy unstamped rows; groups the rest', () => {
    const { mine, others } = scopeConversations(
      [
        meta('a', 'acme/app', 5),
        meta('legacy', undefined, 4),
        meta('b', 'acme/other', 3),
        meta('c', 'acme/other', 9),
        meta('d', 'zorg/site', 1),
      ],
      'acme/app',
    );
    expect(mine.map((c) => c.id)).toEqual(['a', 'legacy']);
    expect(others).toEqual([
      { repo: 'acme/other', count: 2, updatedAt: 9 },
      { repo: 'zorg/site', count: 1, updatedAt: 1 },
    ]);
  });

  it('with no workspace conferred, only unstamped rows are mine', () => {
    const { mine, others } = scopeConversations([meta('a', 'acme/app', 2), meta('u', undefined, 1)], undefined);
    expect(mine.map((c) => c.id)).toEqual(['u']);
    expect(others).toEqual([{ repo: 'acme/app', count: 1, updatedAt: 2 }]);
  });
});

// The stamping half (R3-475), driven through the REAL store over an in-memory fs
// (§4: the producer of the metas the scope rule consumes).
describe('conversation repo stamping', () => {
  it('create stamps the repo and list projects it', async () => {
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    await store.create(undefined, 'acme/app');
    await store.create(); // unscoped (no workspace at creation)
    const metas = await store.list();
    expect(metas.map((m) => m.repo).sort()).toEqual(['acme/app', undefined].sort());
  });

  it('a legacy record is stamped by a later save and survives a reload', async () => {
    const fs = new MemFs();
    const store = createConversationStore({ root: '/settings', fs });
    const legacy = await store.create(); // unstamped
    await store.save({ ...legacy, repo: legacy.repo ?? 'acme/app' }); // the stage's save rule
    const reloaded = await createConversationStore({ root: '/settings', fs }).load(legacy.id);
    expect(reloaded?.repo).toBe('acme/app');
  });
});
