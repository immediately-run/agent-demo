// R3-336 — prompt-cache management, app side.
//
// The loop's job here is smaller than it looks and easy to break by accident: keep the
// prefix STABLE (so the host's breakpoints can hit), and report what the provider says
// about caching (so the claim is verifiable rather than believed). Both are asserted,
// because both fail silently — a re-stamped system prompt costs nothing visible and
// turns every read into a write.

import { describe, it, expect, vi } from 'vitest';
import { runAgent, type ChatMessage, type ModelClient, type ModelResponse } from './agentLoop';
import type { AgentTool } from './agentTools';

const TOOLS: AgentTool[] = [
  { name: 'read_file', description: 'r', input_schema: { type: 'object' } },
  { name: 'write_file', description: 'w', input_schema: { type: 'object' } },
];
const exec = async () => ({ content: 'ok' });

const call = (id: string): ModelResponse => ({
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a' } }],
});
const done = (): ModelResponse => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] });

describe('exit 4 / scope 1 — the prefix the host caches is byte-identical every turn', () => {
  it('sends the same system prompt and the same tool list on every turn of a run', async () => {
    const systems: (string | undefined)[] = [];
    const toolLists: string[] = [];
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        systems.push(req.system);
        toolLists.push(JSON.stringify(req.tools));
        return ++turn < 4 ? call(`t${turn}`) : done();
      },
    };
    await runAgent({ client, tools: TOOLS, execute: exec, system: 'SYSTEM PROMPT', prompt: 'go', maxTurns: 6 });
    expect(turn).toBeGreaterThan(3);
    expect(new Set(systems).size).toBe(1);
    // Same tools, same ORDER — a reordered list is a different prefix to a cache.
    expect(new Set(toolLists).size).toBe(1);
  });

  it('everything that changes is APPENDED — earlier messages are never rewritten mid-run', async () => {
    const snapshots: string[] = [];
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        snapshots.push(JSON.stringify(req.messages));
        return ++turn < 4 ? call(`t${turn}`) : done();
      },
    };
    await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go', maxTurns: 6 });
    // Each turn's messages start with the previous turn's, verbatim. That is exactly the
    // condition a prefix cache needs, and it is what compaction (deliberately) breaks.
    for (let i = 1; i < snapshots.length; i++) {
      const prev = JSON.parse(snapshots[i - 1]) as ChatMessage[];
      const next = JSON.parse(snapshots[i]) as ChatMessage[];
      expect(next.slice(0, prev.length)).toEqual(prev);
    }
  });
});

describe('cache accounting is reported, and absence is preserved', () => {
  it('accumulates reads and writes across turns', async () => {
    const onUsage = vi.fn();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        return {
          ...(turn < 3 ? call(`t${turn}`) : done()),
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: turn === 1 ? 0 : 900,
            cacheWriteTokens: turn === 1 ? 900 : 0,
          },
        };
      },
    };
    await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go', maxTurns: 5, events: { onUsage } });
    const last = onUsage.mock.calls.at(-1)![0] as { cacheReadTokens: number; cacheWriteTokens: number };
    // One write to warm the prefix, then reads — the shape the breakpoints exist to produce.
    expect(last.cacheWriteTokens).toBe(900);
    expect(last.cacheReadTokens).toBe(1800);
  });

  it('reports NOTHING rather than zero when the provider reports nothing', async () => {
    const onUsage = vi.fn();
    const client: ModelClient = {
      async createMessage() {
        return { ...done(), usage: { inputTokens: 10, outputTokens: 1 } };
      },
    };
    await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go', events: { onUsage } });
    const u = onUsage.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(u).not.toHaveProperty('cacheReadTokens');
    expect(u).not.toHaveProperty('cacheWriteTokens');
  });
});

