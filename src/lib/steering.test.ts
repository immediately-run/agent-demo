// R3-333 — steering and follow-up. The exit criteria live here: correcting a run
// without restarting it (1), an interrupt that leaves nothing generating (2), stop
// still distinguishable from steer (3), replay fidelity (4), and the case most
// likely to malform a transcript — a steer arriving while a tool call runs (5).

import { describe, it, expect, vi } from 'vitest';
import {
  SteerController,
  anySignal,
  parseSteer,
  steerWireText,
  STEER_MARKER,
  STEER_INTERRUPT_MARKER,
  INTERRUPTED_TURN_TEXT,
} from './steering';
import {
  runAgent,
  type ChatMessage,
  type ModelClient,
  type ModelResponse,
  type ToolExecutor,
} from './agentLoop';
import { messagesToLog } from './transcript';
import type { AgentTool } from './agentTools';

const TOOLS: AgentTool[] = [{ name: 'write_file', description: 'w', input_schema: { type: 'object' } }];
const noopExec: ToolExecutor = async () => ({ content: 'ok' });

const textTurn = (text: string): ModelResponse => ({ stopReason: 'end_turn', content: [{ type: 'text', text }] });
const callTurn = (id: string, input: Record<string, unknown>): ModelResponse => ({
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'write_file', input }],
});

/** A client that plays a script and records the messages it was sent each turn. */
const scripted = (turns: Array<(req: { messages: ChatMessage[] }) => ModelResponse | Promise<ModelResponse>>) => {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const client: ModelClient = {
    async createMessage(req) {
      seen.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
      const fn = turns[Math.min(i, turns.length - 1)];
      i++;
      return fn(req);
    },
  };
  return { client, seen, turns: () => i };
};

const textOf = (messages: ChatMessage[]): string =>
  JSON.stringify(messages.flatMap((m) => m.content.filter((b) => b.type === 'text')));

describe('the queue itself', () => {
  it('queues, reports pending, and hands them over in arrival order', () => {
    const s = new SteerController();
    s.enqueue('first');
    s.enqueue('second');
    expect(s.pending().map((m) => m.text)).toEqual(['first', 'second']);
    expect(s.hasPending()).toBe(true);
    expect(s.drain().map((m) => m.text)).toEqual(['first', 'second']);
    expect(s.hasPending()).toBe(false);
  });

  it('ignores an empty steer and trims what it keeps', () => {
    const s = new SteerController();
    expect(s.enqueue('   ')).toBeNull();
    expect(s.enqueue('\n')).toBeNull();
    expect(s.enqueue('  do the thing  ')?.text).toBe('do the thing');
  });

  it('a queued follow-up is cancellable while it waits', () => {
    const s = new SteerController();
    const m = s.enqueue('never mind')!;
    expect(s.cancel(m.id)).toBe(true);
    expect(s.hasPending()).toBe(false);
    expect(s.cancel(m.id)).toBe(false);
  });

  it('an interrupt fires the signal; cancelling the only interrupt re-arms it', () => {
    const s = new SteerController();
    const m = s.enqueue('stop and do this instead', 'interrupt')!;
    expect(s.interrupt.aborted).toBe(true);
    s.cancel(m.id);
    // A correction the user took back must not abort the next turn.
    expect(s.interrupt.aborted).toBe(false);
  });

  it('notifies subscribers so the UI can show what is queued', () => {
    const s = new SteerController();
    const seen: number[] = [];
    const off = s.onChange((p) => seen.push(p.length));
    s.enqueue('a');
    s.enqueue('b');
    s.drain();
    off();
    s.enqueue('c');
    expect(seen).toEqual([1, 2, 0]);
  });
});

describe('anySignal', () => {
  it('fires when any input fires, and stops listening once disposed', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = anySignal([a.signal, b.signal, undefined]);
    expect(signal.aborted).toBe(false);
    b.abort();
    expect(signal.aborted).toBe(true);

    const c = new AbortController();
    const second = anySignal([c.signal]);
    second.dispose();
    c.abort();
    expect(second.signal.aborted).toBe(false);
  });

  it('is already aborted when an input was aborted before composition', () => {
    const a = new AbortController();
    a.abort();
    expect(anySignal([a.signal]).signal.aborted).toBe(true);
  });
});

