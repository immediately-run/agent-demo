// Render a stored transcript (ChatMessage[]) into flat log entries for the UI
// (agent-conversations plan). Shared by the live loop and by reloading a persisted
// conversation, so a resumed conversation looks exactly like one just run.
//
// Types + a pure function only (no component) — safe to import anywhere.

import { NUDGE_TEXT, COMPACTION_MARKER, type ChatMessage } from './agentLoop';
import { parseSteer, INTERRUPTED_TURN_TEXT, type SteerMode } from './steering';

export type LogEntry =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'result'; name: string; content: string; isError?: boolean }
  | { kind: 'error'; text: string }
  // A host-injected stall backstop (§2): the loop nudged a no-tool-call turn. Its
  // wire form is a `user` text message, so it must be classified here (not shown as
  // something the user typed) — both live (onNudge) and on replay.
  | { kind: 'nudge' }
  // A context compaction (R3-220): the loop folded older turns into a summary. Its
  // wire form is a `user` message prefixed with COMPACTION_MARKER, so it must be
  // classified here (a "compacted N turns" affordance), not shown as a user turn.
  | { kind: 'compaction'; summary: string }
  // A mid-run STEER (R3-333): the user corrected the agent without restarting. Its
  // wire form is a `user` message prefixed with a steer marker, so like `nudge` and
  // `compaction` it must be classified here — a replayed conversation has to show
  // the interruption where it happened rather than as an ordinary user turn, and
  // `mode` is what keeps steer distinguishable from stop on replay (exit 3/4).
  | { kind: 'steer'; mode: SteerMode; text: string }
  // The assistant turn an `interrupt` steer cut short.
  | { kind: 'interrupted' };

/** Flatten a transcript into log entries. Tool results are correlated back to the
 *  tool name via the assistant `tool_use` id that produced them. */
export function messagesToLog(messages: ChatMessage[]): LogEntry[] {
  const nameById = new Map<string, string>();
  const out: LogEntry[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        const steer = msg.role === 'user' ? parseSteer(block.text) : null;
        if (msg.role === 'user' && block.text === NUDGE_TEXT) out.push({ kind: 'nudge' });
        else if (msg.role === 'user' && block.text.startsWith(COMPACTION_MARKER))
          out.push({ kind: 'compaction', summary: block.text.slice(COMPACTION_MARKER.length) });
        else if (steer) out.push({ kind: 'steer', mode: steer.mode, text: steer.text });
        else if (msg.role === 'assistant' && block.text === INTERRUPTED_TURN_TEXT)
          out.push({ kind: 'interrupted' });
        else if (block.text.trim()) out.push({ kind: msg.role === 'user' ? 'user' : 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        nameById.set(block.id, block.name);
        out.push({ kind: 'tool', name: block.name, input: block.input });
      } else if (block.type === 'tool_result') {
        out.push({
          kind: 'result',
          name: nameById.get(block.tool_use_id) ?? 'tool',
          content: block.content,
          isError: block.is_error,
        });
      }
    }
  }
  return out;
}
