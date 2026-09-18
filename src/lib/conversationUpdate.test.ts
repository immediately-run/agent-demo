import { describe, it, expect, vi } from "vitest";

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings) —
// the same pattern conversationStore.test.ts uses.
vi.mock("@immediately-run/sdk", () => ({ openSettings: vi.fn() }));

import { createConversationStore, metaOf } from "./conversationStore";
import { MemFs } from "./testing/memStoreFs";
import { applyConversationUpdate } from "./conversationUpdate";

// Inputs come from the REAL fs-injected store (R2: one input per producer from
// calling that producer) — a conversation is created and saved through the store
// and its returned records drive the assertions, never a hand-typed literal.
const store = (fs: MemFs) =>
  createConversationStore({
    recordRoot: "/settings",
    fs,
    tabId: "tab-conversation-update",
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

  it("keeps an unchanged row's referential identity (same object in, same out)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const s = store(new MemFs());
    const first = await s.create("first");
    vi.setSystemTime(2000);
    const second = await s.create("second");
    const list = await s.list();

    // The stage saved only the SECOND conversation; the first row must survive
    // as the SAME object so render memoisation does not re-render it.
    vi.setSystemTime(3000);
    const saved = await s.save({ ...second, title: "second, renamed" });

    const next = applyConversationUpdate(list, metaOf(saved));
    expect(next.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(next.find((c) => c.id === first.id)).toBe(list[1]);
    vi.useRealTimers();
  });
});
