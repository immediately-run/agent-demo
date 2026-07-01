import { describe, it, expect, vi } from 'vitest';
import { runAgent, detectStall, type ChatMessage, type ModelClient, type ModelResponse } from './agentLoop';
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
});
