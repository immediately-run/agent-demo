import { describe, it, expect } from 'vitest';
import {
  isSelect,
  isUpdated,
  PANEL_REGION,
  STAGE_REGION,
  isRequestSelection,
  isClearSelection,
  clearSelectionMessage,
} from './conversationIpc';

describe('conversationIpc — panel↔stage message contract', () => {
  it('region constants name the two slots', () => {
    expect(PANEL_REGION).toBe('panel.agent');
    expect(STAGE_REGION).toBe('stage.conversation');
  });

  it('isSelect accepts a well-formed selection and rejects others', () => {
    expect(isSelect({ type: 'select-conversation', id: 'c1' })).toBe(true);
    expect(isSelect({ type: 'select-conversation' })).toBe(false); // no id
    expect(isSelect({ type: 'conversation-updated', id: 'c1' })).toBe(false);
    expect(isSelect(null)).toBe(false);
    expect(isSelect('nope')).toBe(false);
  });

  it('isUpdated accepts a well-formed update and rejects others', () => {
    expect(isUpdated({ type: 'conversation-updated', id: 'c1' })).toBe(true);
    expect(isUpdated({ type: 'select-conversation', id: 'c1' })).toBe(false);
    expect(isUpdated({ type: 'conversation-updated' })).toBe(false);
    expect(isUpdated(undefined)).toBe(false);
  });

  it('isRequestSelection accepts the stage handshake and rejects the others (R3-243)', () => {
    expect(isRequestSelection({ type: 'request-selection' })).toBe(true);
    // Carries no payload at all — the panel answers from its OWN state, so a crafted
    // id on this message could never steer which conversation gets shown.
    expect(isRequestSelection({ type: 'request-selection', id: 'attacker-choice' })).toBe(true);
    expect(isRequestSelection({ type: 'select-conversation', id: 'c1' })).toBe(false);
    expect(isRequestSelection({ type: 'conversation-updated', id: 'c1' })).toBe(false);
    expect(isRequestSelection({})).toBe(false);
    expect(isRequestSelection(null)).toBe(false);
    expect(isRequestSelection('request-selection')).toBe(false);
  });

  it('isClearSelection accepts the empty-selection message and rejects others (R3-1079)', () => {
    expect(isClearSelection({ type: 'clear-selection' })).toBe(true);
    // Carries no payload, like request-selection: the stage's empty state is its
    // own — a crafted id here has nothing to steer.
    expect(isClearSelection({ type: 'clear-selection', id: 'attacker-choice' })).toBe(true);
    expect(isClearSelection({ type: 'select-conversation', id: 'c1' })).toBe(false);
    expect(isClearSelection({ type: 'request-selection' })).toBe(false);
    expect(isClearSelection({})).toBe(false);
    expect(isClearSelection(null)).toBe(false);
    expect(isClearSelection('clear-selection')).toBe(false);
  });

  it('clearSelectionMessage builds the one shape the announcing sites post (R3-1079)', () => {
    expect(clearSelectionMessage()).toEqual({ type: 'clear-selection' });
    expect(isClearSelection(clearSelectionMessage())).toBe(true);
  });

  it('the four message types are mutually exclusive', () => {
    const msgs = [
      { type: 'select-conversation', id: 'c1' },
      { type: 'request-selection' },
      { type: 'conversation-updated', id: 'c1' },
      { type: 'clear-selection' },
    ];
    const guards = [isSelect, isRequestSelection, isUpdated, isClearSelection];
    for (const m of msgs) {
      expect(guards.filter((g) => g(m)).length).toBe(1);
    }
  });
});
