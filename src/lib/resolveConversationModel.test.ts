// resolveConversationModel (R3-620): the per-conversation model resolution,
// pinned pure — every rule the stage's picker and the run's chat call ride on.
import { describe, expect, it } from 'vitest';
import { deriveChatProviderState, type ChatProviderInfo } from '@immediately-run/sdk';
import {
  resolveConversationModel,
  runModelFor,
  toHostModelView,
  type HostModelView,
} from './resolveConversationModel';
import type { Conversation } from './conversationModel';

const conv = (model?: Conversation['model']): Pick<Conversation, 'model'> => ({ model });

const host = (over: Partial<HostModelView> = {}): HostModelView => ({
  default: { providerId: 'llm.chat.openrouter', model: 'default/model' },
  connectedProviderIds: ['llm.chat.openrouter', 'llm.chat.anthropic'],
  ...over,
});

describe('resolveConversationModel (R3-620)', () => {
  it('an absent field → the host default (the Settings default)', () => {
    expect(resolveConversationModel(conv(), host())).toEqual({
      model: { providerId: 'llm.chat.openrouter', model: 'default/model' },
      source: 'default',
    });
  });

  it('a present pair whose provider is connected → the stored pair', () => {
    expect(
      resolveConversationModel(conv({ providerId: 'llm.chat.anthropic', model: 'claude-x' }), host()),
    ).toEqual({ model: { providerId: 'llm.chat.anthropic', model: 'claude-x' }, source: 'record' });
  });

  it('a stored provider the user has since disconnected → the host default, never a gone provider', () => {
    // The stale record cannot pin the conversation to a provider that is gone:
    // the host would refuse the pair with provider-not-connected, so resolving it
    // to the default here is the honest degraded state — what answers is the
    // user's default, visibly.
    expect(
      resolveConversationModel(conv({ providerId: 'llm.chat.gemini', model: 'gemini-x' }), host()),
    ).toEqual({ model: { providerId: 'llm.chat.openrouter', model: 'default/model' }, source: 'default' });
  });

  it('an EMPTY connected set (no llm:chooseModel on this frame) makes every stored choice inert', () => {
    // A frame that does not hold the elevated capability gets no chooseable set,
    // so a stored pair (e.g. an older host or a differently-granted frame) resolves
    // to the default rather than erroring the run.
    expect(
      resolveConversationModel(conv({ providerId: 'llm.chat.anthropic', model: 'claude-x' }), host({ connectedProviderIds: [] })),
    ).toEqual({ model: { providerId: 'llm.chat.openrouter', model: 'default/model' }, source: 'default' });
  });

  it('a host with NO default resolves a stored connected pair anyway — the choice outranks the default', () => {
    expect(
      resolveConversationModel(conv({ providerId: 'llm.chat.anthropic', model: 'claude-x' }), host({ default: null })),
    ).toEqual({ model: { providerId: 'llm.chat.anthropic', model: 'claude-x' }, source: 'record' });
    // And nothing at all resolves to nothing.
    expect(resolveConversationModel(conv(), host({ default: null }))).toEqual({ model: null, source: 'default' });
  });
});

// The provider info as the host describes it to a frame holding `llm:chooseModel`.
const info = (over: Partial<ChatProviderInfo> = {}): ChatProviderInfo => ({
  providerId: 'llm.chat.openrouter',
  hostVouched: true,
  features: { tools: true, vision: false, jsonMode: false, reasoning: false, maxContextTokens: 200000 },
  models: { fast: 'quick/model', smart: 'capable/model' },
  connectedProviders: [
    { providerId: 'llm.chat.openrouter', displayName: 'OpenRouter', models: ['capable/model', 'quick/model'] },
    { providerId: 'llm.chat.anthropic', displayName: 'Anthropic', models: ['claude-x'] },
  ],
  ...over,
});

// The states come from the SDK's own derivation, the producer the stage reads.
const configured = (over: Partial<ChatProviderInfo> = {}) => deriveChatProviderState(true, false, info(over));

describe('toHostModelView (R3-620)', () => {
  it('a configured provider → the Capable-tier model as the default, and the connected ids', () => {
    expect(toHostModelView(configured())).toEqual({
      default: { providerId: 'llm.chat.openrouter', model: 'capable/model' },
      connectedProviderIds: ['llm.chat.openrouter', 'llm.chat.anthropic'],
    });
  });

  it('a frame without llm:chooseModel (no connected set) → no chooseable ids, the default intact', () => {
    expect(toHostModelView(configured({ connectedProviders: undefined }))).toEqual({
      default: { providerId: 'llm.chat.openrouter', model: 'capable/model' },
      connectedProviderIds: [],
    });
  });

  it('an older host that sends no tier models → no default to name', () => {
    expect(toHostModelView(configured({ models: undefined })).default).toBeNull();
  });

  it('every state that is not configured → nothing resolves', () => {
    const empty = { default: null, connectedProviderIds: [] };
    expect(toHostModelView(deriveChatProviderState(false, false, null))).toEqual(empty); // unknown
    expect(toHostModelView(deriveChatProviderState(true, false, null))).toEqual(empty); // not-configured
    expect(toHostModelView(deriveChatProviderState(true, true, null))).toEqual(empty); // ungranted
  });
});

describe('runModelFor (R3-620) — what rides chat()', () => {
  const chosen = { providerId: 'llm.chat.anthropic', model: 'claude-x' };

  it('a stored choice whose provider is connected rides the request', () => {
    expect(runModelFor({ model: chosen }, configured())).toEqual(chosen);
  });

  it('no stored choice → nothing rides; the default stays host-side', () => {
    expect(runModelFor({}, configured())).toBeUndefined();
    expect(runModelFor(null, configured())).toBeUndefined();
  });

  it('a stored choice whose provider is gone → nothing rides, so the host answers with the default', () => {
    expect(runModelFor({ model: { providerId: 'llm.chat.gemini', model: 'g' } }, configured())).toBeUndefined();
  });

  it('a frame without the connected set → nothing rides, whatever the record says', () => {
    expect(runModelFor({ model: chosen }, configured({ connectedProviders: undefined }))).toBeUndefined();
    expect(runModelFor({ model: chosen }, deriveChatProviderState(true, true, null))).toBeUndefined();
  });

  it('a stored model the provider no longer suggests still rides — the host passes the string through', () => {
    const unlisted = { providerId: 'llm.chat.anthropic', model: 'claude-retired' };
    expect(runModelFor({ model: unlisted }, configured())).toEqual(unlisted);
  });
});
