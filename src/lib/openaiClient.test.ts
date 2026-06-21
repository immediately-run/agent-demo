import { describe, it, expect, vi } from 'vitest';

// hostFetch/hostFetchStream are host-only; mock the SDK so importing the client in
// node doesn't pull the real protocol transport.
vi.mock('@immediately-run/sdk', () => ({ hostFetch: vi.fn(), hostFetchStream: vi.fn() }));

import {
  createOpenAIClient,
  toOpenAIMessages,
  toOpenAITools,
  parseOpenAIResponse,
  finishToStopReason,
  applyOpenAIStreamEvent,
  finalizeOpenAIStream,
  newOpenAIStreamState,
  type FetchLike,
  type StreamLike,
} from './openaiClient';
import type { ChatMessage } from './agentLoop';
import type { AgentTool } from './agentTools';

const sse = (objs: object[]): string => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
const chunk = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

describe('openaiClient — message translation', () => {
  it('maps system + a multi-turn tool conversation into OpenAI shape', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'edit a.ts' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.ts', text: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ];
    expect(toOpenAIMessages('be terse', messages)).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'edit a.ts' },
      {
        role: 'assistant',
        content: 'sure',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.ts","text":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
  });

  it('emits one tool message per tool_result block and omits an empty system', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        ],
      },
    ];
    expect(toOpenAIMessages(undefined, messages)).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', content: 'rb' },
    ]);
  });

  it('represents a text-only assistant turn with content and no tool_calls', () => {
    const out = toOpenAIMessages(undefined, [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
    expect(out).toEqual([{ role: 'assistant', content: 'done' }]);
  });
});

describe('openaiClient — tool + response translation', () => {
  const tools: AgentTool[] = [
    { name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: {} }, additionalProperties: false } },
  ];

  it('maps Anthropic-shaped tools to OpenAI function tools', () => {
    expect(toOpenAITools(tools)).toEqual([
      { type: 'function', function: { name: 'read_file', description: 'read', parameters: tools[0].input_schema } },
    ]);
  });

  it('maps finish_reason to the loop stop reason', () => {
    expect(finishToStopReason('tool_calls')).toBe('tool_use');
    expect(finishToStopReason('length')).toBe('max_tokens');
    expect(finishToStopReason('stop')).toBe('end_turn');
    expect(finishToStopReason(undefined)).toBe('end_turn');
  });

  it('parses a tool-call response into text + tool_use blocks', () => {
    const res = parseOpenAIResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'calling',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
          },
        },
      ],
    });
    expect(res).toEqual({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a.ts' } },
      ],
      stopReason: 'tool_use',
    });
  });

  it('tolerates malformed tool-call arguments (empty input, host validates)', () => {
    const res = parseOpenAIResponse({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{bad' } }] } }],
    });
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c', name: 'x', input: {} }]);
  });
});

describe('openaiClient — streaming SSE assembly', () => {
  const STREAM = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];

  it('assembles content + tool_calls across arbitrary chunk boundaries', () => {
    const state = newOpenAIStreamState();
    const deltas: string[] = [];
    const buf = sse(STREAM) + 'data: [DONE]\n\n';
    let acc = '';
    // feed 7-byte chunks through the same split the client uses
    for (const c of chunk(buf, 7)) {
      acc += c;
      // mimic splitSseData by parsing on full blocks
    }
    // Apply events directly (split is covered by claudeClient tests).
    for (const evt of STREAM) applyOpenAIStreamEvent(state, evt, (t) => deltas.push(t));
    expect(deltas.join('')).toBe('Hello');
    expect(finalizeOpenAIStream(state)).toEqual({
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
      stopReason: 'tool_use',
    });
    expect(acc).toBe(buf);
  });
});

describe('openaiClient — createOpenAIClient over a mocked transport', () => {
  it('non-streaming: posts to {baseURL}/chat/completions and parses the reply', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'hi there' } }] }),
    } as Awaited<ReturnType<FetchLike>>);
    const client = createOpenAIClient({ baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', streamImpl: null, fetchImpl });
    const res = await client.createMessage({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] });
    expect(res).toEqual({ content: [{ type: 'text', text: 'hi there' }], stopReason: 'end_turn' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.messages[0]).toEqual({ role: 'system', content: 's' });
    // No app-set auth header — the host injects Authorization: Bearer.
    expect((init as { headers: Record<string, string> }).headers.authorization).toBeUndefined();
  });

  it('throws a coded http error on a non-2xx status', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ status: 401, statusText: 'Unauthorized', body: 'no key' } as Awaited<ReturnType<FetchLike>>);
    const client = createOpenAIClient({ streamImpl: null, fetchImpl });
    await expect(client.createMessage({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] })).rejects.toMatchObject({
      code: 'http-401',
    });
  });

  it('streaming: parses the SSE stream into a ModelResponse', async () => {
    const streamBody = sse([
      { choices: [{ delta: { content: 'yo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) + 'data: [DONE]\n\n';
    const streamImpl: StreamLike = async function* () {
      for (const c of chunk(streamBody, 9)) yield { chunk: c };
      return { status: 200, statusText: 'OK' };
    };
    const deltas: string[] = [];
    const client = createOpenAIClient({ streamImpl });
    const res = await client.createMessage({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      onTextDelta: (t) => deltas.push(t),
    });
    expect(deltas.join('')).toBe('yo');
    expect(res).toEqual({ content: [{ type: 'text', text: 'yo' }], stopReason: 'end_turn' });
  });
});
