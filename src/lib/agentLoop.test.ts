import { describe, it, expect, vi } from 'vitest';
import ts from 'typescript';
import {
  runAgent,
  detectStall,
  estimateTokens,
  shouldCompact,
  compactTranscript,
  isContextOverflow,
  COMPACTION_MARKER,
  type ChatMessage,
  type ModelClient,
  type ModelResponse,
  type LoopBoundary,
  type RunState,
} from './agentLoop';
import type { AgentTool } from './agentTools';

// The fault-injection sweep (G-ARD-1) replays through the REAL store; mocking the
// SDK barrel keeps vitest from loading the full SDK (same reason as
// conversationStore.test.ts — these tests drive the fs-injected core).
vi.mock('@immediately-run/sdk', () => ({ openSettings: vi.fn(), openLocalStore: vi.fn() }));
import { createConversationStore } from './conversationStore';
import { MemFs } from './testing/memStoreFs';
import { SteerController } from './steering';

const TOOLS: AgentTool[] = [
  { name: 'spaces__share', description: 'x', input_schema: { type: 'object', properties: {}, additionalProperties: true } },
];

// A ModelClient that replays a scripted sequence of turns.
function scriptedClient(turns: ModelResponse[]): ModelClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    async createMessage() {
      client.calls++;
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
  return client;
}

