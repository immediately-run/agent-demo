// A ModelClient for OpenAI-compatible providers (OpenRouter, OpenAI-compatible
// gateways, local servers) over the platform's §5.11 BYOK proxy. Same provider
// seam as claudeClient.ts, but speaks the OpenAI **Chat Completions** wire format
// instead of the Anthropic Messages format — so the in-browser coding agent works
// against any provider the spec's §2.2/§2.4 BYOK path can reach. OpenRouter is the
// default: `api.openai.com` does not serve browser CORS (LLM_AND_AGENTS_SPEC §2.2),
// but OpenAI-compatible *gateways* like OpenRouter do, so they are usable
// browser-direct.
//
// The loop speaks Anthropic-shaped {@link ChatMessage}s (text / tool_use /
// tool_result blocks); this client TRANSLATES them to/from OpenAI's
// messages+tool_calls shape, and translates the tool list and the SSE stream too.
//
// The key (SECRETS_SPEC §6): no key is sent from the app — the host injects
// `Authorization: Bearer` after the gate, from the `injectSecret` selector this app
// declares for the provider host in package.json (`{ type:'bearer-token' }`). The
// value never enters the sandbox. (An explicit `apiKey` is supported only as a
// test/dev seam.)

import { hostFetch, hostFetchStream, type HostFetchInit, type HostFetchResponse } from '@immediately-run/sdk';
import { splitSseData } from './claudeClient';
import type { ChatMessage, ModelClient, ModelResponse, TextBlock, ToolUseBlock } from './agentLoop';
import type { AgentTool } from './agentTools';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 16000;

export type FetchLike = (url: string, init?: HostFetchInit) => Promise<HostFetchResponse>;
/** The streaming seam — defaults to the SDK's `hostFetchStream`; faked in tests. */
export type StreamLike = (
  url: string,
  init?: HostFetchInit,
) => AsyncGenerator<{ chunk: string }, unknown, void>;

export interface OpenAIClientOptions {
  /** BYOK key — TEST/DEV ONLY. In production omit it: the host injects the key as
   *  `Authorization: Bearer` via `injectSecret` after the gate. */
  apiKey?: string;
  /** Provider base URL, e.g. `https://openrouter.ai/api/v1`. `/chat/completions`
   *  is appended. */
  baseURL?: string;
  /** Provider/model id (e.g. `openai/gpt-4o-mini` on OpenRouter). */
  model?: string;
  maxTokens?: number;
  /** Injected for tests; defaults to the SDK's `hostFetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to the SDK's `hostFetchStream`. Pass `null` to
   *  force the non-streaming path. */
  streamImpl?: StreamLike | null;
}

// ----- translation: the loop's Anthropic-shaped types → OpenAI wire ----------

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Map the loop's conversation (system + Anthropic-shaped blocks) into the OpenAI
 *  Chat Completions message list. A single Anthropic user turn carrying N
 *  `tool_result` blocks becomes N `role:'tool'` messages (each keyed by its
 *  `tool_call_id`), matching the assistant `tool_calls` that preceded it. */
export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: OAIToolCall[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use')
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user turn: text → a user message; tool_result blocks → tool messages.
      let text = '';
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Map the app's Anthropic-shaped tool catalog to OpenAI `function` tools (the
 *  JSON-Schema `input_schema` becomes the function `parameters`). */
