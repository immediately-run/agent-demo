import { describe, it, expect, vi, afterEach } from 'vitest';

// Same mock rationale as conversationStore.test.ts: the module imports
// `openSettings` from the SDK barrel; these tests exercise the fs-injected core.
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn() }));

import {
  SESSION_PROJECTION_PATH,
  inactiveProjection,
  deriveSessionProjection,
  createSessionProjectionWriter,
  createProjectionPublisher,
  type SessionProjectionWriter,
} from './sessionProjection';
import { createConversationStore } from './conversationStore';
import { MemFs } from './testing/memStoreFs';
import type { Conversation } from './conversationModel';
import type { ChatMessage } from './agentLoop';

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: 'T',
  createdAt: 1,
  updatedAt: 2,
  schema: 1,
  repo: 'owner/repo',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as ChatMessage[],
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('deriveSessionProjection — the R-CT-1/R-CT-2 gate facts (R3-631)', () => {
  it('a stamped, non-empty conversation projects active with every gate fact', () => {
    const doc = deriveSessionProjection(conv(), true, 1000);
    expect(doc).toEqual({
      schema: 1,
      active: true,
      repo: 'owner/repo',
      conversationId: 'c1',
      messageCount: 1,
      updatedAt: 2,
      running: true,
      heartbeatAt: 1000,
    });
  });

  it('REAL PRODUCER: a record from the store save path derives correctly, and the save bumps what the doc carries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createConversationStore({ root: '/settings', fs: new MemFs() });
    const made = await store.create(undefined, 'owner/repo');
    expect(deriveSessionProjection(made, false, 1000).active).toBe(false); // empty transcript
    vi.setSystemTime(2000);
    const saved = await store.save({
      ...made,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    const doc = deriveSessionProjection(saved, false, 3000);
    expect(doc).toEqual({
      schema: 1,
      active: true,
      repo: 'owner/repo',
      conversationId: saved.id,
      messageCount: 2,
      updatedAt: 2000, // the save-time bump, carried through
      running: false,
      heartbeatAt: 3000, // the publish-time stamp — a distinct fact (R-CT-1)
    });
  });

  it('an UNSTAMPED conversation (repo === undefined) NEVER projects active', () => {
    // The trap this guards: conversationScope.ts's `mine` partition treats an
    // undefined repo as matching every repo. The projection must not (R-CT-2(a)).
    const legacy = conv();
    delete legacy.repo;
    expect(deriveSessionProjection(legacy, false, 1000)).toEqual(inactiveProjection(1000));
    expect(deriveSessionProjection(legacy, false, 1000).active).toBe(false);
  });

  it('an empty transcript projects inactive (G-CT-9 half: messageCount > 0 required)', () => {
    expect(deriveSessionProjection(conv({ messages: [] }), false, 1000).active).toBe(false);
  });

  it('a null conversation (no session open) projects inactive', () => {
    expect(deriveSessionProjection(null, false, 1000)).toEqual(inactiveProjection(1000));
  });

  it('running reflects the loop state without touching activeness', () => {
    expect(deriveSessionProjection(conv(), false, 1).running).toBe(false);
    expect(deriveSessionProjection(conv(), true, 1).running).toBe(true);
  });
});

describe('createSessionProjectionWriter — the settings-doc heartbeat (R3-631)', () => {
  it('publishes the derived doc to {root}/session-projection.json', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const fs = new MemFs();
    const w = createSessionProjectionWriter({ root: '/settings', fs });
    await w.publish(conv(), false);
    const doc = JSON.parse(fs.files.get(`/settings/${SESSION_PROJECTION_PATH}`)!);
    expect(doc).toEqual(deriveSessionProjection(conv(), false, 1000));
  });

  it('publish(null, ·) writes the explicit inactive doc', async () => {
    const fs = new MemFs();
    const w = createSessionProjectionWriter({ root: '/settings', fs });
    await w.publish(conv(), false);
    await w.publish(null, false);
    const doc = JSON.parse(fs.files.get(`/settings/${SESSION_PROJECTION_PATH}`)!);
    expect(doc.active).toBe(false);
    expect(doc.repo).toBeUndefined();
    expect(doc.messageCount).toBe(0);
  });

  it('every publish bumps heartbeatAt (the host TTL has something to expire)', async () => {
    vi.useFakeTimers();
    const fs = new MemFs();
    const w = createSessionProjectionWriter({ root: '/settings', fs });
    vi.setSystemTime(1000);
    await w.publish(conv(), true);
    vi.setSystemTime(5000);
    await w.publish(conv(), false);
    const beats = [...fs.files.values()]
      .map((raw) => JSON.parse(raw).heartbeatAt)
      .sort((a: number, b: number) => a - b);
    expect(beats[beats.length - 1]).toBe(5000);
  });

  it('a failed write NEVER throws into the conversation flow (fail-closed via TTL)', async () => {
    const boom = {
      writeFile: async (): Promise<void> => {
        throw new Error('settings gone');
      },
    };
    const w = createSessionProjectionWriter({ root: '/settings', fs: boom });
    await expect(w.publish(conv(), false)).resolves.toBeUndefined();
  });
});