describe('runAgent — the agentic tool-use loop (§3.3)', () => {
  it('seeds the model request with prior history before the new prompt (Phase 05)', async () => {
    const seen: ChatMessage[][] = [];
    const client: ModelClient = {
      async createMessage(req) {
        seen.push([...req.messages]); // snapshot: the loop mutates this array in place
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    ];

    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      history,
      prompt: 'follow-up',
    });

    // The first model request carries the history followed by the new prompt.
    expect(seen[0]).toEqual([...history, { role: 'user', content: [{ type: 'text', text: 'follow-up' }] }]);
    // The returned transcript starts from the seeded history (full conversation).
    expect(transcript.slice(0, 2)).toEqual(history);
  });

  it('executes tool calls, appends results, and loops until end_turn', async () => {
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [
        { type: 'text', text: 'Sharing now.' },
        { type: 'tool_use', id: 'tu_1', name: 'spaces__share', input: { login: 'alice' } },
      ] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    const execute = vi.fn().mockResolvedValue({ content: '{"ok":true}' });

    const transcript = await runAgent({ client, tools: TOOLS, execute, prompt: 'share my space with alice' });

    expect(execute).toHaveBeenCalledWith('spaces__share', { login: 'alice' });
    expect(client.calls).toBe(2);
    // user prompt, assistant(tool_use), user(tool_result), assistant(end_turn)
    expect(transcript).toHaveLength(4);
    expect(transcript[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '{"ok":true}',
    });
  });

  it('turns a thrown executor error (e.g. host forbidden) into an error tool_result', async () => {
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'spaces__admin', input: {} }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok, I cannot.' }] },
    ]);
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error('not allowed'), { code: 'forbidden' }));

    const transcript = await runAgent({ client, tools: TOOLS, execute, prompt: 'admin a space' });

    const result = transcript[2].content[0];
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect((result as { content: string }).content).toContain('forbidden');
  });

  it('stops at maxTurns even if the model keeps calling tools', async () => {
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'spaces__share', input: {} }] },
    ]);
    const execute = vi.fn().mockResolvedValue({ content: 'ok' });

    await runAgent({ client, tools: TOOLS, execute, prompt: 'loop forever', maxTurns: 3 });

    expect(client.calls).toBe(3);
  });

  it('fires UI events for assistant text, tool use, and tool result', async () => {
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_use', id: 't', name: 'spaces__share', input: { a: 1 } },
      ] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'fin' }] },
    ]);
    const onAssistantText = vi.fn();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();

    await runAgent({
      client, tools: TOOLS, prompt: 'go',
      execute: async () => ({ content: 'r' }),
      events: { onAssistantText, onToolUse, onToolResult },
    });

    expect(onAssistantText).toHaveBeenCalledWith('thinking out loud');
    expect(onToolUse).toHaveBeenCalledWith('spaces__share', { a: 1 });
    expect(onToolResult).toHaveBeenCalledWith('spaces__share', { content: 'r' });
  });

  const share = (id: string) => ({
    stopReason: 'tool_use',
    content: [{ type: 'tool_use' as const, id, name: 'spaces__share', input: {} }],
  });

  // The §2 backstop: GLM/OpenRouter intermittently ends a turn announcing work but
  // emitting no tool call, or empties out after a tool error — a silent stall.
  describe('stall backstop (tutorial findings §2)', () => {
    it("nudges a turn that announces work but emits no tool call, then completes", async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: "I'll read the files and register the component." }] },
        share('tu_1'),
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      ]);
      const onNudge = vi.fn();
      const execute = vi.fn().mockResolvedValue({ content: 'ok' });

      const transcript = await runAgent({ client, tools: TOOLS, execute, prompt: 'go', events: { onNudge } });

      expect(onNudge).toHaveBeenCalledWith('announced-no-call');
      expect(execute).toHaveBeenCalledTimes(1); // the nudge recovered the run
      // kickoff, assistant(stall), user(nudge), assistant(tool_use), user(result), assistant(done)
      expect(transcript).toHaveLength(6);
      expect(transcript[2]).toEqual({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('emit the tool call now') }] });
    });

    it('nudges an EMPTY give-up (common right after a tool error)', async () => {
      const client = scriptedClient([
        share('tu_1'),
        { stopReason: 'end_turn', content: [] }, // empty turn after the tool result
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'All set.' }] },
      ]);
      const onNudge = vi.fn();
      const execute = vi.fn().mockResolvedValue({ content: 'ok' });

      await runAgent({ client, tools: TOOLS, execute, prompt: 'go', events: { onNudge } });

      expect(onNudge).toHaveBeenCalledWith('empty');
    });

    it('does NOT nudge a genuine finish (a wrap-up summary)', async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: "I've created the component. Here's a summary of the four changes." }] },
      ]);
      const onNudge = vi.fn();

      const transcript = await runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', events: { onNudge } });

      expect(onNudge).not.toHaveBeenCalled();
      expect(client.calls).toBe(1);
      expect(transcript).toHaveLength(2); // prompt + the finishing turn, no nudge
    });

    it('caps consecutive nudges so a persistently-stalling model still terminates', async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: "Let me read the file." }] }, // stall → nudge
        { stopReason: 'end_turn', content: [{ type: 'text', text: "Now I'll edit it." }] },      // stall again → cap hit → break
        share('never'),
      ]);
      const onNudge = vi.fn();
      const execute = vi.fn().mockResolvedValue({ content: 'ok' });

      await runAgent({ client, tools: TOOLS, execute, prompt: 'go', maxNudges: 1, events: { onNudge } });

      expect(onNudge).toHaveBeenCalledTimes(1); // one nudge, then it gives up (no infinite loop)
      expect(execute).not.toHaveBeenCalled();
      expect(client.calls).toBe(2);
    });

    it('resets the nudge budget after a productive turn (later stall still covered)', async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: "I'll read the file." }] }, // stall → nudge #1
        share('tu_1'),                                                                          // productive → budget resets
        { stopReason: 'end_turn', content: [{ type: 'text', text: "Now let me update the map." }] }, // stall → nudge #2
        share('tu_2'),
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      ]);
      const onNudge = vi.fn();
      const execute = vi.fn().mockResolvedValue({ content: 'ok' });

      await runAgent({ client, tools: TOOLS, execute, prompt: 'go', maxNudges: 1, events: { onNudge } });

      expect(onNudge).toHaveBeenCalledTimes(2); // budget reset by the productive turn between stalls
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('does not nudge a truncated (max_tokens) turn', async () => {
      const client = scriptedClient([
        { stopReason: 'max_tokens', content: [{ type: 'text', text: "I'll read the file" }] },
      ]);
      const onNudge = vi.fn();

      await runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', events: { onNudge } });

      expect(onNudge).not.toHaveBeenCalled();
    });

    it('maxNudges: 0 disables the backstop', async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: "I'll read the file." }] },
      ]);
      const onNudge = vi.fn();

      await runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', maxNudges: 0, events: { onNudge } });

      expect(onNudge).not.toHaveBeenCalled();
      expect(client.calls).toBe(1);
    });
  });

  describe('detectStall', () => {
    it('flags empty text and announced-intent, spares genuine finishes', () => {
      expect(detectStall('')).toBe('empty');
      expect(detectStall('   \n ')).toBe('empty');
      expect(detectStall("I'll read the files now.")).toBe('announced-no-call');
      expect(detectStall('Let me create the component.')).toBe('announced-no-call');
      expect(detectStall("I've created the component and registered it.")).toBeNull();
      expect(detectStall('Done. Here is a summary of the changes.')).toBeNull();
      expect(detectStall('The answer is 42.')).toBeNull(); // a plain answer, not a stall
    });
  });

  // R3-220 (AHG-1): token accounting + truncated-tool-call guard + spend budget.
  describe('token accounting + budget (R3-220)', () => {
    it('surfaces provider usage as running context tokens via onUsage', async () => {
      const client = scriptedClient([
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1200, outputTokens: 300 } },
      ]);
      const onUsage = vi.fn();
      await runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', events: { onUsage } });
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ contextTokens: 1500, spentTokens: 1500 }));
    });

    it('falls back to a char/4 estimate when the provider reports no usage', async () => {
      const client = scriptedClient([{ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
      const onUsage = vi.fn();
      await runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', events: { onUsage } });
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ contextTokens: expect.any(Number) }));
      expect(onUsage.mock.calls[0][0].contextTokens).toBeGreaterThan(0);
    });

    it('stops on the token/spend budget (the runaway guard replacing the raw turn cap)', async () => {
      const client = scriptedClient([share('x')]); // loops emitting tool calls forever
      const onBudgetStop = vi.fn();
      await runAgent({
        client,
        tools: TOOLS,
        execute: async () => ({ content: 'ok' }),
        prompt: 'go',
        // Each turn "spends" its estimate; a tiny budget stops after the first cycle.
        tokenBudget: 1,
        events: { onBudgetStop },
      });
      expect(onBudgetStop).toHaveBeenCalled();
      expect(client.calls).toBe(1); // budget checked after the first productive turn
    });

    it('does NOT execute a truncated (max_tokens) turn that emitted tool calls (F3)', async () => {
      const client = scriptedClient([
        { stopReason: 'max_tokens', content: [{ type: 'tool_use', id: 'tu_1', name: 'spaces__share', input: { partial: true } }] },
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok, smaller step done.' }] },
      ]);
      const execute = vi.fn().mockResolvedValue({ content: 'ok' });
      const onTruncatedToolCall = vi.fn();

      const transcript = await runAgent({ client, tools: TOOLS, execute, prompt: 'go', events: { onTruncatedToolCall } });

      expect(execute).not.toHaveBeenCalled(); // partial args never run
      expect(onTruncatedToolCall).toHaveBeenCalled();
      // The dropped call is failed with an error tool_result so the convo stays well-formed.
      const failure = transcript[2].content.find((b) => b.type === 'tool_result');
      expect(failure).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true });
    });

    it('caps consecutive truncated re-prompts so it cannot spin forever', async () => {
      const client = scriptedClient([
        { stopReason: 'max_tokens', content: [{ type: 'tool_use', id: 'x', name: 'spaces__share', input: {} }] },
      ]);
      const execute = vi.fn();
      await runAgent({ client, tools: TOOLS, execute, prompt: 'go', maxTruncationRetries: 2 });
      expect(execute).not.toHaveBeenCalled();
      expect(client.calls).toBe(3); // initial + 2 retries, then give up
    });
  });

  describe('estimateTokens / shouldCompact (R3-220)', () => {
    it('estimateTokens grows with content, ~char/4', () => {
      const small = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] }]);
      const big = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }]);
      expect(small).toBe(10);
      expect(big).toBe(100);
    });

    it('shouldCompact fires only past window − reserve, and never without a window', () => {
      expect(shouldCompact(800, 1000, 250)).toBe(true); // 800 > 750
      expect(shouldCompact(700, 1000, 250)).toBe(false); // 700 < 750
      expect(shouldCompact(999999, undefined, 250)).toBe(false); // no window → disabled
      expect(shouldCompact(999999, 0, 250)).toBe(false);
    });
  });

  describe('compactTranscript (R3-220)', () => {
    const longTranscript = (): ChatMessage[] => [
      { role: 'user', content: [{ type: 'text', text: 'Fix the bug in /src/App.tsx where handleClick throws TypeError: x is undefined' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: '/src/App.tsx' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file contents…' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'edit_file', input: { path: '/src/App.tsx' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'edited' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking diagnostics' }, { type: 'tool_use', id: 'c', name: 'get_diagnostics', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'no errors' }] },
    ];

    it('folds the head into a marked summary and keeps a tail starting at an assistant', async () => {
      // The summarizer preserves the exact path + symbol + error string (exit-d).
      const summarizer: ModelClient = {
        async createMessage() {
          return {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'Goal: fix /src/App.tsx handleClick TypeError: x is undefined. Progress: edited it.' }],
          };
        },
      };
      const { messages, summarizedCount } = await compactTranscript(longTranscript(), summarizer, 2);

      expect(summarizedCount).toBeGreaterThan(0);
      // First message is the compaction summary (a user turn carrying the marker)…
      expect(messages[0].role).toBe('user');
      const head = messages[0].content[0];
      expect(head.type === 'text' && head.text.startsWith(COMPACTION_MARKER)).toBe(true);
      // …and the exact path/symbol/error survived the boundary (gate, exit-d).
      const summaryText = head.type === 'text' ? head.text : '';
      expect(summaryText).toContain('/src/App.tsx');
      expect(summaryText).toContain('TypeError: x is undefined');
      // The tail begins at an assistant message (no split tool_use/tool_result pair).
      expect(messages[1].role).toBe('assistant');
    });

    it('leaves a short transcript unchanged (nothing worth compacting)', async () => {
      const short: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ];
      const spy: ModelClient = { createMessage: vi.fn() };
      const { summarizedCount } = await compactTranscript(short, spy, 8);
      expect(summarizedCount).toBe(0);
      expect(spy.createMessage).not.toHaveBeenCalled(); // no wasted summarization call
    });
  });

  describe('compaction integration + overflow recovery (R3-220)', () => {
    // A client that answers summarization calls (tools:[]) with a summary, and
    // otherwise drives a real turn. The first real turn reports usage over the
    // window so the NEXT iteration compacts; then it finishes.
    function compactionClient() {
      let real = 0;
      const client = {
        calls: 0,
        summaries: 0,
        async createMessage(req: { tools: AgentTool[] }): Promise<ModelResponse> {
          client.calls++;
          if (req.tools.length === 0) {
            client.summaries++;
            return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Goal: build. Progress: edited /src/App.tsx.' }] };
          }
          real++;
          if (real <= 3) {
            return {
              stopReason: 'tool_use',
              content: [{ type: 'tool_use', id: `t${real}`, name: 'spaces__share', input: {} }],
              usage: { inputTokens: 900, outputTokens: 200 }, // 1100 > 1000 − 250
            };
          }
          return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { inputTokens: 300, outputTokens: 20 } };
        },
      };
      return client;
    }

    it('(exit-a) a run that would exceed the window compacts ≥1 time and completes', async () => {
      const client = compactionClient();
      const onCompact = vi.fn();
      const transcript = await runAgent({
        client,
        tools: TOOLS,
        execute: async () => ({ content: 'ok' }),
        prompt: 'build a thing',
        contextWindow: 1000,
        reserveTokens: 250,
        keepRecentTurns: 2,
        events: { onCompact },
      });
      expect(onCompact).toHaveBeenCalled(); // compaction happened
      expect(client.summaries).toBeGreaterThan(0);
      // The run reached a natural finish (last turn is the assistant 'Done').
      const last = transcript[transcript.length - 1];
      expect(last.role).toBe('assistant');
      expect(last.content.some((b) => b.type === 'text' && b.text === 'Done.')).toBe(true);
    });

    it('(exit-c) a hard context-overflow error triggers recover-then-retry, not a dead loop', async () => {
      let threw = false;
      const client = {
        calls: 0,
        async createMessage(req: { tools: AgentTool[] }): Promise<ModelResponse> {
          this.calls++;
          if (req.tools.length === 0) return { stopReason: 'end_turn', content: [{ type: 'text', text: 'summary' }] };
          if (!threw) {
            threw = true;
            throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' });
          }
          return { stopReason: 'end_turn', content: [{ type: 'text', text: 'recovered.' }] };
        },
      };
      // Seed enough history that there IS something to compact on overflow.
      const history: ChatMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'earlier task /src/a.ts' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'h', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h', content: 'x' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ];
      const transcript = await runAgent({
        client,
        tools: TOOLS,
        execute: async () => ({ content: 'ok' }),
        history,
        prompt: 'continue',
        contextWindow: 1000,
        keepRecentTurns: 2,
      });
      expect(isContextOverflow(new Error('maximum context length exceeded'))).toBe(true);
      // It recovered: the run ends with the post-recovery assistant turn, not a throw.
      const last = transcript[transcript.length - 1];
      expect(last.content.some((b) => b.type === 'text' && b.text === 'recovered.')).toBe(true);
    });
  });
});

