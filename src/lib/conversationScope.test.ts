import { describe, it, expect, vi } from 'vitest';

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import { repoCoordinatesOf, scopeConversations } from './conversationScope';
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
    const store = createConversationStore({ recordRoot: '/settings', fs: new MemFs(), tabId: 'tab-test' });
    await store.create(undefined, 'acme/app');
    await store.create(); // unscoped (no workspace at creation)
    const metas = await store.list();
    expect(metas.map((m) => m.repo).sort()).toEqual(['acme/app', undefined].sort());
  });

  it('a legacy record is stamped by a later save and survives a reload', async () => {
    const fs = new MemFs();
    const store = createConversationStore({ recordRoot: '/settings', fs, tabId: 'tab-test' });
    const legacy = await store.create(); // unstamped
    await store.save({ ...legacy, repo: legacy.repo ?? 'acme/app' }); // the stage's save rule
    const reloaded = await createConversationStore({ recordRoot: '/settings', fs, tabId: 'tab-test' }).load(legacy.id);
    expect(reloaded?.repo).toBe('acme/app');
  });
});

// ── R3-848 — the group carries the newest member's provider stamp ────────────
describe("RepoGroup.provider (R3-848)", () => {
  const meta = (id: string, repo: string | undefined, repoProvider?: string) => ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(repo ? { repo, ...(repoProvider ? { repoProvider } : {}) } : {}),
  });
  it("a group formed from a stamped member carries its provider", () => {
    const { others } = scopeConversations([meta("a", "other/repo", "github")], "mine/repo");
    expect(others).toHaveLength(1);
    expect(others[0].provider).toBe("github");
  });
  it("a legacy group (no member stamped) carries none — the row defaults, honestly", () => {
    const { others } = scopeConversations([meta("a", "old/repo")], "mine/repo");
    expect(others).toHaveLength(1);
    expect(others[0].provider).toBeUndefined();
  });
});

// ── R3-848 — repoCoordinatesOf: the shape class, and never a guess ───────────
describe("repoCoordinatesOf (R3-848)", () => {
  const g = (repo: string, provider?: string) => ({ repo, count: 1, updatedAt: 1, ...(provider ? { provider } : {}) });
  it("a stamped group splits its label at the first slash", () => {
    expect(repoCoordinatesOf(g("other/repo", "github"))).toEqual({
      provider: "github",
      namespace: "other",
      repository: "repo",
    });
  });
  it("a deeper label keeps the rest in the repository (only the first slash splits)", () => {
    expect(repoCoordinatesOf(g("a/b/c", "github"))).toEqual({
      provider: "github",
      namespace: "a",
      repository: "b/c",
    });
  });
  it("a label with no slash, a leading slash, or an empty repository is refused (null)", () => {
    expect(repoCoordinatesOf(g("noslash", "github"))).toBeNull();
    expect(repoCoordinatesOf(g("/leading", "github"))).toBeNull();
    expect(repoCoordinatesOf(g("a/", "github"))).toBeNull();
  });
  it("an unstamped group is refused — the provider is never guessed", () => {
    expect(repoCoordinatesOf(g("other/repo"))).toBeNull();
  });
  it("a merge prefers a defined stamp: a legacy creator never pins a stamped joiner", () => {
    const { others } = scopeConversations(
      [
        { id: "legacy", title: "l", createdAt: 2, updatedAt: 2, repo: "r/x" },
        { id: "stamped", title: "s", createdAt: 1, updatedAt: 1, repo: "r/x", repoProvider: "github" },
      ],
      "mine/x",
    );
    expect(others[0]?.provider).toBe("github");
  });
});
