import { describe, it, expect } from 'vitest';
import { messagesToLog } from './transcript';
import { NUDGE_TEXT, type ChatMessage } from './agentLoop';

describe('messagesToLog', () => {
  it('flattens turns and correlates tool results to their tool name', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bytes' }] },
    ];
    expect(messagesToLog(messages)).toEqual([
      { kind: 'user', text: 'go' },
      { kind: 'text', text: 'reading' },
      { kind: 'tool', name: 'read_file', input: { path: 'a' } },
      { kind: 'result', name: 'read_file', content: 'bytes', isError: undefined },
    ]);
  });

  it('classifies a replayed nudge as a nudge row, not a user message', () => {
    // The §2 backstop injects NUDGE_TEXT as a `user` text turn; on replay it must
    // read as a nudge, not as something the user typed.
    const messages: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: "I'll read the file." }] },
      { role: 'user', content: [{ type: 'text', text: NUDGE_TEXT }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    expect(messagesToLog(messages)).toEqual([
      { kind: 'text', text: "I'll read the file." },
      { kind: 'nudge' },
      { kind: 'text', text: 'Done.' },
    ]);
  });
});