describe('runAgent — mid-stream abort / stop button (R3-224 §3.3)', () => {
  it('threads an abort signal into every model turn that fires when the stop signal does', async () => {
    // Not identity: since R3-333 the per-turn signal is the STOP signal composed
    // with the steer INTERRUPT signal, so the turn can be ended by either verb. What
    // has to hold — and is what the stop button depends on — is propagation.
    const ctrl = new AbortController();
    let sawSignal = false;
    let abortedDuringTurn: boolean | undefined;
    const client: ModelClient = {
      async createMessage(req) {
        sawSignal = !!req.signal;
        // Abort MID-TURN — the moment the stop button is what it is for — and check
        // the signal the client is holding sees it.
        ctrl.abort();
        abortedDuringTurn = req.signal?.aborted;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    };
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      prompt: 'go',
      signal: ctrl.signal,
    });
    expect(sawSignal).toBe(true);
    expect(abortedDuringTurn).toBe(true);
  });

  it('stops between turns — no further model call — once the signal is aborted', async () => {
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'spaces__share', input: {} }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'should never run' }] },
    ]);
    const ctrl = new AbortController();
    // The first tool execution fires the stop button; the loop's next-turn check halts it.
    const execute = vi.fn(async () => {
      ctrl.abort();
      return { content: 'r' };
    });
    await runAgent({ client, tools: TOOLS, execute, prompt: 'go', signal: ctrl.signal });
    expect(client.calls).toBe(1); // the 2nd model turn was never requested
  });

  it('treats a mid-turn abort (thrown by the client) as a CLEAN stop, not an error', async () => {
    const ctrl = new AbortController();
    const client: ModelClient = {
      async createMessage() {
        ctrl.abort(); // the host aborted the in-flight upstream request
        const e = Object.assign(new Error('stream aborted'), { code: 'aborted' });
        throw e;
      },
    };
    // Must resolve (return the transcript so far), never reject.
    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      prompt: 'go',
      signal: ctrl.signal,
    });
    expect(transcript).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
  });

  it('re-throws a non-abort error (abort handling does not swallow real failures)', async () => {
    const client: ModelClient = {
      async createMessage() {
        throw new Error('genuine provider failure');
      },
    };
    const ctrl = new AbortController(); // never aborted
    await expect(
      runAgent({ client, tools: TOOLS, execute: async () => ({ content: 'r' }), prompt: 'go', signal: ctrl.signal }),
    ).rejects.toThrow(/genuine provider failure/);
  });
});

