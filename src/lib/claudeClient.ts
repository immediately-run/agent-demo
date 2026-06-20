// A ModelClient for Claude over the platform's §5.11 BYOK proxy. The app can't use
// the Node Anthropic SDK (it runs in an opaque-origin iframe); instead it calls
// the Anthropic Messages API (raw HTTP) through the host fetch proxy, which lends
// the host origin to clear the CORS wall — credential-less. This is
// LLM_AND_AGENTS_SPEC §2.2 "Approach 2 (BYOK via net:fetch)".
//
// Streaming (P3-71): `createMessage` prefers `hostFetchStream`, parsing the
// Anthropic SSE event stream and emitting text deltas through `onTextDelta` as
// they arrive. If the host hasn't shipped the streaming emitter it throws
// `not-streamable`, and we fall back to a single buffered `hostFetch`.
//
// The key (SECRETS_SPEC §6): no key is sent from the app — the host injects
// `x-api-key` after the gate, from the `injectSecret` selector this app declares
// in package.json (`{ family:'anthropic', type:'api-key' }`). The value never
// enters the sandbox. (An explicit `apiKey` is supported only as a test/dev seam.)

import { hostFetch, hostFetchStream, type HostFetchInit, type HostFetchResponse } from '@immediately-run/sdk';
import type { ModelClient, ModelResponse, TextBlock, ToolUseBlock } from './agentLoop';
import type { AgentTool } from './agentTools';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 16000;

export type FetchLike = (url: string, init?: HostFetchInit) => Promise<HostFetchResponse>;
/** The streaming seam — defaults to the SDK's `hostFetchStream`; faked in tests. */
export type StreamLike = (
  url: string,
  init?: HostFetchInit,
) => AsyncGenerator<{ chunk: string }, unknown, void>;

export interface ClaudeClientOptions {
  /** BYOK key — TEST/DEV ONLY. In production omit it: the host injects the key
   *  via `injectSecret` after the gate, so the app never holds it. */
  apiKey?: string;
  /** Defaults to `claude-opus-4-8` (the spec leaves model choice to the app). */
  model?: string;
  maxTokens?: number;
  /** Injected for tests; defaults to the SDK's `hostFetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to the SDK's `hostFetchStream`. Pass `null` to
   *  force the non-streaming path. */
  streamImpl?: StreamLike | null;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicMessage {
  content?: AnthropicBlock[];
  stop_reason?: string;
}

// ----- streaming SSE assembly (pure, exported for tests) ---------------------

interface BlockAccum {
  type: 'text' | 'tool_use' | string;
  id?: string;
  name?: string;
  text: string;
  partialJson: string;
}
export interface StreamState {
  blocks: Map<number, BlockAccum>;
  stopReason: string;
}
export const newStreamState = (): StreamState => ({ blocks: new Map(), stopReason: 'end_turn' });

/** Split an SSE buffer into the parsed `data:` JSON payloads it contains, plus
 *  any trailing partial event still awaiting more bytes. */
export function splitSseData(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: unknown[] = [];
  for (const block of parts) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* malformed event — drop it */
    }
  }
  return { events, rest };
}

/** Fold one Anthropic stream event into `state`, firing `onTextDelta` on text. */
export function applyStreamEvent(state: StreamState, evt: unknown, onTextDelta?: (t: string) => void): void {
  const e = evt as { type?: string; index?: number; content_block?: AnthropicBlock; delta?: Record<string, unknown> };
  switch (e.type) {
    case 'content_block_start': {
      const cb = e.content_block ?? { type: 'text' };
      state.blocks.set(e.index ?? 0, { type: cb.type, id: cb.id, name: cb.name, text: cb.text ?? '', partialJson: '' });
      break;
    }
    case 'content_block_delta': {
      const block = state.blocks.get(e.index ?? 0);
      if (!block) break;
      const d = e.delta ?? {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        block.text += d.text;
        onTextDelta?.(d.text);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        block.partialJson += d.partial_json;
      }
      break;
    }
    case 'message_delta': {
      const stop = (e.delta as { stop_reason?: string } | undefined)?.stop_reason;
      if (stop) state.stopReason = stop;
      break;
    }
    case 'error': {
      const msg = (evt as { error?: { message?: string } }).error?.message ?? 'stream error';
      throw new Error(`Anthropic stream error: ${msg}`);
    }
    default:
      break; // message_start, content_block_stop, ping, message_stop
  }
}

