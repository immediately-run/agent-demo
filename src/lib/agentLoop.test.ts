import { describe, it, expect, vi } from 'vitest';
import { runAgent, type ModelClient, type ModelResponse } from './agentLoop';
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
});