describe('createProjectionPublisher — the stage trigger semantics (R3-631)', () => {
  /** A writer that records every publish — the fake for the real writer contract. */
  const recorder = (): { w: SessionProjectionWriter; calls: { conv: Conversation | null; running: boolean }[] } => {
    const calls: { conv: Conversation | null; running: boolean }[] = [];
    return { w: { publish: async (conv, running) => { calls.push({ conv, running }); } }, calls };
  };

  it('no writer yet (before first open, or open failed): every trigger is a no-op, never a throw', () => {
    const p = createProjectionPublisher(() => null, () => ({ conv: conv(), runningId: 'c1' }));
    expect(() => {
      p.onShow();
      p.onRunStart('c1');
      p.onSaved();
      p.onRunEnd();
      p.onUnmount();
    }).not.toThrow();
  });

  it('onShow: running is true only when the in-flight run belongs to the SHOWN conversation', () => {
    const { w, calls } = recorder();
    const p = createProjectionPublisher(() => w, () => ({ conv: conv(), runningId: 'OTHER' }));
    p.onShow();
    expect(calls[0]).toMatchObject({ running: false }); // a run elsewhere is not this session's fact
    const p2 = createProjectionPublisher(() => w, () => ({ conv: conv(), runningId: 'c1' }));
    p2.onShow();
    expect(calls[1]).toMatchObject({ running: true });
  });

  it('onRunStart: true for the run conversation; a null convId (ephemeral run) publishes inactive', () => {
    const { w, calls } = recorder();
    // Mirrors run(): the conversation is resolved into convRef BEFORE onRunStart,
    // so convId null means there IS no record — the state says the same thing.
    let convState: Conversation | null = conv();
    const p = createProjectionPublisher(() => w, () => ({ conv: convState, runningId: 'c1' }));
    p.onRunStart('c1');
    expect(calls[0]).toMatchObject({ running: true });
    convState = null; // ephemeral run: store unavailable, nothing attached
    p.onRunStart(null);
    expect(calls[1]).toMatchObject({ conv: null, running: false });
  });

  it('onSaved and onRunEnd keep the session active but clear the running flag (the post-turn heartbeat)', () => {
    const { w, calls } = recorder();
    const p = createProjectionPublisher(() => w, () => ({ conv: conv(), runningId: null }));
    p.onSaved();
    p.onRunEnd();
    expect(calls.map((c) => c.running)).toEqual([false, false]);
    expect(calls.every((c) => c.conv !== null)).toBe(true);
  });

  it('onUnmount publishes the explicit inactive doc', () => {
    const { w, calls } = recorder();
    const p = createProjectionPublisher(() => w, () => ({ conv: conv(), runningId: 'c1' }));
    p.onUnmount();
    expect(calls[0]).toMatchObject({ conv: null, running: false });
  });
});