// ---- R3-559: checkpoint boundaries (AGENT_RUN_DURABILITY_SPEC §4) ------------------

describe('R3-559 — the boundary invariant, proven structurally (G-ARD-11)', () => {
  // THE GATE. R-ARD-7 is an invariant, not a list: every mutation of the loop's
  // `messages` array must be immediately followed by an emitted checkpoint
  // boundary. This test parses agentLoop.ts with the TypeScript compiler API —
  // the AST, never a regex over the source — so a future loop feature that adds
  // a ninth mutation without a boundary fails CI here.
  // `ts.sys` (not node:fs — the dev-fs shim's ambient types shadow it app-wide)
  // reads the module under test from disk.
  const src = ts.sys.readFile(new URL('./agentLoop.ts', import.meta.url).pathname) ?? '';
  const sf = ts.createSourceFile('agentLoop.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
  const isMessagesId = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === 'messages';
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  interface Mutation {
    stmt: ts.Statement;
    where: string;
  }
  const mutations: Mutation[] = [];
  const boundaryCalls: { call: ts.CallExpression; kind: string | null }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === 'messages' && d.initializer) {
          mutations.push({ stmt: node, where: `declaration (line ${line(node)})` });
        }
      }
    }
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      // messages = … / messages[i] = … / messages += … (any assignment operator)
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        const isAssign =
          op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
        if (
          isAssign &&
          (isMessagesId(e.left) ||
            (ts.isElementAccessExpression(e.left) && isMessagesId(e.left.expression)))
        ) {
          mutations.push({ stmt: node, where: `assignment (line ${line(node)})` });
        }
      }
      // messages.push(…) and every other in-place array mutator
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        isMessagesId(e.expression.expression) &&
        MUTATORS.has(e.expression.name.text)
      ) {
        mutations.push({ stmt: node, where: `${e.expression.name.text} call (line ${line(node)})` });
      }
    }
    if (ts.isDeleteExpression(node)) {
      const o = node.expression;
      if (ts.isElementAccessExpression(o) && isMessagesId(o.expression)) {
        mutations.push({ stmt: node.parent as ts.Statement, where: `delete (line ${line(node)})` });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'boundary') {
      let kind: string | null = null;
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'kind' && ts.isStringLiteral(prop.initializer)) {
            kind = prop.initializer.text;
          }
        }
      }
      boundaryCalls.push({ call: node, kind });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  /** Is this statement an `await boundary({...})` emission? */
  const isBoundaryEmission = (s: ts.Statement | undefined): boolean => {
    if (!s || !ts.isExpressionStatement(s)) return false;
    const e = s.expression;
    return (
      ts.isAwaitExpression(e) && ts.isCallExpression(e.expression) && ts.isIdentifier(e.expression.expression) &&
      e.expression.expression.text === 'boundary'
    );
  };

  it('finds the mutation sites (a broken walker proves nothing)', () => {
    // The eight sites the spec names plus the B0 declaration initializer. If this
    // number DROPS, the walker broke; if it RISES, a new mutation arrived — the
    // pairing test below is what forces its boundary.
    expect(mutations.length).toBeGreaterThanOrEqual(9);
  });

  it('every messages mutation is IMMEDIATELY followed by an awaited boundary emission', () => {
    expect(mutations.length).toBeGreaterThan(0);
    const unpaired: string[] = [];
    for (const m of mutations) {
      const parent = m.stmt.parent;
      const stmts = ts.isBlock(parent)
        ? parent.statements
        : ts.isSourceFile(parent)
          ? parent.statements
          : null;
      if (!stmts) {
        unpaired.push(`${m.where} — not in a block`);
        continue;
      }
      const i = stmts.indexOf(m.stmt);
      if (i === -1 || !isBoundaryEmission(stmts[i + 1])) {
        unpaired.push(m.where);
      }
    }
    expect(unpaired).toEqual([]);
  });

  it('every boundary emission is awaited (nobody fires a checkpoint and proceeds)', () => {
    const naked = boundaryCalls.filter(({ call }) => !ts.isAwaitExpression(call.parent));
    expect(naked).toEqual([]);
  });

  it('the executor call is structurally preceded by a B2 emission (intent before execute)', () => {
    // Find `await execute(...)` inside runAgent; within its enclosing for-of loop
    // body there must be a boundary({kind:'B2'}) emission positioned before it.
    let executeCall: ts.CallExpression | undefined;
    const findExecute = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'execute' &&
        ts.isAwaitExpression(node.parent)
      ) {
        executeCall = node;
      }
      ts.forEachChild(node, findExecute);
    };
    findExecute(sf);
    expect(executeCall).toBeDefined();
    const b2 = boundaryCalls.find(
      ({ call, kind }) =>
        kind === 'B2' &&
        executeCall !== undefined &&
        call.getStart(sf) < executeCall.getStart(sf) &&
        // within the same executor loop: the enclosing for-of starts before both
        call.getSourceFile() === executeCall.getSourceFile(),
    );
    expect(b2?.kind).toBe('B2');
  });
});

