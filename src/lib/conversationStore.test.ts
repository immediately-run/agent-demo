import { describe, it, expect, vi, afterEach } from 'vitest';

// The store module imports `openSettings` from the SDK barrel; mock it so vitest
// doesn't load the full SDK (these tests use the fs-injected core, not openSettings).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import { createConversationStore, deriveTitle } from './conversationStore';
import { LEASE_HEARTBEAT_MS, LEASE_TTL_MS, parseLease } from './lease';
import { MemFs } from './testing/memStoreFs';
import type { Conversation } from './conversationModel';
import type { ChatMessage } from './agentLoop';

const store = (fs: MemFs) => createConversationStore({ recordRoot: '/settings', fs, tabId: 'tab-test' });
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

// ---- R3-559: the two-tier checkpoint journal (AGENT_RUN_DURABILITY_SPEC §4) --------

import { runAgent, type LoopBoundary, type RunState, type ModelClient } from './agentLoop';
import type { AgentTool } from './agentTools';
import type { JournalEntry } from './conversationStore';

const TOOLS: AgentTool[] = [
  { name: 'spaces__share', description: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: true } },
];

const twoTier = (fs: MemFs) =>
  createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
const journalless = (fs: MemFs) => createConversationStore({ recordRoot: '/settings', fs, tabId: 'tab-test' });

const entryFiles = (fs: MemFs, id: string): [string, JournalEntry][] =>
  [...fs.files.entries()]
    .filter(([p]) => p.startsWith(`/local/conversations/${id}/journal/`))
    .map(([p, v]) => [p, JSON.parse(v) as JournalEntry] as [string, JournalEntry])
    .sort((a, b) => a[1].seq - b[1].seq);

const b = (kind: LoopBoundary['kind'], extra: Partial<LoopBoundary> = {}): LoopBoundary =>
  ({ kind, t: 1, ...extra } as LoopBoundary);

describe('conversationStore — journal append (R-ARD-5/5a/5b)', () => {
  it('appends one immutable entry file per boundary, in a SUBDIRECTORY of the conversation (never a sibling of records)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    const seq1 = await s.append(conv.id, b('B0', { messages: [userMsg('hi')] }));
    const seq2 = await s.append(conv.id, b('B5', { message: userMsg('nudge') }));
    expect(seq2).toBe(seq1 + 1);
    const [path1, e1] = entryFiles(fs, conv.id)[0];
    // The layout rule: under conversations/<id>/journal/, NOT under conversations/.
    expect(path1).toBe(`/local/conversations/${conv.id}/journal/${seq1}.json`);
    expect(e1.kind).toBe('B0');
    expect(e1.schema).toBe(1);
    // The record itself is untouched by appends — the synced tier is not in the
    // loop's hot path (R-ARD-6).
    expect([...fs.files.keys()].filter((p) => p.startsWith('/settings/conversations/'))).toEqual([
      `/settings/conversations/${conv.id}.json`,
    ]);
  });

  it('seq mints ABOVE the fold watermark after entries were reclaimed (no collision)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    const s1 = await s.append(conv.id, b('B0', { messages: [userMsg('hi')] }));
    await s.fold(conv.id, { messages: [userMsg('hi')] });
    // fold reclaimed the entry; the next append must still mint s1+1, not 1.
    const next = await s.append(conv.id, b('B5', { message: userMsg('again') }));
    expect(next).toBe(s1 + 1);
  });

  it('rejects journal-unavailable on a journalless store, loudly (R-ARD-10)', async () => {
    const s = journalless(new MemFs());
    const conv = await s.create();
    await expect(s.append(conv.id, b('B4', { runState: {} as RunState }))).rejects.toMatchObject({
      code: 'journal-unavailable',
    });
  });

  it('truncates an oversized result/image to a bounded head/tail with a marker — the entry only, never the payload (G-ARD-15 / R-ARD-5b)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    const huge = 'x'.repeat(300 * 1024);
    await s.append(conv.id, {
      kind: 'B3',
      t: 1,
      effectId: 'e1',
      result: { type: 'tool_result', tool_use_id: 'tu', content: huge },
      images: [{ type: 'image', mimeType: 'image/png', data: huge }],
    });
    const [, e] = entryFiles(fs, conv.id)[0];
    expect((e.result?.content ?? '').length).toBeLessThan(300 * 1024);
    expect(e.result?.content).toContain('[checkpoint truncated:');
    expect(e.result?.content?.startsWith('x')).toBe(true); // head kept
    expect(e.result?.content?.endsWith('x')).toBe(true); // tail kept
    expect((e.images?.[0]?.data ?? '').length).toBeLessThan(300 * 1024);
  });
});

