// A ModelClient for Claude over the platform's §5.11 BYOK proxy. The app can't use
// the Node Anthropic SDK (it runs in an opaque-origin iframe); instead it calls
// the Anthropic Messages API (raw HTTP) through `hostFetch`, which lends the host
// origin to clear the CORS wall — credential-less, so the user's API key is the
// only auth. This is LLM_AND_AGENTS_SPEC §2.2 "Approach 2 (BYOK via net:fetch)".
//
// The app's package.json must declare `api.anthropic.com` under
// `immediately.run.requests."net:fetch"` for the host to permit the call.

import { hostFetch, type HostFetchInit, type HostFetchResponse } from '@immediately-run/sdk';
import type { ModelClient, TextBlock, ToolUseBlock } from './agentLoop';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';
// Non-streaming reply: keep max_tokens under the host/SDK HTTP-timeout ceiling.
// Streaming (larger budgets) lands when net:fetch streaming ships (P3-71 Half B).
const DEFAULT_MAX_TOKENS = 16000;

export type FetchLike = (url: string, init?: HostFetchInit) => Promise<HostFetchResponse>;

export interface ClaudeClientOptions {
  /** BYOK key (interim). Omit to rely on host-side `injectSecret` (SECRETS_SPEC
   *  §6) once the secret store ships — the host injects `x-api-key` after the
   *  gate, so the app never holds the key. */
  apiKey?: string;
  /** Defaults to `claude-opus-4-8` (the spec leaves model choice to the app). */
  model?: string;
  maxTokens?: number;
  /** Injected for tests; defaults to the SDK's `hostFetch`. */
  fetchImpl?: FetchLike;
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

export function createClaudeClient(opts: ClaudeClientOptions = {}): ModelClient {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch: FetchLike = opts.fetchImpl ?? hostFetch;

  return {
    async createMessage({ system, messages, tools }) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      };
      // With a BYOK key, send it; otherwise the host injects it (injectSecret).
      if (opts.apiKey) headers['x-api-key'] = opts.apiKey;

      // NB: no `thinking` param — omitting it runs Opus 4.8 without thinking,
      // which sidesteps having to round-trip thinking blocks across tool-use
      // turns. Enabling adaptive thinking (+ preserving thinking blocks) is a
      // follow-up once the loop carries them.
      const body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
        tools,
      });

      const res = await doFetch(ANTHROPIC_URL, { method: 'POST', headers, body });
      if (res.status < 200 || res.status >= 300) {
        const err = new Error(
          `Anthropic API ${res.status} ${res.statusText}: ${res.body.slice(0, 500)}`,
        ) as Error & { code?: string };
        err.code = `http-${res.status}`;
        throw err;
      }

      let parsed: AnthropicMessage;
      try {
        parsed = JSON.parse(res.body) as AnthropicMessage;
      } catch {
        throw new Error('Anthropic API: response body was not valid JSON');
      }

      // Keep only text + tool_use (drop any thinking/other blocks); map to the
      // loop's neutral block shapes.
      const content = (parsed.content ?? [])
        .filter((b) => b.type === 'text' || b.type === 'tool_use')
        .map((b): TextBlock | ToolUseBlock =>
          b.type === 'text'
            ? { type: 'text', text: b.text ?? '' }
            : { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} },
        );

      return { content, stopReason: parsed.stop_reason ?? 'end_turn' };
    },
  };
}