describe('R3-559 — boundary emission behaviour', () => {
  it('emits B0 before the first model call, with the seeded history + prompt', async () => {
    const seen: LoopBoundary[] = [];
    const client = scriptedClient([{ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ];
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      history,
      prompt: 'q2',
      events: { onBoundary: (b) => void seen.push(b) },
    });
    expect(seen[0]?.kind).toBe('B0');
    if (seen[0]?.kind !== 'B0') return;
    // The B0 payload is a SNAPSHOT, not an alias: it must equal the initial array
    // and must not change when the loop mutates messages afterwards.
    expect(seen[0].messages).toEqual([...history, { role: 'user', content: [{ type: 'text', text: 'q2' }] }]);
    expect(history).toHaveLength(2); // the caller's history array is untouched
  });

  it('B2 is durable before the first executor call, and B3 fires per completed call (G-ARD-2 / R-ARD-7a)', async () => {
    const order: string[] = [];
    const client = scriptedClient([
      {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'spaces__share', input: { a: 1 } },
          { type: 'tool_use', id: 'tu_2', name: 'spaces__share', input: { b: 2 } },
        ],
      },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ]);
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => {
        order.push('execute');
        return { content: 'r' };
      },
      prompt: 'go',
      events: {
        onBoundary: (b) => {
          order.push(b.kind);
          return Promise.resolve();
        },
      },
    });
    // Two calls in one batch: B2 → execute → B3 → B2 → execute → B3, and every
    // B2 precedes its executor call. Swapping the emit and the execute in the
    // loop source fails this.
    expect(order).toEqual([
      'B0',
      'B1',
      'B2', 'execute', 'B3',
      'B2', 'execute', 'B3',
      'B4',
      'B1',
      'B4',
    ]);
  });

  it('each B3 reuses its B2 effectId, and the pair survives in the journal (R-ARD-5e)', async () => {
    const fs = new MemFs();
    const store = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
    const conv = await store.create();
    const client = scriptedClient([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'spaces__share', input: {} }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'fin' }] },
    ]);
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      prompt: 'go',
      events: {
        onBoundary: async (bb) => {
          await store.append(conv.id, bb);
        },
      },
    });
    const replayed = await store.replay(conv.id);
    expect(replayed.pendingEffects).toEqual([]); // the call completed — not dangling
    // The journal's linkage: read the raw entries and check B3.id ⊆ B2.ids.
    const raw = [...fs.files.entries()]
      .filter(([p]) => p.startsWith(`/local/conversations/${conv.id}/journal/`))
      .map(([, v]) => JSON.parse(v) as { kind: string; effectId?: string });
    const b2ids = raw.filter((e) => e.kind === 'B2').map((e) => e.effectId);
    const b3ids = raw.filter((e) => e.kind === 'B3').map((e) => e.effectId);
    expect(b2ids).toHaveLength(1);
    expect(b3ids).toEqual(b2ids); // reused, not re-minted
  });

  it('the spend bound survives a resume: spentTokens CONTINUES, not restarts (G-ARD-13)', async () => {
    const b4s: RunState[] = [];
    const toolTurn = (id: string): ModelResponse => ({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'spaces__share', input: {} }],
      usage: { inputTokens: 100, outputTokens: 50 }, // 150/turn
    });
    const run = async (resume?: { runState: RunState }): Promise<void> => {
      const client = scriptedClient([toolTurn('a'), toolTurn('b'), toolTurn('c')]);
      await runAgent({
        client,
        tools: TOOLS,
        execute: async () => ({ content: 'r' }),
        prompt: 'go',
        tokenBudget: 250,
        ...(resume ? { resume } : {}),
        events: { onBoundary: (b) => {
          if (b.kind === 'B4') b4s.push(b.runState);
        } },
      });
    };
    // Run 1: 150 (turn a) + 150 (turn b) = 300 ≥ 250 → budget stop after batch 2.
    await run();
    const tornDown = b4s[b4s.length - 1];
    expect(tornDown.spentTokens).toBe(300);
    // Resume: seeded with the journaled accounting, ONE more turn reaches
    // 300 + 150 = 450 — continuing, not restarting at 150.
    b4s.length = 0;
    await run({ runState: tornDown });
    expect(b4s[b4s.length - 1].spentTokens).toBe(450);
  });
});

