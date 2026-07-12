import { describe, it, expect, vi } from 'vitest';
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
} from './agentLoop';
import type { AgentTool } from './agentTools';

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
  it('threads the abort signal into every model turn', async () => {
    let seenSignal: AbortSignal | undefined;
    const client: ModelClient = {
      async createMessage(req) {
        seenSignal = req.signal;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const ctrl = new AbortController();
    await runAgent({
      client,
      tools: TOOLS,
      execute: async () => ({ content: 'r' }),
      prompt: 'go',
      signal: ctrl.signal,
    });
    expect(seenSignal).toBe(ctrl.signal);
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
