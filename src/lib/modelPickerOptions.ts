// The model picker's rules (R3-620), pure — the option list, the labels and the
// key↔pair mapping the `ModelPicker` shell renders. Kept beside
// `resolveConversationModel` because the two must agree: an option is marked
// "not connected" on exactly the predicate that makes the run fall back to the
// Settings default, and on nothing else.

import type { ChatProviderChoice } from '@immediately-run/sdk';
import type { ConversationModelPair, HostModelView } from './resolveConversationModel';

/** The select value that means "the Settings default". */
export const DEFAULT_MODEL_KEY = '';

/** One select value per pair. NUL cannot appear in a provider id or a model id. */
export const pairKey = (pair: ConversationModelPair): string => pair.providerId + '\u0000' + pair.model;

export interface ModelPickerOption {
  key: string;
  label: string;
  pair: ConversationModelPair;
}

export interface ModelPickerView {
  /** The label of the Settings-default option — it names what choosing it would run. */
  defaultLabel: string;
  /** Every listed pair, then the stored pair when the list does not hold it. */
  options: ModelPickerOption[];
  /** The select's current value: the stored pair's key, or the default key. */
  value: string;
}

/**
 * The picker's whole view, or `null` when there is nothing to choose from (the
 * host sent no connected set — this frame does not hold `llm:chooseModel`).
 *
 * A stored pair the list does not hold still gets an option, so the select can
 * show what the record says. Its suffix follows the run's own rule:
 *  - the provider is not connected → "(not connected)": the run uses the
 *    Settings default until the user reconnects it or picks something else;
 *  - the provider is connected, the model just is not among the suggestions →
 *    "(not listed)": the run still uses it, because the host passes the model
 *    string through to the provider exactly as the Settings field does.
 */
export function buildModelPickerView(
  stored: ConversationModelPair | undefined,
  host: HostModelView,
  connected: readonly ChatProviderChoice[] | undefined,
): ModelPickerView | null {
  if (!connected || connected.length === 0) return null;
  const options: ModelPickerOption[] = [];
  for (const c of connected) {
    for (const model of c.models) {
      const pair = { providerId: c.providerId, model };
      options.push({ key: pairKey(pair), label: `${c.displayName} · ${model}`, pair });
    }
  }
  if (stored && !options.some((o) => o.key === pairKey(stored))) {
    const provider = connected.find((c) => c.providerId === stored.providerId);
    const isConnected = host.connectedProviderIds.includes(stored.providerId);
    options.push({
      key: pairKey(stored),
      label: `${provider?.displayName ?? stored.providerId} · ${stored.model} ${isConnected ? '(not listed)' : '(not connected)'}`,
      pair: { providerId: stored.providerId, model: stored.model },
    });
  }
  return {
    defaultLabel: host.default ? `Settings default · ${host.default.model}` : 'Settings default',
    options,
    value: stored ? pairKey(stored) : DEFAULT_MODEL_KEY,
  };
}

/**
 * What a selected key means: `null` for the Settings default, the pair for a
 * listed option, and `undefined` for a key the view does not hold — which the
 * caller must treat as "change nothing", never as "clear the choice".
 */
export function pairForKey(view: ModelPickerView, key: string): ConversationModelPair | null | undefined {
  if (key === DEFAULT_MODEL_KEY) return null;
  return view.options.find((o) => o.key === key)?.pair;
}