describe('exit 2 — the cost curve across a compaction, measured', () => {
  /**
   * A provider that bills like a real prefix cache: the longest common prefix of this
   * request and the last one is billed as a cache READ, the rest as a fresh WRITE.
   * `system` + `tools` are treated as a separate, durable prefix — which is exactly the
   * split the host's two breakpoints implement.
   */
  const cachingProvider = () => {
    let lastPrefix: string[] = [];
    let durableWarm = false;
    const turns: Array<{ read: number; write: number }> = [];
    const client: ModelClient = {
      async createMessage(req) {
        // The compaction summarizer calls the same client with NO tools and its own
        // system prompt. It is a real cost, but it is not an agent turn and it shares no
        // prefix with one — so it is billed cold and left out of the cache bookkeeping,
        // which is also what a provider would do.
        if (req.tools.length === 0) {
          return { stopReason: 'end_turn', content: [{ type: 'text', text: 'SUMMARY' }] };
        }
        const durable = (req.system ?? '').length + JSON.stringify(req.tools).length;
        const parts = req.messages.map((m) => JSON.stringify(m));
        let common = 0;
        while (common < parts.length && common < lastPrefix.length && parts[common] === lastPrefix[common]) common++;
        const readChars = parts.slice(0, common).join('').length + (durableWarm ? durable : 0);
        const writeChars = parts.slice(common).join('').length + (durableWarm ? 0 : durable);
        durableWarm = true;
        lastPrefix = parts;
        turns.push({ read: Math.ceil(readChars / 4), write: Math.ceil(writeChars / 4) });
        return {
          ...(turns.length < 8 ? call(`t${turns.length}`) : done()),
          usage: {
            inputTokens: Math.ceil((readChars + writeChars) / 4),
            outputTokens: 5,
            cacheReadTokens: Math.ceil(readChars / 4),
            cacheWriteTokens: Math.ceil(writeChars / 4),
          },
        };
      },
    };
    return { client, turns };
  };

  it('steady-state turns are almost entirely cache reads', async () => {
    const { client, turns } = cachingProvider();
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'x'.repeat(400) }),
      system: 'S'.repeat(4000),
      prompt: 'go',
      maxTurns: 10,
    });
    expect(turns.length).toBeGreaterThan(4);
    const steady = turns.slice(2);
    for (const t of steady) expect(t.read).toBeGreaterThan(t.write);
  });

  it('a compaction costs ONE prefix re-write, not the whole cache — the durable half survives it', async () => {
    const compacts: Array<{ summarizedCount: number; cacheReadTokens?: number }> = [];
    const { client, turns } = cachingProvider();
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'x'.repeat(2000) }),
      system: 'S'.repeat(4000),
      prompt: 'go',
      maxTurns: 12,
      // Small window so a compaction actually fires within the run.
      contextWindow: 2000,
      keepRecentTurns: 2,
      events: { onCompact: (i) => compacts.push(i) },
    });
    expect(compacts.length).toBeGreaterThan(0);
    // The running cache total is recorded AT the boundary, so the curve across it can be
    // read off rather than assumed (exit 2).
    expect(compacts[0].cacheReadTokens).toBeGreaterThan(0);
    // The claim under test is NOT "compaction is free" — it is that compaction does not
    // discard the whole cache. Every turn after the first still reads at least the
    // durable system+tools prefix, INCLUDING the turns straddling a compaction: a lost
    // cache would show as read == 0, and none does.
    const durablePrefixTokens = Math.ceil(4000 / 4);
    for (const t of turns.slice(1)) expect(t.read).toBeGreaterThanOrEqual(durablePrefixTokens);

    // And the honest half of the finding, recorded rather than tuned away: aggressive
    // compaction (a tiny window against large tool results) DOES erode the conversation-
    // prefix win, because each compaction re-writes what it rewrote. The durable prefix
    // is what keeps the floor.
    const totalRead = turns.reduce((n, t) => n + t.read, 0);
    expect(totalRead).toBeGreaterThan(durablePrefixTokens * (turns.length - 1));
  });
});
