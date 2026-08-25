// R3-335 — the reasoning stream, app side. The exit criteria are decided here.

import { describe, it, expect, vi } from 'vitest';
import {
  compactTranscript,
  estimateTokens,
  runAgent,
  type ChatMessage,
  type ModelClient,
  type ModelResponse,
} from './agentLoop';
import { messagesToLog } from './transcript';
import type { AgentTool } from './agentTools';

const TOOLS: AgentTool[] = [{ name: 'read_file', description: 'r', input_schema: { type: 'object' } }];
const exec = async () => ({ content: 'ok' });

const reasoningTurn = (text: string, signature?: string): ModelResponse => ({
  stopReason: 'tool_use',
  content: [
    { type: 'reasoning', text, ...(signature ? { signature } : {}) },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
  ],
});

describe('exit 1 — the blocks reach the transcript and are echoed back in position', () => {
  it('keeps reasoning in the message sequence, FIRST in its turn', async () => {
    let turn = 0;
    const sent: ChatMessage[][] = [];
    const client: ModelClient = {
      async createMessage(req) {
        sent.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        turn++;
        if (turn === 1) return reasoningTurn('I should read the file', 'SIG');
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
      },
    };
    const transcript = await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go', maxTurns: 4 });

    const assistant = transcript.find((m) => m.role === 'assistant')!;
    expect(assistant.content[0]).toEqual({ type: 'reasoning', text: 'I should read the file', signature: 'SIG' });
    // Turn 2's request carries it back — with the signature, which is the part whose
    // loss degrades rather than errors.
    expect(JSON.stringify(sent[1])).toContain('"signature":"SIG"');
  });

  it('reports reasoning to the UI live and whole', async () => {
    const onReasoningDelta = vi.fn();
    const onReasoning = vi.fn();
    const client: ModelClient = {
      async createMessage(req) {
        req.onReasoningDelta?.('let me ');
        req.onReasoningDelta?.('look');
        return { stopReason: 'end_turn', content: [{ type: 'reasoning', text: 'let me look' }, { type: 'text', text: 'ok' }] };
      },
    };
    await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go', events: { onReasoningDelta, onReasoning } });
    expect(onReasoningDelta.mock.calls.map((c) => c[0])).toEqual(['let me ', 'look']);
    expect(onReasoning).toHaveBeenCalledWith({ type: 'reasoning', text: 'let me look' });
  });

  it('counts toward the context budget rather than escaping the accounting', () => {
    const withReasoning: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'x'.repeat(400) }] },
    ];
    expect(estimateTokens(withReasoning)).toBe(100);
    expect(estimateTokens([{ role: 'assistant', content: [{ type: 'reasoning', text: '', redactedData: 'y'.repeat(400) }] }])).toBe(100);
  });
});

describe('exit 2 — a provider that emits none changes nothing', () => {
  it('a run with no reasoning is exactly what it was', async () => {
    const client: ModelClient = {
      async createMessage() {
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'hello' }] };
      },
    };
    const transcript = await runAgent({ client, tools: TOOLS, execute: exec, prompt: 'go' });
    expect(messagesToLog(transcript).map((e) => e.kind)).toEqual(['user', 'text']);
    // No empty affordance: nothing to render, and the events never fire.
    expect(messagesToLog(transcript).some((e) => e.kind === 'reasoning')).toBe(false);
  });
});

describe('exit 3 — a conversation containing reasoning replays identically', () => {
  it('renders reasoning as its own row, never as the reply', () => {
    const stored: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'weighing options', signature: 'S' },
          { type: 'text', text: 'Here you go.' },
        ],
      },
    ];
    expect(messagesToLog(stored)).toEqual([
      { kind: 'user', text: 'go' },
      { kind: 'reasoning', text: 'weighing options' },
      { kind: 'text', text: 'Here you go.' },
    ]);
  });

  it('shows redacted reasoning as redacted, with no text to render', () => {
    const stored: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: '', redactedData: 'ZZZ' }] },
    ];
    expect(messagesToLog(stored)).toEqual([{ kind: 'reasoning', text: '', redacted: true }]);
    // The opaque bytes are NOT put on screen.
    expect(JSON.stringify(messagesToLog(stored))).not.toContain('ZZZ');
  });

  it('round-trips through JSON the way conversationStore persists it', () => {
    const stored: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'why not', signature: 'S' }, { type: 'text', text: 'ok' }] },
    ];
    const reloaded = JSON.parse(JSON.stringify(stored)) as ChatMessage[];
    expect(messagesToLog(reloaded)).toEqual(messagesToLog(stored));
  });
});

describe('exit 4 — compaction handles reasoning by an explicit rule', () => {
  const summarizer: ModelClient = {
    async createMessage() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'SUMMARY' }] };
    },
  };

  const longTranscript = (): ChatMessage[] => {
    const out: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
    for (let i = 0; i < 6; i++) {
      out.push({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: `thinking ${i}`, signature: `S${i}` },
          { type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `${i}` } },
        ],
      });
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] });
    }
    return out;
  };

  it('DROPS reasoning from the kept tail — it is only ever needed by the turn that follows it', async () => {
    const { messages, summarizedCount } = await compactTranscript(longTranscript(), summarizer, 4);
    expect(summarizedCount).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).not.toContain('thinking');
    expect(JSON.stringify(messages)).not.toContain('"signature"');
  });

  it('does not break the sequence doing it — every tool_use keeps its tool_result', async () => {
    const { messages } = await compactTranscript(longTranscript(), summarizer, 4);
    const uses = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_use');
    const results = messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results.length).toBe(uses.length);
    // …and no message was left with no content at all.
    for (const m of messages) expect(m.content.length).toBeGreaterThan(0);
  });

  it('leaves a reasoning-free transcript byte-identical', async () => {
    const plain: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
      { role: 'user', content: [{ type: 'text', text: 'e' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'f' }] },
    ];
    const { messages } = await compactTranscript(plain, summarizer, 2);
    const keptTail = messages.slice(1); // [0] is the summary
    expect(keptTail).toEqual(plain.slice(plain.length - keptTail.length));
  });
});
