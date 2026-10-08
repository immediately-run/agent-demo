// The per-conversation model resolution (R3-620, LLM_AND_AGENTS_SPEC §0's
// editing-session exception). PURE — extracted from the stage so the resolution
// rules are pinned by unit tests without a DOM, exactly the `stageSelection.ts`
// shape: the picker is a thin shell over this, the run consumes its result, and
// neither re-derives the rules.
//
// The choice belongs to the CONVERSATION, not to the app and not to the account:
// a stored pair names one of the user's CONNECTED providers; absent means "the
// Settings default"; and a stored provider the user has since DISCONNECTED falls
// back to the Settings default — a stale record cannot pin a conversation to a
// provider that is gone (the host would refuse the pair with
// `provider-not-connected`, so resolving it away here is the honest degraded
// state, not a silent substitution: what answers is the default, visibly).

import type { ChatProviderState } from '@immediately-run/sdk';
import type { Conversation } from './conversationModel';

/** A concrete provider-and-model pair — the shape `chat()`'s `model` field takes. */
export interface ConversationModelPair {
  providerId: string;
  model: string;
}

/** What the host resolves for this frame right now (R3-620). */
export interface HostModelView {
  /**
   * What `chat()` with no pair would run: the resolved provider + the tier model
   * (the request's `modelHint: 'smart'`, resolved host-side). `null` when no
   * provider resolves at all (the SDK's `not-configured`).
   */
  default: ConversationModelPair | null;
  /**
   * The connected providers' ids — `describeChat().connectedProviders`, which the
   * host only sends a frame holding the ELEVATED `llm:chooseModel` capability (an
   * editing-session workbench). Empty otherwise: the choice is then inert, and a
   * stored pair resolves to the default rather than erroring the run.
   */
  connectedProviderIds: readonly string[];
}

/** The resolution: what this conversation's next `chat()` runs, and why. */
export interface ConversationModelResolution {
  /** The resolved pair — `null` when no provider resolves at all. */
  model: ConversationModelPair | null;
  /** Whether the pair came from the record's explicit choice or the host default. */
  source: 'record' | 'default';
}

/**
 * Resolve what this conversation's next `chat()` runs.
 *
 *  - a record with NO stored choice → the host default (absent ⇒ `null`: no
 *    provider, the run surfaces the host's own connect path);
 *  - a stored choice whose provider is STILL connected → the stored pair;
 *  - a stored choice whose provider has since been disconnected → the host
 *    default, so the conversation keeps running on what the user still holds.
 */
export function resolveConversationModel(
  conv: Pick<Conversation, 'model'>,
  host: HostModelView,
): ConversationModelResolution {
  const stored = conv.model;
  if (stored && host.connectedProviderIds.includes(stored.providerId)) {
    return { model: { providerId: stored.providerId, model: stored.model }, source: 'record' };
  }
  return { model: host.default, source: 'default' };
}

/**
 * The host's provider state → the view the resolution reads. One derivation for
 * the picker's render and for every run's kickoff, so what the picker shows and
 * what the run sends cannot drift apart.
 */
export function toHostModelView(ps: ChatProviderState): HostModelView {
  const info = ps.status === 'configured' ? ps.provider : null;
  return {
    default: info?.models !== undefined ? { providerId: info.providerId, model: info.models.smart } : null,
    connectedProviderIds: info?.connectedProviders?.map((c) => c.providerId) ?? [],
  };
}

/**
 * The pair a run's `chat()` carries, or `undefined` for the host-resolved
 * default. Only a choice read from the record rides the request: the default
 * stays host-side, so a Settings change applies without the app re-sending it.
 */
export function runModelFor(
  conv: Pick<Conversation, 'model'> | null | undefined,
  ps: ChatProviderState,
): ConversationModelPair | undefined {
  const resolved = resolveConversationModel(conv ?? {}, toHostModelView(ps));
  return resolved.source === 'record' && resolved.model ? resolved.model : undefined;
}
