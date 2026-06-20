import { describe, it, expect, vi } from 'vitest';

// hostFetch/hostFetchStream are host-only; mock the SDK so importing the client
// in node doesn't pull the real protocol transport.
vi.mock('@immediately-run/sdk', () => ({ hostFetch: vi.fn(), hostFetchStream: vi.fn() }));

import {
  createClaudeClient,
  splitSseData,
  type FetchLike,
  type StreamLike,
} from './claudeClient';

const sse = (objs: object[]): string => objs.map((o) => `event: x\ndata: ${JSON.stringify(o)}\n\n`).join('');

// Slice a string into fixed-size chunks to exercise cross-chunk SSE buffering.
const chunk = (s: string, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

const STREAM_EVENTS = [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

describe('claudeClient — SSE assembly', () => {
  it('splitSseData extracts complete events and keeps a trailing partial', () => {
    const buf = sse([{ type: 'ping' }]) + 'event: x\ndata: {"type":"par';
    const { events, rest } = splitSseData(buf);
    expect(events).toEqual([{ type: 'ping' }]);
    expect(rest).toContain('"type":"par');
  });

  it('streams text deltas and assembles text + tool_use blocks', async () => {
    const chunks = chunk(sse(STREAM_EVENTS), 13); // tiny chunks → split mid-event
    const streamImpl: StreamLike = async function* () {
      for (const c of chunks) yield { chunk: c };
      return { status: 200, statusText: 'OK' };
    };
    const deltas: string[] = [];
    const client = createClaudeClient({ streamImpl });
    const res = await client.createMessage({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      onTextDelta: (t) => deltas.push(t),
    });

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  it('throws on a non-2xx streamed status using the buffered body', async () => {
    const streamImpl: StreamLike = async function* () {
      yield { chunk: '{"type":"error","error":{"message":"bad request"}}' };
      return { status: 400, statusText: 'Bad Request' };
    };
    const client = createClaudeClient({ streamImpl });
    await expect(
      client.createMessage({ messages: [], tools: [] }),
    ).rejects.toThrow(/Anthropic/);
  });

  it('falls back to non-streaming hostFetch when the host returns not-streamable', async () => {
    const streamImpl: StreamLike = async function* () {
      throw Object.assign(new Error('no streaming'), { code: 'not-streamable' });
      yield { chunk: '' }; // unreachable; satisfies the generator type
    };
    const fetchImpl = vi.fn<FetchLike>(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: JSON.stringify({ content: [{ type: 'text', text: 'buffered' }], stop_reason: 'end_turn' }),
    }) as Awaited<ReturnType<FetchLike>>);

    const client = createClaudeClient({ streamImpl, fetchImpl });
    const res = await client.createMessage({ messages: [], tools: [] });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res).toEqual({ content: [{ type: 'text', text: 'buffered' }], stopReason: 'end_turn' });
  });

  it('does not send x-api-key by default (host injects it); sends it only as a dev override', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      seen.push(init?.headers);
      return { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) } as Awaited<ReturnType<FetchLike>>;
    });
    await createClaudeClient({ streamImpl: null, fetchImpl }).createMessage({ messages: [], tools: [] });
    expect(seen[0]).not.toHaveProperty('x-api-key');

    await createClaudeClient({ streamImpl: null, fetchImpl, apiKey: 'sk-test' }).createMessage({ messages: [], tools: [] });
    expect(seen[1]).toMatchObject({ 'x-api-key': 'sk-test' });
  });
});