describe('conversationStore — replay (R-ARD-5 / R-ARD-7a)', () => {
  it('assembles a partially-filled results message: B3s of one batch share one user message, results before images', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    await s.append(conv.id, b('B1', { blocks: [{ type: 'tool_use', id: 'tuA', name: 't', input: {} }, { type: 'tool_use', id: 'tuB', name: 't', input: {} }] }));
    await s.append(conv.id, b('B2', { effectId: 'eA', call: { type: 'tool_use', id: 'tuA', name: 't', input: {} } }));
    await s.append(conv.id, b('B3', { effectId: 'eA', result: { type: 'tool_result', tool_use_id: 'tuA', content: 'ra' } }));
    // Teardown HERE: tuB's B2 is durable, its B3 never lands.
    await s.append(conv.id, b('B2', { effectId: 'eB', call: { type: 'tool_use', id: 'tuB', name: 't', input: {} } }));
    const replayed = await s.replay(conv.id);
    const last = replayed.messages[replayed.messages.length - 1];
    expect(last).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tuA', content: 'ra' }],
    });
    expect(replayed.pendingEffects).toEqual([{ effectId: 'eB', toolUseId: 'tuB', name: 't' }]);
  });

  it('images ride the results message AFTER the results, matching the in-memory shape', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    // The assistant turn carries the tool_use blocks (the realistic shape — the
    // executor never runs a call the transcript does not show being issued).
    await s.append(
      conv.id,
      b('B1', {
        blocks: [
          { type: 'tool_use', id: 'tuA', name: 't', input: {} },
          { type: 'tool_use', id: 'tuB', name: 't', input: {} },
        ],
      }),
    );
    await s.append(conv.id, b('B2', { effectId: 'eA', call: { type: 'tool_use', id: 'tuA', name: 't', input: {} } }));
    await s.append(
      conv.id,
      b('B3', {
        effectId: 'eA',
        result: { type: 'tool_result', tool_use_id: 'tuA', content: 'ra' },
        images: [{ type: 'image', mimeType: 'image/png', data: 'zz' }],
      }),
    );
    await s.append(conv.id, b('B2', { effectId: 'eB', call: { type: 'tool_use', id: 'tuB', name: 't', input: {} } }));
    await s.append(conv.id, b('B3', { effectId: 'eB', result: { type: 'tool_result', tool_use_id: 'tuB', content: 'rb' } }));
    const replayed = await s.replay(conv.id);
    const last = replayed.messages[replayed.messages.length - 1];
    expect(last.content.map((x) => x.type)).toEqual(['tool_result', 'tool_result', 'image']);
  });

  it('B0 REPLACES the transcript (history is not duplicated against an older record)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    // A record already holding the prior turns (the pre-run state).
    const history: import('./agentLoop').ChatMessage[] = [
      userMsg('q1'),
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ];
    await s.save({ ...conv, messages: history });
    await s.append(conv.id, b('B0', { messages: [...history, userMsg('q2')] }));
    const replayed = await s.replay(conv.id);
    expect(replayed.messages).toEqual([...history, userMsg('q2')]);
  });

  it('replay is idempotent: twice yields the byte-identical transcript (G-ARD-8)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    await s.append(conv.id, b('B1', { blocks: [{ type: 'text', text: 'hi' }] }));
    await s.append(conv.id, b('B4', { runState: { spentTokens: 9, contextTokens: 4, nudges: 0, truncationRetries: 0 } }));
    const a = await s.replay(conv.id);
    const c = await s.replay(conv.id);
    expect(JSON.stringify(c.messages)).toBe(JSON.stringify(a.messages));
    expect(c.runState).toEqual(a.runState);
  });

  it('a re-delivered (re-written) entry file is harmless (G-ARD-8)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    const before = await s.replay(conv.id);
    // Re-delivery: the same file content lands again at the same path.
    const path = `/local/conversations/${conv.id}/journal/1.json`;
    await fs.writeFile(path, fs.files.get(path)!);
    const after = await s.replay(conv.id);
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
  });

  it('refuses an entry with an unknown schema LOUDLY, an unknown kind too, and corrupt JSON as well (R-ARD-5d)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    fs.files.set(`/local/conversations/${conv.id}/journal/2.json`, '{"seq":2,"kind":"B1","schema":2,"t":1}');
    await expect(s.replay(conv.id)).rejects.toMatchObject({ code: 'journal-schema' });
    fs.files.set(`/local/conversations/${conv.id}/journal/2.json`, '{"seq":2,"kind":"B7","schema":1,"t":1}');
    await expect(s.replay(conv.id)).rejects.toMatchObject({ code: 'journal-corrupt' });
    // A KNOWN kind with a MISSING payload is refused too — a silently skipped B5
    // would replay provider-invalid, a B3 without its result would resolve nothing.
    fs.files.set(`/local/conversations/${conv.id}/journal/2.json`, '{"seq":2,"kind":"B3","schema":1,"t":1}');
    await expect(s.replay(conv.id)).rejects.toMatchObject({ code: 'journal-corrupt' });
    fs.files.set(`/local/conversations/${conv.id}/journal/2.json`, '{"seq":2,"kind":"B5","schema":1,"t":1}');
    await expect(s.replay(conv.id)).rejects.toMatchObject({ code: 'journal-corrupt' });
    fs.files.set(`/local/conversations/${conv.id}/journal/2.json`, '{ not json');
    await expect(s.replay(conv.id)).rejects.toMatchObject({ code: 'journal-corrupt' });
  });
});