describe('exit 1 — a correction mid-run, without restarting', () => {
  it("the agent's NEXT turn carries the correction, and the transcript is kept", async () => {
    const steering = new SteerController();
    const { client, seen } = scripted([
      () => {
        // The user types a correction while turn 1 is being processed.
        steering.enqueue('not that file — edit src/Other.tsx');
        return callTurn('t1', { path: 'src/App.tsx' });
      },
      () => textTurn('done'),
    ]);
    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: noopExec,
      prompt: 'edit the app',
      steering,
      maxTurns: 4,
    });
    // Turn 2's request contains the steer; turn 1's did not.
    expect(textOf(seen[0])).not.toContain('src/Other.tsx');
    expect(textOf(seen[1])).toContain('src/Other.tsx');
    // The kickoff prompt is still there — this was a correction, not a restart.
    expect(textOf(transcript)).toContain('edit the app');
  });

  it('a follow-up queued against a FINISHING run continues it instead of ending', async () => {
    const steering = new SteerController();
    let turn = 0;
    const { client } = scripted([
      () => {
        turn++;
        if (turn === 1) {
          steering.enqueue('one more thing: add a test');
          return textTurn('all done');
        }
        return textTurn('ok, added');
      },
    ]);
    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: noopExec,
      prompt: 'go',
      steering,
      maxTurns: 5,
    });
    expect(textOf(transcript)).toContain('add a test');
    expect(textOf(transcript)).toContain('ok, added');
  });
});

describe('exit 2 — interrupt-and-steer ends the in-flight turn, not the run', () => {
  it('aborts the in-flight model request and continues with the correction', async () => {
    const steering = new SteerController();
    let abortedInTurn1 = false;
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        turn++;
        if (turn === 1) {
          req.onTextDelta?.('I will edit App');
          // The user hits "interrupt" mid-stream.
          steering.enqueue('no — leave App alone', 'interrupt');
          abortedInTurn1 = req.signal?.aborted === true;
          // The transport rejects, exactly as an aborted `chat()` does (R3-224).
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return textTurn('understood');
      },
    };
    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: noopExec,
      prompt: 'go',
      steering,
      maxTurns: 4,
    });
    // The turn's own signal fired — the same mechanism R3-224 proved stops the
    // upstream generator and the billing with it.
    expect(abortedInTurn1).toBe(true);
    expect(turn).toBe(2); // the run CONTINUED
    expect(textOf(transcript)).toContain('I will edit App'); // what it had said is kept
    expect(textOf(transcript)).toContain('no — leave App alone');
    expect(textOf(transcript)).toContain('understood');
  });

  it('records the cut-short turn even when nothing had streamed yet', async () => {
    const steering = new SteerController();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        if (turn === 1) {
          steering.enqueue('actually, do X', 'interrupt');
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return textTurn('ok');
      },
    };
    const transcript = await runAgent({ client, tools: TOOLS, execute: noopExec, prompt: 'go', steering, maxTurns: 4 });
    expect(textOf(transcript)).toContain(INTERRUPTED_TURN_TEXT);
    // Roles still alternate — no two `user` messages back to back.
    for (let i = 1; i < transcript.length; i++) {
      expect(transcript[i].role === transcript[i - 1].role && transcript[i].role === 'user').toBe(false);
    }
  });

  it('reports the steer to the UI, saying whether it interrupted', async () => {
    const steering = new SteerController();
    const onSteer = vi.fn();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        if (turn === 1) {
          steering.enqueue('change of plan', 'interrupt');
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return textTurn('ok');
      },
    };
    await runAgent({ client, tools: TOOLS, execute: noopExec, prompt: 'go', steering, maxTurns: 4, events: { onSteer } });
    expect(onSteer).toHaveBeenCalledWith({
      messages: [expect.objectContaining({ text: 'change of plan', mode: 'interrupt' })],
      interrupted: true,
    });
  });
});

describe('exit 3 — stop still ENDS the run, and is distinguishable from steer', () => {
  it('stop ends the run even with a steer queued', async () => {
    const steering = new SteerController();
    const stop = new AbortController();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        steering.enqueue('keep going');
        stop.abort();
        return textTurn('partway');
      },
    };
    const transcript = await runAgent({
      client,
      tools: TOOLS,
      execute: noopExec,
      prompt: 'go',
      steering,
      signal: stop.signal,
      maxTurns: 5,
    });
    expect(turn).toBe(1); // the run ENDED — a queued steer does not resurrect it
    expect(textOf(transcript)).not.toContain('keep going');
  });

  it('the two verbs read differently in the transcript', async () => {
    const q = steerWireText({ id: 'a', text: 'do X', mode: 'queue' });
    const i = steerWireText({ id: 'b', text: 'do Y', mode: 'interrupt' });
    expect(q.startsWith(STEER_MARKER)).toBe(true);
    expect(i.startsWith(STEER_INTERRUPT_MARKER)).toBe(true);
    expect(parseSteer(q)).toEqual({ mode: 'queue', text: 'do X' });
    expect(parseSteer(i)).toEqual({ mode: 'interrupt', text: 'do Y' });
    expect(parseSteer('an ordinary user message')).toBeNull();
  });
});

