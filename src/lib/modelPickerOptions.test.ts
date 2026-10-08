// The model picker's rules (R3-620), pinned without a DOM: the option list, the
// two "not in the list" labels, and the key↔pair mapping.
import { describe, expect, it } from 'vitest';
import { deriveChatProviderState, type ChatProviderChoice } from '@immediately-run/sdk';
import { buildModelPickerView, pairForKey, pairKey, DEFAULT_MODEL_KEY } from './modelPickerOptions';
import { resolveConversationModel, toHostModelView } from './resolveConversationModel';

const connected: ChatProviderChoice[] = [
  { providerId: 'llm.chat.openrouter', displayName: 'OpenRouter', models: ['capable/model', 'quick/model'] },
  { providerId: 'llm.chat.anthropic', displayName: 'Anthropic', models: ['claude-x'] },
];

// The host view comes from the same derivation the stage uses, over the SDK's state.
const host = toHostModelView(
  deriveChatProviderState(true, false, {
    providerId: 'llm.chat.openrouter',
    hostVouched: true,
    features: { tools: true, vision: false, jsonMode: false, reasoning: false, maxContextTokens: 200000 },
    models: { fast: 'quick/model', smart: 'capable/model' },
    connectedProviders: connected,
  }),
);

describe('buildModelPickerView (R3-620)', () => {
  it('no connected set, or an empty one → no picker', () => {
    expect(buildModelPickerView(undefined, host, undefined)).toBeNull();
    expect(buildModelPickerView(undefined, host, [])).toBeNull();
  });

  it('lists one option per connected provider × model, in the host order', () => {
    const view = buildModelPickerView(undefined, host, connected)!;
    expect(view.options.map((o) => o.label)).toEqual([
      'OpenRouter · capable/model',
      'OpenRouter · quick/model',
      'Anthropic · claude-x',
    ]);
    expect(view.value).toBe(DEFAULT_MODEL_KEY);
  });

  it('the default option names what it would run, with or without a stored choice', () => {
    expect(buildModelPickerView(undefined, host, connected)!.defaultLabel).toBe('Settings default · capable/model');
    expect(
      buildModelPickerView({ providerId: 'llm.chat.anthropic', model: 'claude-x' }, host, connected)!.defaultLabel,
    ).toBe('Settings default · capable/model');
    expect(buildModelPickerView(undefined, { ...host, default: null }, connected)!.defaultLabel).toBe('Settings default');
  });

  it('a stored listed pair is the selected value and adds no extra option', () => {
    const stored = { providerId: 'llm.chat.anthropic', model: 'claude-x' };
    const view = buildModelPickerView(stored, host, connected)!;
    expect(view.value).toBe(pairKey(stored));
    expect(view.options).toHaveLength(3);
  });

  it('a stored pair whose provider is gone is labelled "(not connected)" — and the run agrees it is inert', () => {
    const stored = { providerId: 'llm.chat.gemini', model: 'gemini-x' };
    const view = buildModelPickerView(stored, host, connected)!;
    expect(view.options.at(-1)).toEqual({ key: pairKey(stored), label: 'llm.chat.gemini · gemini-x (not connected)', pair: stored });
    expect(view.value).toBe(pairKey(stored));
    expect(resolveConversationModel({ model: stored }, host).source).toBe('default');
  });

  it('a stored model the connected provider no longer suggests is labelled "(not listed)" — and the run still uses it', () => {
    const stored = { providerId: 'llm.chat.anthropic', model: 'claude-retired' };
    const view = buildModelPickerView(stored, host, connected)!;
    expect(view.options.at(-1)?.label).toBe('Anthropic · claude-retired (not listed)');
    expect(resolveConversationModel({ model: stored }, host)).toEqual({ model: stored, source: 'record' });
  });

  it('the label and the run agree for every stored pair: "(not connected)" exactly when the run falls back', () => {
    const cases = [
      { providerId: 'llm.chat.openrouter', model: 'capable/model' },
      { providerId: 'llm.chat.openrouter', model: 'unlisted' },
      { providerId: 'llm.chat.anthropic', model: 'claude-retired' },
      { providerId: 'llm.chat.gemini', model: 'gemini-x' },
      { providerId: 'llm.chat.gemini', model: 'capable/model' },
    ];
    for (const stored of cases) {
      const view = buildModelPickerView(stored, host, connected)!;
      const label = view.options.find((o) => o.key === view.value)!.label;
      const fallsBack = resolveConversationModel({ model: stored }, host).source === 'default';
      expect(label.endsWith('(not connected)'), JSON.stringify(stored)).toBe(fallsBack);
    }
  });
});

describe('pairForKey (R3-620)', () => {
  const stored = { providerId: 'llm.chat.gemini', model: 'gemini-x' };
  const view = buildModelPickerView(stored, host, connected)!;

  it('the default key → null (clear the choice)', () => {
    expect(pairForKey(view, DEFAULT_MODEL_KEY)).toBeNull();
  });

  it('every option key maps back to its own pair', () => {
    for (const o of view.options) expect(pairForKey(view, o.key)).toEqual(o.pair);
  });

  it('a key the view does not hold → undefined, never null: an unknown value must not clear the choice', () => {
    expect(pairForKey(view, 'llm.chat.anthropic:claude-x')).toBeUndefined();
    expect(pairForKey(view, pairKey({ providerId: 'nope', model: 'nope' }))).toBeUndefined();
  });

  it('two pairs that concatenate alike get different keys', () => {
    expect(pairKey({ providerId: 'a', model: 'bc' })).not.toBe(pairKey({ providerId: 'ab', model: 'c' }));
  });
});