describe('conversationStore — fold (R-ARD-9 / R-ARD-5c)', () => {
  it('stamps the watermark + run-state, reclaims superseded entries, and replay continues from the record', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    await s.append(conv.id, b('B1', { blocks: [{ type: 'text', text: 'answer' }] }));
    await s.append(conv.id, b('B4', { runState: { spentTokens: 42, contextTokens: 10, nudges: 0, truncationRetries: 0 } }));
    const before = await s.replay(conv.id);
    const folded = await s.fold(conv.id, { messages: before.messages });
    expect(folded.foldedSeq).toBe(3);
    expect(folded.runState?.spentTokens).toBe(42);
    // Reclaim: the folded entries are gone from the journal (R-ARD-5c).
    expect(entryFiles(fs, conv.id)).toHaveLength(0);
    // Replay across the fold boundary is byte-identical (G-ARD-8).
    const after = await s.replay(conv.id);
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    // And a FRESH store (second device view: record alone) replays the same
    // transcript + run-state — G-ARD-16's folded-record-alone resume.
    const fresh = twoTier(fs);
    const fromRecord = await fresh.replay(conv.id);
    expect(JSON.stringify(fromRecord.messages)).toBe(JSON.stringify(before.messages));
    expect(fromRecord.runState?.spentTokens).toBe(42);
  });

  it('entries below the watermark are skipped even if a stale copy survives', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    const folded = await s.fold(conv.id, { messages: [userMsg('go')] });
    // A stale pre-fold copy re-delivered after the fold: harmless, skipped.
    fs.files.set(
      `/local/conversations/${conv.id}/journal/1.json`,
      fs.files.get(`/local/conversations/${conv.id}/journal/1.json`) ??
        JSON.stringify({ seq: 1, kind: 'B0', schema: 1, t: 1, messages: [userMsg('go')] }),
    );
    const replayed = await s.replay(conv.id);
    expect(replayed.messages).toEqual([userMsg('go')]);
    expect(folded.foldedSeq).toBe(1);
  });

  it('fold on a journalless store degrades to a plain save (R-ARD-10)', async () => {
    const s = journalless(new MemFs());
    const conv = await s.create();
    const folded = await s.fold(conv.id, { messages: [userMsg('x')] });
    expect((await s.load(conv.id))?.messages).toEqual([userMsg('x')]);
    expect(folded.foldedSeq).toBeUndefined();
  });

  it('remove() reclaims the journal subtree too (R-ARD-5c)', async () => {
    const fs = new MemFs();
    const s = twoTier(fs);
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    await s.remove(conv.id);
    expect([...fs.files.keys()].some((p) => p.includes(conv.id))).toBe(false);
  });
});

