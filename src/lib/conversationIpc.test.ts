import { describe, it, expect } from 'vitest';
import { isSelect, isUpdated, PANEL_REGION, STAGE_REGION } from './conversationIpc';

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
});
