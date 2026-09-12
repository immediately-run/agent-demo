import { describe, it, expect, vi, afterEach } from 'vitest';

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (mirrors the sibling store/scope tests).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import { createStageSelection } from './stageSelection';
import { createConversationStore } from './conversationStore';
import { MemFs } from './testing/memStoreFs';
import type { Conversation } from './conversationModel';

/** A promise whose resolution the test controls — to hold a `store.load` in flight. */
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const REPO = 'acme/app';
const shownOf = (id: string) => expect.objectContaining({ id });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createStageSelection (plan 05 / R3-594)', () => {
  it('a selection that precedes the store shows that conversation, never the newest', async () => {
    vi.useFakeTimers();
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    vi.setSystemTime(1000);
    const older = await store.create('older', REPO);
    vi.setSystemTime(2000);
    const newest = await store.create('newest', REPO);

    const show = vi.fn();
    const stage = createStageSelection({ show });
    const heldSelect = stage.select(older.id); // store not open yet → held
    await stage.storeOpened(store, REPO);

    await expect(heldSelect).resolves.toBe('shown');
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(shownOf(older.id));
    expect(show).not.toHaveBeenCalledWith(shownOf(newest.id));
  });

  it('with no selection, the store shows the newest in scope, never another repo', async () => {
    vi.useFakeTimers();
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    vi.setSystemTime(1000);
    await store.create('mine-older', REPO);
    vi.setSystemTime(3000);
    const other = await store.create('other-newer', 'zorg/site'); // newer, other repo
    vi.setSystemTime(2000);
    const mineNewest = await store.create('mine-newest', REPO);

    const show = vi.fn();
    const stage = createStageSelection({ show });
    await stage.storeOpened(store, REPO);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(shownOf(mineNewest.id));
    expect(show).not.toHaveBeenCalledWith(shownOf(other.id));
  });

  it('a select during the fallback load wins, and the fallback resolves superseded', async () => {
    vi.useFakeTimers();
    const fs = new MemFs();
    const store = createConversationStore({ root: '/settings', fs });
    vi.setSystemTime(1000);
    const older = await store.create('older', REPO);
    vi.setSystemTime(2000);
    const newest = await store.create('newest', REPO);

    // Hold the fallback's load of `newest` so `select` lands while it is in flight.
    const gate = deferred<Conversation | null>();
    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation((id: string) => {
      if (id === newest.id) return gate.promise;
      return realLoad(id);
    });

    const show = vi.fn();
    const stage = createStageSelection({ show });
    const fallback = stage.storeOpened(store, REPO); // newest, deferred
    const selected = stage.select(older.id); // older, immediate

    await expect(selected).resolves.toBe('shown');
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(shownOf(older.id));

    gate.resolve(newest); // the fallback's late result must be discarded
    await expect(fallback).resolves.toBe('superseded');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('two selections resolve to the later one even when the first load finishes last', async () => {
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    const show = vi.fn();
    const stage = createStageSelection({ show });
    await stage.storeOpened(store, REPO); // empty → fallback shows nothing

    const a = await store.create('a', REPO);
    const b = await store.create('b', REPO);

    const gate = deferred<Conversation | null>();
    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation((id: string) => (id === a.id ? gate.promise : realLoad(id)));

    const pA = stage.select(a.id); // deferred
    const pB = stage.select(b.id); // immediate

    await expect(pB).resolves.toBe('shown');
    expect(show).toHaveBeenCalledWith(shownOf(b.id));

    gate.resolve(a); // a's load finishes last
    await expect(pA).resolves.toBe('superseded');
    expect(show).not.toHaveBeenCalledWith(shownOf(a.id));
  });

  it('adopting a new conversation discards an in-flight fallback', async () => {
    vi.useFakeTimers();
    const fs = new MemFs();
    const store = createConversationStore({ root: '/settings', fs });
    vi.setSystemTime(1000);
    const newest = await store.create('newest', REPO);

    const gate = deferred<Conversation | null>();
    const realLoad = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation((id: string) => (id === newest.id ? gate.promise : realLoad(id)));

    const show = vi.fn();
    const stage = createStageSelection({ show });
    const fallback = stage.storeOpened(store, REPO); // newest, deferred

    const adopted: Conversation = {
      id: 'adopted',
      title: 'Adopted',
      createdAt: 1,
      updatedAt: 1,
      schema: 1,
      messages: [],
    };
    stage.adopt(adopted);

    expect(show).toHaveBeenCalledWith(shownOf('adopted'));

    gate.resolve(newest);
    await expect(fallback).resolves.toBe('superseded');
    expect(show).toHaveBeenCalledTimes(1); // adopted only — newest never shown
  });

  it("selecting a deleted conversation resolves 'missing' and shows nothing", async () => {
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    const show = vi.fn();
    const stage = createStageSelection({ show });
    await stage.storeOpened(store, REPO); // empty → fallback shows nothing

    await expect(stage.select('does-not-exist')).resolves.toBe('missing');
    expect(show).not.toHaveBeenCalled();
  });
});