describe('conversationStore — a store fault at B2 (G-ARD-14)', () => {
  it('yields ZERO executor calls, a surfaced failure, and a journal that still replays', async () => {
    const fs = new MemFs();
    // The fault: journal writes fail once the B2 lands (the B2 itself fails
    // under the executor that would follow it).
    const failingFs: MemFs = Object.create(fs);
    failingFs.files = fs.files;
    failingFs.writeFile = async (path: string, data: string): Promise<void> => {
      if (path.includes('/journal/') && JSON.parse(data).kind === 'B2') {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return fs.writeFile(path, data);
    };
    const s = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs: failingFs, tabId: 'tab-test' });
    const conv = await s.create();
    const execute = vi.fn(async () => ({ content: 'r' }));
    const client = {
      calls: 0,
      async createMessage() {
        client.calls++;
        return client.calls === 1
          ? { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'spaces__share', input: {} }] }
          : { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
      },
    };
    await expect(
      runAgent({
        client: client as unknown as ModelClient,
        tools: TOOLS,
        execute,
        prompt: 'go',
        events: {
          onBoundary: async (bb) => {
            await s.append(conv.id, bb);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    // G-ARD-14: nothing executed past the unwritten B2.
    expect(execute).not.toHaveBeenCalled();
    // The journal already written still replays (B0 + B1 durable).
    const replayed = await s.replay(conv.id);
    expect(replayed.messages.length).toBeGreaterThan(0);
  });
});

describe('conversationStore — fold/append concurrency (review round 2)', () => {
  /** MemFs whose SYNCED-TIER (record) writes hang on a manual gate once armed —
   *  the mid-run compaction-fold race, made deterministic. The returned `fs` IS
   *  the gated one; pass it to the store. */
  const gatedRecordFs = (): { fs: MemFs; writes: string[]; arm: () => void; release: () => Promise<void> } => {
    const inner = new MemFs();
    const writes: string[] = [];
    let armed = false;
    const pending: (() => void)[] = [];
    const g: MemFs = Object.create(inner);
    g.files = inner.files;
    g.writeFile = async (path: string, data: string): Promise<void> => {
      if (armed && path.startsWith('/settings/')) {
        writes.push(path);
        await new Promise<void>((res) => pending.push(res));
      }
      return inner.writeFile(path, data);
    };
    return {
      fs: g,
      writes,
      arm: () => {
        armed = true;
      },
      release: async () => {
        await new Promise((r) => setTimeout(r, 0));
        pending.splice(0).forEach((res) => res());
      },
    };
  };

  it('a mid-run fold completing AFTER later appends never moves the seq cache backward (no re-minted, overwritten entry)', async () => {
    const { fs, arm, release } = gatedRecordFs();
    const s = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] })); // seq 1
    await s.append(conv.id, b('B1', { blocks: [{ type: 'text', text: 'turn one' }] })); // seq 2

    // Start the fold; its synced-tier save is now held in flight.
    arm();
    const foldP = s.fold(conv.id, { messages: [userMsg('go')] });
    await new Promise((r) => setTimeout(r, 0)); // the fold reaches its gated save

    // The loop keeps appending while the fold's save is in flight (seq 3): a
    // complete assistant-turn + intent + result triple, the realistic shape.
    await s.append(conv.id, b('B1', { blocks: [{ type: 'tool_use', id: 'tu', name: 't', input: {} }] }));
    await s.append(conv.id, b('B2', { effectId: 'e', call: { type: 'tool_use', id: 'tu', name: 't', input: {} } }));

    // Release the fold. Its snapshot says lastSeq=2; the cache says 4. A
    // backward move would make the NEXT append re-mint 4 and overwrite the B2.
    await release();
    await foldP;

    const seq5 = await s.append(conv.id, b('B3', { effectId: 'e', result: { type: 'tool_result', tool_use_id: 'tu', content: 'r' } }));
    expect(seq5).toBe(5);
    // The durable B2 at seq 4 was not overwritten.
    const entries = entryFiles(fs, conv.id).filter(([, e]) => e.seq >= 3);
    expect(entries.map(([, e]) => e.kind)).toEqual(['B1', 'B2', 'B3']);
    // And replay still resolves the effect — the B2 entry at seq 4 is intact.
    const replayed = await s.replay(conv.id);
    expect(replayed.pendingEffects).toEqual([]);
  });

  it('folds serialize per conversation: the second fold waits for the first (no out-of-order watermarks)', async () => {
    const { fs, arm, release, writes } = gatedRecordFs();
    const s = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
    const conv = await s.create();
    await s.append(conv.id, b('B0', { messages: [userMsg('go')] }));
    arm();
    const f1 = s.fold(conv.id, {});
    await new Promise((r) => setTimeout(r, 0)); // f1 is gated on its record write
    const f2 = s.fold(conv.id, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toHaveLength(1); // f2's record write has not started
    await release();
    await f1;
    await release(); // f2's own gated write, if the chain let it start post-f1
    await f2;
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });
});

