import { describe, it, expect } from 'vitest';
import { toDisplayRows, summarizeToolInput } from './displayRows';
import { messagesToLog } from './transcript';
import type { ChatMessage } from './agentLoop';

describe('toDisplayRows', () => {
  it('pairs a tool call with its result into one folded row', () => {
    expect(
      toDisplayRows([
        { kind: 'user', text: 'go' },
        { kind: 'tool', name: 'read_file', input: { path: 'a' } },
        { kind: 'result', name: 'read_file', content: 'bytes' },
        { kind: 'text', text: 'done' },
      ]),
    ).toEqual([
      { kind: 'entry', key: 0, entry: { kind: 'user', text: 'go' } },
      {
        kind: 'toolcall',
        key: 1,
        name: 'read_file',
        input: { path: 'a' },
        result: { content: 'bytes', isError: undefined },
      },
      { kind: 'entry', key: 3, entry: { kind: 'text', text: 'done' } },
    ]);
  });

  it('keeps an in-flight call (no result yet) as a running row', () => {
    const rows = toDisplayRows([{ kind: 'tool', name: 'glob', input: { pattern: '**/*.ts' } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'toolcall', name: 'glob' });
    expect((rows[0] as { result?: unknown }).result).toBeUndefined();
  });

  // A parallel-tool turn emits tool A, tool B, result A, result B — adjacency
  // pairing would attach A's result to B. Same-name calls resolve in call order.
  it('pairs out-of-adjacency and same-name calls in call order', () => {
    const rows = toDisplayRows([
      { kind: 'tool', name: 'read_file', input: { path: 'a' } },
      { kind: 'tool', name: 'read_file', input: { path: 'b' } },
      { kind: 'result', name: 'read_file', content: 'A' },
      { kind: 'result', name: 'read_file', content: 'B', isError: true },
    ]);
    expect(rows).toEqual([
      { kind: 'toolcall', key: 0, name: 'read_file', input: { path: 'a' }, result: { content: 'A', isError: undefined } },
      { kind: 'toolcall', key: 1, name: 'read_file', input: { path: 'b' }, result: { content: 'B', isError: true } },
    ]);
  });

  it('keeps an orphan result (truncated replay) visible as a passthrough row', () => {
    const rows = toDisplayRows([{ kind: 'result', name: 'tool', content: 'late' }]);
    expect(rows).toEqual([{ kind: 'entry', key: 0, entry: { kind: 'result', name: 'tool', content: 'late' } }]);
  });

  // §4 rule (ways_of_working): at least one input from the REAL producer. This
  // drives the same messagesToLog the stage replays through, not a hand-typed log.
  it('pairs a replayed transcript produced by messagesToLog', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'x' } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'a' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'hits' },
          { type: 'tool_result', tool_use_id: 't2', content: 'bytes' },
        ],
      },
    ];
    const rows = toDisplayRows(messagesToLog(messages));
    expect(rows).toEqual([
      { kind: 'entry', key: 0, entry: { kind: 'user', text: 'go' } },
      { kind: 'toolcall', key: 1, name: 'grep', input: { pattern: 'x' }, result: { content: 'hits', isError: undefined } },
      { kind: 'toolcall', key: 2, name: 'read_file', input: { path: 'a' }, result: { content: 'bytes', isError: undefined } },
    ]);
  });
});

describe('summarizeToolInput', () => {
  it('shows the path for file tools', () => {
    expect(summarizeToolInput({ path: 'src/App.tsx', content: 'x'.repeat(500) })).toBe('src/App.tsx');
  });
  it('shows from → to for move/copy', () => {
    expect(summarizeToolInput({ from: 'a.ts', to: 'b.ts' })).toBe('a.ts → b.ts');
  });
  it('shows the pattern for glob/grep', () => {
    expect(summarizeToolInput({ pattern: 'src/**/*.ts' })).toBe('src/**/*.ts');
  });
  it('falls back to the first string argument', () => {
    expect(summarizeToolInput({ count: 3, label: 'hello' })).toBe('hello');
  });
  it('clips long values and collapses whitespace', () => {
    const s = summarizeToolInput({ path: `a${' '.repeat(10)}b${'x'.repeat(200)}` });
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/ {2}/);
  });
  it('returns empty for a no-argument call', () => {
    expect(summarizeToolInput({})).toBe('');
  });
});
