// resolveConversationModel (R3-620): the per-conversation model resolution,
// pinned pure — every rule the stage's picker and the run's chat call ride on.
import { describe, expect, it } from 'vitest';
import { resolveConversationModel, type HostModelView } from './resolveConversationModel';
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
