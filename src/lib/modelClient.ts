// Provider selection for the agent loop (LLM_AND_AGENTS_SPEC §2.2). The loop is
// provider-agnostic (agentLoop.ts); this picks which {@link ModelClient} backs it.
// V1 supports two BYOK families browser-direct:
//   - OpenAI-compatible (OpenRouter / gateways / local servers) — openaiClient.ts,
//     `Authorization: Bearer` injected for `injectSecret {type:'bearer-token'}`.
//   - Anthropic — claudeClient.ts, `x-api-key` injected for
//     `injectSecret {family:'anthropic', type:'api-key'}`.
//
// Each provider's host must be declared in package.json `immediately.run.requests`
// so the host can inject the matching secret on the browser-direct call. The
// default is OpenRouter: `api.openai.com` does not serve browser CORS (§2.2), but
// OpenAI-compatible gateways do, giving the broadest browser-direct coverage.

import { createClaudeClient } from './claudeClient';
import { createOpenAIClient } from './openaiClient';
import type { ModelClient } from './agentLoop';

export type ProviderId = 'openrouter' | 'anthropic';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** The `net:fetch` host this provider needs declared in the manifest (and where
   *  the host injects the key). */
  host: string;
  /** Provider/model id passed in the request body. */
  model: string;
  /** OpenAI-compatible base URL (omitted for the Anthropic provider). */
  baseURL?: string;
  /** The stored-secret `type` the host injects for this provider — `bearer-token`
   *  (→ `Authorization: Bearer`) for OpenAI-compatible, `api-key` (→ `x-api-key`)
   *  for Anthropic. The app binds the user's stored secret of this type via the
   *  `requestSecret` powerbox before it can call the provider. */
  secretType: 'bearer-token' | 'api-key';
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    host: 'https://openrouter.ai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    secretType: 'bearer-token',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    host: 'https://api.anthropic.com',
    model: 'claude-opus-4-8',
    secretType: 'api-key',
  },
};

/** V1 default. Configurable via {@link createModelClient}; OpenRouter gives the
 *  broadest browser-direct BYOK coverage (spec §2.2). */
export const DEFAULT_PROVIDER: ProviderId = 'openrouter';

/** Build the {@link ModelClient} for `provider`. No `apiKey` is passed: in
 *  production the host injects the key via `injectSecret` after the gate, so the
 *  app never holds it.
 *
 *  `streamImpl: null` forces the NON-streaming, browser-direct `hostFetch` path
 *  (SECRETS_SPEC §2.2). The secure BYOK `injectSecret` path is browser-direct: the
 *  parent host decrypts the client-sealed key and injects it into a direct fetch.
 *  Streaming (`hostFetchStream`) goes through the BACKEND proxy
 *  (`/api/v1/net-fetch-stream`), which by design (D2) never sees the credential, so
 *  it can't inject a BYOK secret — a streamed BYOK call is refused. We therefore
 *  buffer the turn instead of streaming it. */
export function createModelClient(provider: ProviderId = DEFAULT_PROVIDER): ModelClient {
  if (provider === 'anthropic') return createClaudeClient({ model: PROVIDERS.anthropic.model, streamImpl: null });
  const p = PROVIDERS.openrouter;
  return createOpenAIClient({ baseURL: p.baseURL, model: p.model, streamImpl: null });
}
