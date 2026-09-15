// Transcript repair and attended resume (AGENT_RUN_DURABILITY_SPEC §5, R3-560).
// A replayed transcript is NOT a valid one: a run torn down mid-batch leaves
// `tool_use` blocks with no matching `tool_result` — providers reject the
// sequence outright — and the truncation path pushes the assistant turn BEFORE
// deciding not to execute the calls, so a teardown in that window leaves
// dangling calls that were provably never issued.
//
// One rule for both cases would tell the model a never-issued call was
// "started, outcome unknown", inviting it to go verify or undo a pull request
// that was never opened — exactly the fabricated observation R-ARD-11 forbids.
// B2 is what distinguishes them: an intent entry means the executor started;
// no entry means it provably never did. Writing B2 and then not reading it is
// the defect the two-case rule exists to prevent.
//
// Pure module — no fs, no SDK, no React (the shape of `transcript.ts` and
// `steering.ts`), so `ConversationStage.tsx` stays a thin caller and every rule
// here is testable without a DOM.

import type { ChatMessage, ContentBlock, ToolUseBlock } from './agentLoop';
import type { PendingEffect, ReplayResult } from './conversationStore';

/** The loop's own truncation wording, reused VERBATIM for the never-issued case
 *  rather than inventing a second phrasing for the same fact (R-ARD-11). */
export const NOT_EXECUTED_TEXT = 'tool call truncated by the token limit — not executed';

/** The wording for a call the executor started but whose outcome the journal
 *  does not carry (B2 with no resolving B3). */
export const STARTED_UNKNOWN_TEXT = 'started; outcome unknown — verify before assuming';

export type RepairCase = 'started-unknown' | 'not-executed';

export interface RepairInput {
  messages: ChatMessage[];
  /** B2 intents with no completing B3 — the calls whose executors started. */
  pendingEffects: PendingEffect[];
  /** The journal's last applied entry was a `partial` B1 (replay.trailingPartial). */
  trailingPartial: boolean;
}

export interface RepairResult {
  /** The repaired, provider-valid transcript. */
  messages: ChatMessage[];
  /** What was repaired, in transcript order — one row per dangling call. */
  repairs: { toolUseId: string; case: RepairCase }[];
  /** A trailing half-finished assistant turn was DISCARDED, not completed —
   *  keeping a half-sentence as a finished turn puts words in the model's mouth
   *  it did not finish choosing (R-ARD-11). */
  discardedPartialTurn: boolean;
}

/**
 * Repair a replayed transcript to provider-validity (R-ARD-11). Pure: it takes
 * replayed messages plus the journal's pending B2 records and returns repaired
 * messages — nothing else. Reasoning blocks (signature included) replay intact
 * by construction: repair never touches content except the dangling tail.
 */
export function repairTranscript(input: RepairInput): RepairResult {
  const messages = input.messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const repairs: RepairResult['repairs'] = [];

  // A trailing partial assistant turn is discarded, not completed.
  let discardedPartialTurn = false;
  if (input.trailingPartial) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      messages.pop();
      discardedPartialTurn = true;
    }
  }

  // Dangling tool_use: no matching tool_result anywhere (provider ids are unique
  // per run, so a global match is exact). The two cases key on B2.
  const answered = new Set(
    messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  const startedIds = new Set(input.pendingEffects.map((p) => p.toolUseId));
  const dangling: { id: string; case: RepairCase }[] = [];
  for (const block of messages.flatMap((m) => m.content)) {
    if (block.type !== 'tool_use') continue;
    const use = block as ToolUseBlock;
    if (answered.has(use.id)) continue;
    dangling.push({ id: use.id, case: startedIds.has(use.id) ? 'started-unknown' : 'not-executed' });
  }

  if (dangling.length) {
    const content: ContentBlock[] = dangling.map((d) => ({
      type: 'tool_result' as const,
      tool_use_id: d.id,
      content: d.case === 'started-unknown' ? STARTED_UNKNOWN_TEXT : NOT_EXECUTED_TEXT,
      is_error: true,
    }));
    messages.push({ role: 'user', content });
    for (const d of dangling) repairs.push({ toolUseId: d.id, case: d.case });
  }

  return { messages, repairs, discardedPartialTurn };
}

/**
 * Is this conversation interrupted — a run in flight when the journal last
 * moved? Three facts, all from the journal (never warm module state):
 * a dangling intent, a trailing partial turn, or entries above the fold whose
 * last one is not the final `runEnd` B4. A finished conversation's entries are
 * folded away (depth 0) and is never offered a resume.
 */
export function interrupted(replay: Pick<ReplayResult, 'pendingEffects' | 'trailingPartial' | 'runEnded' | 'journalDepth'>): boolean {
  if (replay.journalDepth === 0) return false;
  return replay.pendingEffects.length > 0 || replay.trailingPartial || !replay.runEnded;
}

/**
 * The divergence note (R-ARD-16): a checkpoint records the workspace it was
 * authoring, and resume detects that the tree moved underneath it — the model
 * must be TOLD, plainly, rather than left to infer it from failing reads.
 * Returns the note as a user message to prepend to the resumed transcript, or
 * null when the workspace is unchanged (or was never stamped).
 */
export function divergenceMessage(stamped: string | undefined, current: string | null | undefined): ChatMessage | null {
  if (stamped === undefined) return null;
  if (current !== undefined && current !== null && stamped === current) return null;
  const to = current ?? 'a different workspace (or none)';
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `This conversation was working on "${stamped}", but the current workspace is ${to}. ` +
          'The files you were editing may have changed or been reset. Verify the current state of ' +
          'anything you remember changing before you continue.',
      },
    ],
  };
}

/**
 * Assemble the messages a resumed run sends: the repaired transcript, with the
 * divergence note (if any) prepended as the next user turn. The note is the
 * FIRST thing the model reads on resume — before it can act on stale memory.
 */
export function resumedMessages(repaired: ChatMessage[], divergence: ChatMessage | null): ChatMessage[] {
  return divergence ? [...repaired, divergence] : [...repaired];
}