describe('R3-559 — fault-injection sweep (G-ARD-1 / G-ARD-16)', () => {
  // The producer: a REAL runAgent over a scripted multi-kind scenario (steer,
  // nudge, compaction, a two-call batch), journaling every boundary through the
  // REAL store. "Teardown at boundary X" = the append for X fails; everything
  // before it is durable. "Mid-stream" = the provider turn itself dies.
  const SCENARIO_WINDOW = 8_000;

  const makeScenario = () => {
    const executeCalls: string[] = [];
    const steer = new SteerController();
    steer.enqueue('do it differently', 'queue');
    let modelCall = 0;
    const client: ModelClient = {
      async createMessage(req) {
        // Compaction's summarization call answers with a summary; the script
        // only feeds the mainline turns.
        if (req.system?.startsWith('You are compacting')) {
          return { stopReason: 'end_turn', content: [{ type: 'text', text: 'SUMMARY' }] };
        }
        modelCall++;
        switch (modelCall) {
          case 1: // announces + calls tool A
            return {
              stopReason: 'tool_use',
              content: [
                { type: 'text', text: 'Reading first.' },
                { type: 'tool_use', id: 'tuA', name: 'spaces__share', input: { n: 1 } },
              ],
              usage: { inputTokens: 200, outputTokens: 50 },
            };
          case 2: // stall: intent text, no call → nudge (B5)
            return {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: "I'll read the rest of the files next." }],
              usage: { inputTokens: 300, outputTokens: 20 },
            };
          case 3: // a two-call batch (B, C) — the R-ARD-7a kill-after-k case
            return {
              stopReason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'tuB', name: 'spaces__share', input: { n: 2 } },
                { type: 'tool_use', id: 'tuC', name: 'spaces__share', input: { n: 3 } },
              ],
              // Large enough that shouldCompact fires before the NEXT turn → B6.
              usage: { inputTokens: 9_000, outputTokens: 100 },
            };
          case 4:
            return { stopReason: 'end_turn', content: [{ type: 'text', text: 'All done.' }] };
          default:
            return { stopReason: 'end_turn', content: [{ type: 'text', text: '??' }] };
        }
      },
    };
    const execute = async (_name: string, input: Record<string, unknown>): Promise<{ content: string }> => {
      executeCalls.push(String(input.n));
      return { content: `result-${String(input.n)}` };
    };
    return { client, execute, executeCalls, steering: steer };
  };

  const drive = async (
    kill: (b: LoopBoundary) => boolean,
  ): Promise<{ store: ReturnType<typeof createConversationStore>; fs: MemFs; convId: string; executeCalls: string[]; err: unknown }> => {
    const fs = new MemFs();
    const store = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
    const conv = await store.create();
    const sc = makeScenario();
    let err: unknown = null;
    try {
      await runAgent({
        client: sc.client,
        tools: TOOLS,
        execute: sc.execute,
        prompt: 'build it',
        steering: sc.steering,
        contextWindow: SCENARIO_WINDOW,
        maxNudges: 1,
        keepRecentTurns: 2,
        events: {
          onBoundary: async (b) => {
            if (kill(b)) throw Object.assign(new Error('TEARDOWN'), { code: 'teardown' });
            await store.append(conv.id, b);
          },
        },
      });
    } catch (e) {
      err = e;
    }
    return { store, fs, convId: conv.id, executeCalls: sc.executeCalls, err };
  };

  const journalEntries = (fs: MemFs, convId: string): Record<string, unknown>[] =>
    [...fs.files.entries()]
      .filter(([p]) => p.startsWith(`/local/conversations/${convId}/journal/`))
      .map(([, v]) => JSON.parse(v) as Record<string, unknown>)
      .sort((a, b) => Number(a.seq) - Number(b.seq));

  /** The transcript the model actually got: every completed unit, in order. */
  const kinds = (fs: MemFs, convId: string): string[] => journalEntries(fs, convId).map((e) => String(e.kind));

  it('the un-killed scenario emits every boundary kind B0–B6 (a sweep over a dead scenario proves nothing)', async () => {
    const { fs, convId, executeCalls } = await drive(() => false);
    expect(kinds(fs, convId)).toEqual([
      'B0', // kickoff
      'B5', // the queued steer, drained at the first turn boundary
      'B1', 'B2', 'B3', 'B4', // turn 1: assistant + tool A + batch state
      'B1', 'B5', // turn 2: the stalled assistant turn + the nudge
      'B1', 'B2', 'B3', 'B2', 'B3', 'B4', // turn 3: two-call batch, B3 PER CALL
      'B6', // compaction before turn 4 (window exhausted)
      'B1', // turn 4: the final answer
      'B4', // run end
    ]);
    expect(executeCalls).toEqual(['1', '2', '3']);
  });

  const teardownPoints: { name: string; kill: (b: LoopBoundary) => boolean }[] = [
    { name: 'B0 — during the first model turn', kill: (b) => b.kind === 'B0' },
    { name: 'B1 — assistant turn complete', kill: (b) => b.kind === 'B1' },
    { name: 'B2 — tool intent', kill: (b) => b.kind === 'B2' },
    { name: 'B3 — tool result', kill: (b) => b.kind === 'B3' },
    { name: 'B4 — run state', kill: (b) => b.kind === 'B4' },
    { name: 'B5 — injected user turn', kill: (b) => b.kind === 'B5' },
    { name: 'B6 — compaction replacement', kill: (b) => b.kind === 'B6' },
  ];

  for (const point of teardownPoints) {
    it(`teardown at ${point.name}: the journal replays, complete through the last completed turn, and nothing completed is recomputed`, async () => {
      const { store, fs, convId, executeCalls, err } = await drive(point.kill);
      // The teardown surfaced as a failure, never a silent finish.
      expect(err).not.toBeNull();
      const replayed = await store.replay(convId);
      // Completeness: every tool result that was EXECUTED AND checkpointed is in
      // the replay; a call whose B3 never landed is pending — never silently
      // present, never silently absent-with-result.
      const resultTexts = replayed.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as { content: string }).content);
      const checkpointedResults = journalEntries(fs, convId).filter((e) => e.kind === 'B3');
      expect(resultTexts).toHaveLength(checkpointedResults.length);
      // The executor ran ONLY for calls whose intent was durable before it, and
      // never ran past the teardown point.
      expect(executeCalls.length).toBeLessThanOrEqual(journalEntries(fs, convId).filter((e) => e.kind === 'B2').length);
      // Every entry is runtime-neutral (G-ARD-16): JSON round-trip deep-equal.
      for (const e of journalEntries(fs, convId)) {
        expect(JSON.parse(JSON.stringify(e))).toEqual(e);
      }
      // Effect-id linkage across the sweep (G-ARD-16): every B3's effectId was
      // minted by a B2 in the same journal.
      const b2ids = new Set(journalEntries(fs, convId).filter((e) => e.kind === 'B2').map((e) => e.effectId));
      for (const e of journalEntries(fs, convId).filter((x) => x.kind === 'B3')) {
        expect(b2ids.has(e.effectId as string)).toBe(true);
      }
      // The first user turn (the human's own work) is ALWAYS checkpointed (B0
      // writes before the first model call) — the kill-at-B0 case loses only the
      // model's in-flight turn, not the human's prompt.
      expect(replayed.messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === 'build it'))).toBe(
        journalEntries(fs, convId).some((e) => e.kind === 'B0'),
      );
      // Dangling intents are reported, so a resume can mark them started/outcome-unknown.
      const pendingIds = new Set(replayed.pendingEffects.map((p) => p.effectId));
      for (const e of journalEntries(fs, convId).filter((x) => x.kind === 'B2')) {
        const resolved = journalEntries(fs, convId).some((x) => x.kind === 'B3' && x.effectId === e.effectId);
        expect(pendingIds.has(e.effectId as string)).toBe(!resolved);
      }
    });
  }

  it('teardown mid-stream (provider turn dies): the journal replays through the last COMPLETED turn', async () => {
    // Kill inside a model turn: the provider request itself fails after the
    // batch results were checkpointed. Nothing after the failure point exists.
    const fs = new MemFs();
    const store = createConversationStore({ recordRoot: '/settings', journalRoot: '/local', fs, tabId: 'tab-test' });
    const conv = await store.create();
    const sc = makeScenario();
    let modelCall = 0;
    const client: ModelClient = {
      async createMessage(req) {
        if (req.system?.startsWith('You are compacting')) {
          return { stopReason: 'end_turn', content: [{ type: 'text', text: 'SUMMARY' }] };
        }
        modelCall++;
        if (modelCall === 3) throw Object.assign(new Error('stream died'), { code: 'aborted' });
        return sc.client.createMessage(req);
      }
    };
    await expect(
      runAgent({
        client,
        tools: TOOLS,
        execute: sc.execute,
        prompt: 'build it',
        steering: sc.steering,
        contextWindow: SCENARIO_WINDOW,
        maxNudges: 1,
        keepRecentTurns: 2,
        events: {
          onBoundary: async (bb) => {
            await store.append(conv.id, bb);
          },
        },
      }),
    ).rejects.toThrow(/stream died/);
    const replayed = await store.replay(conv.id);
    // Complete through the nudge turn (turn 2 checkpointed); turn 3 never existed.
    const texts = replayed.messages
      .flatMap((m) => m.content)
      .filter((x) => x.type === 'text')
      .map((x) => (x as { text: string }).text);
    expect(texts).toContain("I'll read the rest of the files next.");
    expect(replayed.messages.some((m) => m.content.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'tuB'))).toBe(false);
    expect(replayed.pendingEffects).toEqual([]);
  });
});