export function toOpenAITools(tools: AgentTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** OpenAI `finish_reason` → the loop's Anthropic-style `stopReason`. `tool_calls`
 *  is the one the loop branches on (keep going); everything else is terminal. */
export const finishToStopReason = (fr?: string): string =>
  fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';

interface OAIResponseMessage {
  content?: string | null;
  tool_calls?: OAIToolCall[];
}
interface OAIChoice {
  message?: OAIResponseMessage;
  finish_reason?: string;
}
interface OAIResponse {
  choices?: OAIChoice[];
}

/** Parse a non-streamed Chat Completions response into the neutral
 *  {@link ModelResponse}. */
export function parseOpenAIResponse(json: OAIResponse): ModelResponse {
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const content: (TextBlock | ToolUseBlock)[] = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      /* leave empty — the host validates params regardless */
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return { content, stopReason: finishToStopReason(choice?.finish_reason) };
}

// ----- streaming SSE assembly (pure, exported for tests) ---------------------

interface ToolAccum {
  id: string;
  name: string;
  args: string;
}
export interface OpenAIStreamState {
  text: string;
  tools: Map<number, ToolAccum>;
  finishReason?: string;
}
export const newOpenAIStreamState = (): OpenAIStreamState => ({ text: '', tools: new Map() });

/** Fold one OpenAI stream chunk into `state`, firing `onTextDelta` on content. The
 *  `[DONE]` sentinel is not valid JSON, so {@link splitSseData} drops it before we
 *  ever see it here. */
export function applyOpenAIStreamEvent(
  state: OpenAIStreamState,
  evt: unknown,
  onTextDelta?: (t: string) => void,
): void {
  const choice = (evt as { choices?: OAIStreamChoice[] }).choices?.[0];
  if (!choice) return;
  const d = choice.delta ?? {};
  if (typeof d.content === 'string' && d.content) {
    state.text += d.content;
    onTextDelta?.(d.content);
  }
  for (const tc of d.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    let acc = state.tools.get(idx);
    if (!acc) {
      acc = { id: '', name: '', args: '' };
      state.tools.set(idx, acc);
    }
    if (tc.id) acc.id = tc.id;
    if (tc.function?.name) acc.name = tc.function.name;
    if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
  }
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
}

interface OAIStreamToolDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OAIStreamChoice {
  delta?: { content?: string | null; tool_calls?: OAIStreamToolDelta[] };
  finish_reason?: string;
}

/** Assemble the streamed deltas into the neutral {@link ModelResponse}. */
export function finalizeOpenAIStream(state: OpenAIStreamState): ModelResponse {
  const content: (TextBlock | ToolUseBlock)[] = [];
  if (state.text) content.push({ type: 'text', text: state.text });
  for (const idx of [...state.tools.keys()].sort((a, b) => a - b)) {
    const t = state.tools.get(idx)!;
    let input: Record<string, unknown> = {};
    try {
      input = t.args ? (JSON.parse(t.args) as Record<string, unknown>) : {};
    } catch {
      /* leave empty — the host validates params regardless */
    }
    content.push({ type: 'tool_use', id: t.id, name: t.name, input });
  }
  return { content, stopReason: finishToStopReason(state.finishReason) };
}

// ----- client ----------------------------------------------------------------

const headersFor = (apiKey?: string): Record<string, string> => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`; // dev/test only; prod relies on injectSecret
  return h;
};

export function createOpenAIClient(opts: OpenAIClientOptions = {}): ModelClient {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseURL}/chat/completions`;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch: FetchLike = opts.fetchImpl ?? hostFetch;
  const doStream: StreamLike | null =
    opts.streamImpl === null ? null : (opts.streamImpl ?? (hostFetchStream as unknown as StreamLike));

  const buildBody = (req: ModelClientReq, stream: boolean): string =>
    JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: toOpenAIMessages(req.system, req.messages),
      ...(req.tools.length ? { tools: toOpenAITools(req.tools) } : {}),
      ...(stream ? { stream: true } : {}),
    });

  async function nonStreaming(req: ModelClientReq): Promise<ModelResponse> {
    const res = await doFetch(url, { method: 'POST', headers: headersFor(opts.apiKey), body: buildBody(req, false) });
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.statusText, res.body);
    let parsed: OAIResponse;
    try {
      parsed = JSON.parse(res.body) as OAIResponse;
    } catch {
      throw new Error('OpenAI-compatible API: response body was not valid JSON');
    }
    return parseOpenAIResponse(parsed);
  }

  async function streaming(req: ModelClientReq): Promise<ModelResponse> {
    const gen = doStream!(url, { method: 'POST', headers: headersFor(opts.apiKey), body: buildBody(req, true) });
    const state = newOpenAIStreamState();
    let buffer = '';
    let raw = '';
    const it = gen[Symbol.asyncIterator]();
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
      for (const evt of events) applyOpenAIStreamEvent(state, evt, req.onTextDelta);
    }
    return finalizeOpenAIStream(state);
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
  const err = new Error(`OpenAI-compatible API ${status} ${statusText}: ${body.slice(0, 500)}`) as Error & { code?: string };
  err.code = `http-${status}`;
  return err;
}