describe('exit 4 — a steered conversation replays in the right order', () => {
  it('renders steer + interruption as their own rows, never as a user turn', async () => {
    const steering = new SteerController();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        if (turn === 1) {
          steering.enqueue('use a table instead', 'interrupt');
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        if (turn === 2) {
          steering.enqueue('and sort it');
          return callTurn('t1', { path: 'a' });
        }
        return textTurn('done');
      },
    };
    const transcript = await runAgent({ client, tools: TOOLS, execute: noopExec, prompt: 'build a list', steering, maxTurns: 6 });

    const kinds = messagesToLog(transcript).map((e) => (e.kind === 'steer' ? `steer:${e.mode}` : e.kind));
    expect(kinds).toEqual([
      'user', // the kickoff prompt
      'interrupted', // the turn the user cut short
      'steer:interrupt', // …and the correction that cut it
      'tool',
      'result',
      'steer:queue', // the follow-up, applied at the boundary
      'text',
    ]);
    // The steer text is preserved verbatim and is NOT shown as something typed at
    // the start of the run.
    const steerRows = messagesToLog(transcript).filter((e) => e.kind === 'steer');
    expect(steerRows.map((e) => (e as { text: string }).text)).toEqual(['use a table instead', 'and sort it']);
  });
});

describe('exit 5 — a steer during tool execution cannot corrupt the sequence', () => {
  it('every tool_use still gets its tool_result, and the steer lands after the batch', async () => {
    const steering = new SteerController();
    let turn = 0;
    const client: ModelClient = {
      async createMessage() {
        turn++;
        if (turn === 1) {
          return {
            stopReason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'a', name: 'write_file', input: { path: '1' } },
              { type: 'tool_use', id: 'b', name: 'write_file', input: { path: '2' } },
              { type: 'tool_use', id: 'c', name: 'write_file', input: { path: '3' } },
            ],
          };
        }
        return textTurn('done');
      },
    };
    let calls = 0;
    const execute: ToolExecutor = async () => {
      calls++;
      // The user interrupts in the middle of the batch — the worst moment.
      if (calls === 2) steering.enqueue('stop writing files!', 'interrupt');
      return { content: 'wrote' };
    };
    const transcript = await runAgent({ client, tools: TOOLS, execute, prompt: 'go', steering, maxTurns: 5 });

    // All three tools ran to completion — an interrupt never severs a batch.
    expect(calls).toBe(3);
    const uses = transcript.flatMap((m) => m.content).filter((b) => b.type === 'tool_use');
    const results = transcript.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(uses).toHaveLength(3);
    expect(results).toHaveLength(3);
    expect(results.map((r) => (r as { tool_use_id: string }).tool_use_id).sort()).toEqual(['a', 'b', 'c']);

    // …and the steer landed AFTER the results, at the boundary.
    const flat = messagesToLog(transcript).map((e) => e.kind);
    expect(flat.lastIndexOf('result')).toBeLessThan(flat.indexOf('steer'));
  });

  it('a stale interrupt does not abort the following turn', async () => {
    const steering = new SteerController();
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        turn++;
        if (turn === 1) {
          steering.enqueue('adjust course', 'interrupt');
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        // The turn AFTER the interrupt must start with a live signal, or every
        // subsequent turn would be aborted by a correction already applied.
        expect(req.signal?.aborted).toBe(false);
        return textTurn('ok');
      },
    };
    await runAgent({ client, tools: TOOLS, execute: noopExec, prompt: 'go', steering, maxTurns: 4 });
    expect(turn).toBe(2);
  });
});

describe('a loop given no steering behaves exactly as before', () => {
  it('runs and ends identically', async () => {
    const { client } = scripted([() => textTurn('done')]);
    const transcript = await runAgent({ client, tools: TOOLS, execute: noopExec, prompt: 'go' });
    expect(messagesToLog(transcript).map((e) => e.kind)).toEqual(['user', 'text']);
  });
});
