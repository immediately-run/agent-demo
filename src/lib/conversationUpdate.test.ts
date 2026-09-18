import { describe, it, expect, vi } from "vitest";

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings) —
// the same pattern conversationStore.test.ts uses.
vi.mock("@immediately-run/sdk", () => ({ openSettings: vi.fn() }));

import { createConversationStore } from "./conversationStore";
import { MemFs } from "./testing/memStoreFs";
import { applyConversationUpdate } from "./conversationUpdate";
import type { ConversationMeta } from "./conversationModel";

// Inputs come from the REAL fs-injected store (R2: one input per producer from
// calling that producer) — a conversation is created and saved through the store
// and its returned records drive the assertions, never a hand-typed literal.
const store = (fs: MemFs) => createConversationStore({ recordRoot: "/settings", fs });

const metaOf = (c: { id: string; title: string; createdAt: number; updatedAt: number; repo?: string }): ConversationMeta => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  ...(c.repo !== undefined ? { repo: c.repo } : {}),
});

describe("applyConversationUpdate — one message patches one row (R3-612 / R-IX-4)", () => {
  it("replaces the matching row, bumps it by updatedAt, and re-orders newest-first", async () => {
    const s = store(new MemFs());
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const older = await s.create("older");
    vi.setSystemTime(2000);
    const newer = await s.create("newer");
    const list = await s.list();
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);

    // The stage saved the OLDER conversation (retitled + re-stamped): its own
    // returned record, with a fresh updatedAt from the store's clock.
    vi.setSystemTime(3000);
    const saved = await s.save({ ...older, title: "older, renamed" });

    const next = applyConversationUpdate(list, metaOf(saved));
    expect(next.map((c) => c.id)).toEqual([older.id, newer.id]);
    expect(next.find((c) => c.id === older.id)?.title).toBe("older, renamed");
    // The untouched row is the same object — render memoisation survives.
    expect(next.find((c) => c.id === newer.id)).toBe(list[0]);
    vi.useRealTimers();
  });

  it("inserts a row the list has never seen at the head", async () => {
    const s = store(new MemFs());
    const made = await s.create("created elsewhere");
    const next = applyConversationUpdate([], metaOf(made));
    expect(next.map((c) => c.id)).toEqual([made.id]);
  });

  it("keeps an unchanged row's referential identity (same object in, same out)", () => {
    const a: ConversationMeta = { id: "a", title: "a", createdAt: 1, updatedAt: 1 };
    const b: ConversationMeta = { id: "b", title: "b", createdAt: 2, updatedAt: 2 };
    const next = applyConversationUpdate([a, b], { ...b, title: "b renamed" });
    expect(next.find((c) => c.id === "a")).toBe(a);
  });
});