// ── R3-561 — the advisory run lease (AGENT_RUN_DURABILITY_SPEC §6) ───────────
//
// Two store instances over ONE fake fs are two frames. `tabId` is injected so
// they are genuinely different frames (a shared tabId would be one tab with two
// stores, which is the reclaim case, tested separately).

const frame = (fs: MemFs, tabId: string, now?: () => number) =>
  createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId, ...(now ? { now } : {}) });

describe('conversationStore — the advisory run lease (R3-561 / R-ARD-18)', () => {
  it('exactly one frame allocates seq; the loser is refused and mints nothing', async () => {
    const fs = new MemFs();
    const a = frame(fs, 'tab-a');
    const conv = await a.create('shared');

    expect(await a.acquireRun(conv.id)).toBe('free');
    const seq = await a.append(conv.id, b('B0', { messages: [userMsg('hi')] }));
    expect(seq).toBe(1);

    const loser = frame(fs, 'tab-b');
    expect(await loser.acquireRun(conv.id)).toBe('held');
    await expect(loser.append(conv.id, b('B5', { message: userMsg('me too') }))).rejects.toThrow(
      /does not hold the run lease/,
    );
    expect(entryFiles(fs, conv.id).map(([, e]) => e.seq)).toEqual([1]);
    // …and the holder is unaffected: its next append is seq 2, contiguous.
    expect(await a.append(conv.id, b('B5', { message: userMsg('carry on') }))).toBe(2);
  });

  it('the refused frame mints NO seq — the gate is before nextSeq, not after it', async () => {
    // Why this is its own case: asserting "no entry file appeared" does not catch a
    // gate placed after `nextSeq`, because the loser's mint is in memory. The
    // damage shows up LATER — its `lastSeq` cache has advanced, so its first
    // legitimate append skips a number, and a gap above the fold is exactly what
    // `replay`'s contiguity check refuses (R3-560 / G-ARD-5).
    const fs = new MemFs();
    let now = 1_000_000;
    const a = frame(fs, 'tab-a', () => now);
    const conv = await a.create('shared');
    await a.append(conv.id, b('B0', { messages: [userMsg('hi')] }));

    const other = frame(fs, 'tab-b', () => now);
    await expect(other.append(conv.id, b('B5', { message: userMsg('me too') }))).rejects.toThrow();

    // The refused frame now takes the lease honestly and appends.
    now += LEASE_TTL_MS;
    expect(await other.acquireRun(conv.id)).toBe('free');
    expect(await other.append(conv.id, b('B5', { message: userMsg('my turn') }))).toBe(2);
    // Contiguous, and therefore replayable.
    expect(entryFiles(fs, conv.id).map(([, e]) => e.seq)).toEqual([1, 2]);
    await expect(other.replay(conv.id)).resolves.toBeTruthy();
  });

  it('a second frame that never acquires is still refused — the gate is on append, not on politeness', async () => {
    const fs = new MemFs();
    const a = frame(fs, 'tab-a');
    const conv = await a.create('shared');
    await a.append(conv.id, b('B0', { messages: [userMsg('hi')] })); // implicit acquire

    const loser = frame(fs, 'tab-b');
    await expect(loser.append(conv.id, b('B5', { message: userMsg('me too') }))).rejects.toThrow(
      /does not hold the run lease/,
    );
  });

  it('teardown then reopen in the SAME tab is free, not held — the canonical flow (R-ARD-18a)', async () => {
    const fs = new MemFs();
    const before = frame(fs, 'tab-a');
    const conv = await before.create('mine');
    expect(await before.acquireRun(conv.id)).toBe('free');
    // No unload handler ran — the lease is still minutes from expiry on disk.
    expect(parseLease(fs.files.get(`/local/conversations/${conv.id}/lease.json`)!)).toMatchObject({ tabId: 'tab-a' });

    // A fresh store in the SAME frame, as a rail-switch teardown-and-return gives.
    const after = frame(fs, 'tab-a');
    expect(await after.acquireRun(conv.id)).toBe('free');
    await expect(after.append(conv.id, b('B0', { messages: [userMsg('resumed')] }))).resolves.toBe(1);
  });

  it('a foreign lease frees on its TTL, and takeover is available before that', async () => {
    const fs = new MemFs();
    let now = 1_000_000;
    const a = frame(fs, 'tab-a', () => now);
    const conv = await a.create('shared');
    await a.acquireRun(conv.id);

    const bFrame = frame(fs, 'tab-b', () => now);
    expect(await bFrame.acquireRun(conv.id)).toBe('held');
    // The offer behind `held`: the user says the other window is not really running it.
    await bFrame.takeOverRun(conv.id);
    expect(await bFrame.append(conv.id, b('B0', { messages: [userMsg('mine now')] }))).toBe(1);

    // And without the explicit takeover, the TTL alone frees it.
    const c = frame(fs, 'tab-c', () => now);
    expect(await c.acquireRun(conv.id)).toBe('held');
    now += LEASE_TTL_MS;
    expect(await c.acquireRun(conv.id)).toBe('free');
  });

  it('a frame that LOST the lease stops rather than silently taking it back', async () => {
    const fs = new MemFs();
    let now = 1_000_000;
    const a = frame(fs, 'tab-a', () => now);
    const conv = await a.create('shared');
    await a.acquireRun(conv.id);
    await a.append(conv.id, b('B0', { messages: [userMsg('hi')] }));

    await frame(fs, 'tab-b', () => now).takeOverRun(conv.id);

    // a does not notice until its heartbeat comes round — that is the boundary.
    now += LEASE_HEARTBEAT_MS;
    expect(await a.holdsRun(conv.id)).toBe(false);
    await expect(a.append(conv.id, b('B5', { message: userMsg('still me') }))).rejects.toThrow(
      /does not hold the run lease/,
    );
    // The latch: even once b's lease expires, a does not resume on its own.
    now += LEASE_TTL_MS * 2;
    await expect(a.append(conv.id, b('B5', { message: userMsg('still me') }))).rejects.toThrow(
      /does not hold the run lease/,
    );
    // Only an explicit ask brings it back.
    expect(await a.acquireRun(conv.id)).toBe('free');
    await expect(a.append(conv.id, b('B5', { message: userMsg('asked again') }))).resolves.toBeGreaterThan(1);
  });

  it('the panel can remove a conversation while a run holds it; the holder finds out at its next boundary (R-ARD-18b)', async () => {
    const fs = new MemFs();
    let now = 1_000_000;
    const stage = frame(fs, 'tab-a', () => now);
    const conv = await stage.create('doomed');
    await stage.acquireRun(conv.id);
    await stage.append(conv.id, b('B0', { messages: [userMsg('running')] }));

    // The panel is the SAME app on the same mount. Its remove is NOT lease-gated.
    const panel = frame(fs, 'tab-a', () => now);
    await expect(panel.remove(conv.id)).resolves.toBeUndefined();
    expect(await panel.load(conv.id)).toBeNull();

    now += LEASE_HEARTBEAT_MS;
    expect(await stage.holdsRun(conv.id)).toBe(false);
    // …and it is told WHICH thing happened, not just that it lost a lease.
    await expect(stage.append(conv.id, b('B5', { message: userMsg('next turn') }))).rejects.toMatchObject({
      code: 'conversation-removed',
    });
    // It does not resurrect the record by folding — asserted by actually folding.
    // The previous version of this case only re-read `load`, which line 3 above had
    // already asserted over the same fs with nothing mutating in between: it would
    // have passed whatever `fold` did. The review gate caught that.
    await expect(stage.fold(conv.id, { messages: [userMsg('running')] })).rejects.toThrow();
    expect(await stage.load(conv.id)).toBeNull();
  });

  it('a taken-over frame stops at its very NEXT append, with no heartbeat-window grace', async () => {
    // The review gate measured the bug this pins: `checkHold` used to skip the
    // stored-lease read until a beat was due, so for up to LEASE_HEARTBEAT_MS after
    // a takeover the old holder still answered `true` and kept appending into the
    // NEW holder's journal. Colliding seqs OVERWRITE an entry rather than leave a
    // gap, so `replay`'s contiguity check — the thing that would otherwise catch
    // it — cannot see the damage at all.
    const fs = new MemFs();
    let now = 1_000_000;
    const a = frame(fs, 'tab-a', () => now);
    const conv = await a.create('shared');
    await a.acquireRun(conv.id);
    await a.append(conv.id, b('B0', { messages: [userMsg('hi')] }));

    await frame(fs, 'tab-b', () => now).takeOverRun(conv.id);

    // Well inside the heartbeat window — the old holder must ALREADY be out.
    now += 300;
    expect(await a.holdsRun(conv.id)).toBe(false);
    await expect(a.append(conv.id, b('B5', { message: userMsg('still me') }))).rejects.toThrow(
      /does not hold the run lease/,
    );
    // And nothing of a's landed on top of b's journal.
    expect(entryFiles(fs, conv.id).map(([, e]) => e.seq)).toEqual([1]);
  });

  it('a heartbeat refreshes without REWRITING on every boundary', async () => {
    const fs = new MemFs();
    let now = 1_000_000;
    const s = frame(fs, 'tab-a', () => now);
    const conv = await s.create('busy');
    await s.acquireRun(conv.id);
    const expiry = () => parseLease(fs.files.get(`/local/conversations/${conv.id}/lease.json`)!)!.expiresAt;
    const first = expiry();

    // Inside the heartbeat window: held, and the file is not rewritten. The READ
    // happens every time (see the case above); the WRITE is what the beat paces.
    now += LEASE_HEARTBEAT_MS - 1;
    expect(await s.holdsRun(conv.id)).toBe(true);
    expect(expiry()).toBe(first);

    // At the beat: refreshed forward, same identity.
    now += 1;
    expect(await s.holdsRun(conv.id)).toBe(true);
    expect(expiry()).toBe(now + LEASE_TTL_MS);
  });

  it('release frees the lease for another frame, but never deletes a newer holder’s', async () => {
    const fs = new MemFs();
    const now = 1_000_000;
    const a = frame(fs, 'tab-a', () => now);
    const conv = await a.create('shared');
    await a.acquireRun(conv.id);
    await a.releaseRun(conv.id);
    expect(fs.files.has(`/local/conversations/${conv.id}/lease.json`)).toBe(false);

    // A stale releaser must not evict whoever holds it now.
    const stale = frame(fs, 'tab-a', () => now);
    await stale.acquireRun(conv.id);
    await frame(fs, 'tab-b', () => now).takeOverRun(conv.id);
    await stale.releaseRun(conv.id);
    expect(parseLease(fs.files.get(`/local/conversations/${conv.id}/lease.json`)!)).toMatchObject({ tabId: 'tab-b' });
  });

  it('a transient read fault does NOT read as a takeover — the lease is kept and the TTL decides', async () => {
    // The review gate measured the bug this pins. Round 1 moved the stored-lease
    // read onto every boundary, which was right, but `readLease` collapsed EVERY
    // fault into `null` and `checkHold` reads `null` as "someone took it" — and
    // latches. So one transient EBUSY ended the run, refused every later append for
    // the session, and told the user another window had taken over, while our own
    // unexpired lease with our own holderId was still sitting on disk.
    const fs = new MemFs();
    let fail = false;
    const flaky: MemFs = Object.create(fs);
    flaky.files = fs.files;
    flaky.readFile = async (path: string): Promise<string> => {
      if (fail && path.endsWith('lease.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.readFile(path);
    };
    const now = 1_000_000;
    const s = createConversationStore({
      recordRoot: '/settings',
      journalRoot: '/local',
      fs: flaky,
      tabId: 'tab-a',
      now: () => now,
    });
    const conv = await s.create('mine');
    await s.acquireRun(conv.id);
    await s.append(conv.id, b('B0', { messages: [userMsg('hi')] }));

    fail = true;
    expect(await s.holdsRun(conv.id)).toBe(true); // a fault is not evidence of loss
    await expect(s.append(conv.id, b('B5', { message: userMsg('still me') }))).resolves.toBe(2);
    fail = false;
    // …and nothing latched: the lease on disk is still ours, untouched.
    expect(parseLease(fs.files.get(`/local/conversations/${conv.id}/lease.json`)!)).toMatchObject({ tabId: 'tab-a' });
    expect(await s.holdsRun(conv.id)).toBe(true);
  });

  it('a PERSISTENT read fault is bounded by our own TTL — the hold is not unconditional', async () => {
    // Round 2 fixed the transient case by keeping the lease on an unreadable mount;
    // round 3 measured what that bought unbounded. The branch returns BEFORE the
    // refresh, so a frame whose reads keep failing both kept claiming the lease and
    // stopped writing heartbeats: across 2.5 TTLs it answered `true` every time,
    // its stored expiresAt never moved, a second frame's acquireRun answered
    // `free`, and both minted the same seq — one entry overwriting the other, which
    // `replay`'s contiguity check cannot see.
    const fs = new MemFs();
    let fail = false;
    const flaky: MemFs = Object.create(fs);
    flaky.files = fs.files;
    flaky.readFile = async (path: string): Promise<string> => {
      if (fail && path.endsWith('lease.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.readFile(path);
    };
    let now = 1_000_000;
    const a = createConversationStore({
      recordRoot: '/settings',
      journalRoot: '/local',
      fs: flaky,
      tabId: 'tab-a',
      now: () => now,
    });
    const conv = await a.create('mine');
    await a.acquireRun(conv.id);
    fail = true;

    // Inside our own expiry: a fault is not a loss.
    now += LEASE_TTL_MS - 1;
    expect(await a.holdsRun(conv.id)).toBe(true);

    // Past it: the lease we are holding through the fault has itself expired, so
    // the hold ends — and it latches, like any other loss.
    now += 2;
    expect(await a.holdsRun(conv.id)).toBe(false);
    await expect(a.append(conv.id, b('B5', { message: userMsg('still me') }))).rejects.toThrow();

    // Which matters because the other frame is now legitimately free to take it.
    fail = false;
    const other = createConversationStore({
      recordRoot: '/settings',
      journalRoot: '/local',
      fs: flaky,
      tabId: 'tab-b',
      now: () => now,
    });
    expect(await other.acquireRun(conv.id)).toBe('free');
    expect(await other.append(conv.id, b('B0', { messages: [userMsg('mine now')] }))).toBe(1);
  });

  it('a journalless takeOverRun writes nothing, least of all outside the mounts', async () => {
    // `writeLease` interpolates `journalRoot`, so without its guard this produced
    // `undefined/conversations/<id>/lease.json` — a relative path in neither mount,
    // which `remove`'s `rmTree` (itself journalRoot-gated) never reclaims. The
    // guard went in on round 1 with nothing holding it down.
    const fs = new MemFs();
    const s = journalless(fs);
    const conv = await s.create('no journal');
    await s.takeOverRun(conv.id);
    expect([...fs.files.keys()].filter((k) => !k.startsWith('/settings/'))).toEqual([]);
    await s.releaseRun(conv.id);
    expect([...fs.files.keys()].filter((k) => !k.startsWith('/settings/'))).toEqual([]);
  });

  it('a journalless store has no lease substrate, and its append refuses as journal-unavailable', async () => {
    // NOT an ordering assertion, and it was wrong to name one: the gate is INERT on
    // a journalless store — `checkHold` returns true and `tryAcquire` returns
    // `free` when `journalRoot` is undefined — so moving the `journal-unavailable`
    // throw to either side of it leaves this case green. The review gate proved
    // that by moving it. What this pins is the outcome a caller sees, which is what
    // R-ARD-10 is about.
    const fs = new MemFs();
    const s = journalless(fs);
    const conv = await s.create('no journal');
    expect(await s.acquireRun(conv.id)).toBe('free');
    expect(await s.holdsRun(conv.id)).toBe(true);
    await expect(s.append(conv.id, b('B0', { messages: [userMsg('hi')] }))).rejects.toMatchObject({
      code: 'journal-unavailable',
    });
    await expect(s.releaseRun(conv.id)).resolves.toBeUndefined();
  });
});