/** Assemble the streamed blocks into the loop's neutral {@link ModelResponse}. */
export function finalizeStream(state: StreamState): ModelResponse {
  const content: (TextBlock | ToolUseBlock)[] = [];
  for (const idx of [...state.blocks.keys()].sort((a, b) => a - b)) {
    const b = state.blocks.get(idx)!;
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      let input: Record<string, unknown> = {};
      try {
        input = b.partialJson ? (JSON.parse(b.partialJson) as Record<string, unknown>) : {};
      } catch {
        /* leave empty — the host validates params regardless */
      }
      content.push({ type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input });
    }
  }
  return { content, stopReason: state.stopReason };
}

// ----- client ----------------------------------------------------------------

const headersFor = (apiKey?: string): Record<string, string> => {
  const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
  if (apiKey) h['x-api-key'] = apiKey; // dev/test only; prod relies on injectSecret
  return h;
};

export function createClaudeClient(opts: ClaudeClientOptions = {}): ModelClient {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch: FetchLike = opts.fetchImpl ?? hostFetch;
  const doStream: StreamLike | null =
    opts.streamImpl === null ? null : (opts.streamImpl ?? (hostFetchStream as unknown as StreamLike));

  const buildBody = (
    system: string | undefined,
    messages: ModelClientReq['messages'],
    tools: AgentTool[],
    stream: boolean,
  ): string =>
    // NB: no `thinking` param — omitting it runs Opus 4.8 without thinking,
    // sidestepping round-tripping thinking blocks across tool-use turns.
    JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages, tools, ...(stream ? { stream: true } : {}) });

  async function nonStreaming(req: ModelClientReq): Promise<ModelResponse> {
    const body = buildBody(req.system, req.messages, req.tools, false);
    const res = await doFetch(ANTHROPIC_URL, { method: 'POST', headers: headersFor(opts.apiKey), body });
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.statusText, res.body);
    let parsed: AnthropicMessage;
    try {
      parsed = JSON.parse(res.body) as AnthropicMessage;
    } catch {
      throw new Error('Anthropic API: response body was not valid JSON');
    }
    const content = (parsed.content ?? [])
      .filter((b) => b.type === 'text' || b.type === 'tool_use')
      .map((b): TextBlock | ToolUseBlock =>
        b.type === 'text'
          ? { type: 'text', text: b.text ?? '' }
          : { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} },
      );
    return { content, stopReason: parsed.stop_reason ?? 'end_turn' };
  }

  async function streaming(req: ModelClientReq): Promise<ModelResponse> {
    const body = buildBody(req.system, req.messages, req.tools, true);
    const gen = doStream!(ANTHROPIC_URL, { method: 'POST', headers: headersFor(opts.apiKey), body });
    const state = newStreamState();
    let buffer = '';
    let raw = '';
    const it = gen[Symbol.asyncIterator]();
    // Manual iteration so we can read the generator's terminal return (status).
    for (;;) {
      const step = await it.next();
      if (step.done) {
        const result = step.value as { status?: number; statusText?: string } | undefined;
        if (result && typeof result.status === 'number' && (result.status < 200 || result.status >= 300)) {
          throw httpError(result.status, result.statusText ?? '', raw);
        }
        break;
      }
      raw += step.value.chunk;
      buffer += step.value.chunk;
      const { events, rest } = splitSseData(buffer);
      buffer = rest;
      for (const evt of events) applyStreamEvent(state, evt, req.onTextDelta);
    }
    return finalizeStream(state);
  }

  return {
    async createMessage(req) {
      if (doStream) {
        try {
          return await streaming(req);
        } catch (e) {
          // Host streaming emitter not live yet → fall back to buffered fetch.
          if ((e as { code?: string })?.code !== 'not-streamable') throw e;
        }
      }
      return nonStreaming(req);
    },
  };
}

type ModelClientReq = Parameters<ModelClient['createMessage']>[0];

function httpError(status: number, statusText: string, body: string): Error & { code?: string } {
  const err = new Error(`Anthropic API ${status} ${statusText}: ${body.slice(0, 500)}`) as Error & { code?: string };
  err.code = `http-${status}`;
  return err;
}
