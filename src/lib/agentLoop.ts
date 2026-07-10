// Provider-agnostic agentic tool-use loop (LLM_AND_AGENTS_SPEC §3.3). The loop is
// the heart of the in-browser coding agent: send the conversation + tool list to a
// ModelClient, execute any tool calls the model emits, append the results, and
// repeat until the model stops, a spend budget is hit, or a large safety-stop is
// reached. The ModelClient seam keeps the loop independent of any one provider
// (host `chat()` impl: chatModelClient.ts).
//
// Confinement (G12/T24) is NOT enforced here — it falls out of the capability
// model: the `tools` handed to the model ARE the app's grant-filtered §5.5
// catalog (agentTools.ts), and `execute` routes through the host's gated
// `invoke()`, so an off-catalog/hallucinated tool returns `forbidden` at the host.
//
// R3-220 (AHG-1) adds the machinery that lets the loop run LONG enough to build a
// real app: token accounting (from the provider `usage` delta), automatic context
// COMPACTION when the window fills, a truncated-tool-call guard, and a spend budget
// replacing the old fixed 12-turn cap. All of it is inert unless a `contextWindow`
// is supplied, so a caller that passes none behaves exactly as before.

import type { AgentTool } from './agentTools';

export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Role = 'user' | 'assistant';
export interface ChatMessage {
  role: Role;
  content: ContentBlock[];
}

/** Provider-reported token counts for one turn (R3-220). `inputTokens` is the size
 *  of everything the provider processed this turn; `outputTokens` is what it
 *  generated. Absent when the provider emits no `usage` delta. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One model turn: the assistant's emitted blocks + why it stopped (+ usage). */
export interface ModelResponse {
  content: (TextBlock | ToolUseBlock)[];
  /** Anthropic stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | … */
  stopReason: string;
  /** Provider token counts for this turn, when reported (R3-220 accounting). */
  usage?: TokenUsage;
}

/** The provider seam — one model turn. Implemented by `chatModelClient.ts` over
 *  the host `chat()` slot; faked in tests. When the client streams, it calls
 *  `onTextDelta` with each token slice as it arrives (the assembled turn is still
 *  returned whole); a non-streaming client simply never calls it. */
export interface ModelClient {
  createMessage(req: {
    system?: string;
    messages: ChatMessage[];
    tools: AgentTool[];
    /** Called with incremental assistant-text slices during a streamed turn. */
    onTextDelta?: (text: string) => void;
  }): Promise<ModelResponse>;
}

/** Executes one tool call, returning a string result (and whether it errored —
 *  a `forbidden`/failed call comes back as `is_error` so the model can adapt). */
export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

/** Why a no-tool-call turn looked like a stall rather than a genuine finish. */
export type StallReason = 'empty' | 'announced-no-call';

/** Optional UI hooks so a panel can render the loop as it runs. */
export interface AgentEvents {
  /** A streamed token slice of the in-flight assistant turn (live preview). */
  onAssistantDelta?(text: string): void;
  /** The complete assistant text for a turn, once the turn is in. */
  onAssistantText?(text: string): void;
  onToolUse?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: { content: string; isError?: boolean }): void;
  /** Fired when the loop nudges a STALLED turn (the model ended without a tool
   *  call despite empty or "I'll do X" intent text) back into action, so a panel
   *  can show "nudging the model to continue" rather than a silent stall. */
  onNudge?(reason: StallReason): void;
  /** Fired after every turn with the running context size + window (R3-220
   *  loop-observability). `contextTokens` is provider-reported when available, else
   *  a char/4 estimate. */
  onUsage?(usage: { contextTokens: number; window?: number; spentTokens: number }): void;
  /** Fired when the loop compacts the transcript to stay under the context window;
   *  `summarizedCount` is how many older messages were folded into the summary. */
  onCompact?(info: { summarizedCount: number }): void;
  /** Fired when the loop stops because the token/spend budget was exhausted. */
  onBudgetStop?(info: { spentTokens: number; tokenBudget: number }): void;
  /** Fired when a turn was truncated (`max_tokens`) while emitting tool calls, so
   *  the partial calls were failed-and-re-prompted rather than executed (R3-220 F3). */
  onTruncatedToolCall?(): void;
}

export interface RunAgentOptions {
  client: ModelClient;
  tools: AgentTool[];
  execute: ToolExecutor;
  system?: string;
  /** Prior turns of this conversation, replayed before the new prompt so a
   *  follow-up has context (the conversation stage seeds this from the store). */
  history?: ChatMessage[];
  /** The user's instruction that kicks off the loop. */
  prompt: string;
  /** Large safety-stop on model turns (default 100). No longer the primary bound —
   *  a long task is bounded by `tokenBudget` + compaction; this just backstops a
   *  pathological loop the budget/compaction somehow miss. */
  maxTurns?: number;
  /** Max consecutive "you announced work but emitted no tool call" nudges before
   *  the loop gives up (default 1). GLM-over-OpenRouter intermittently ends a turn
   *  with future-tense intent ("I'll read the files…") or an EMPTY turn right after
   *  a tool error — no tool call, a silent stall (tutorial findings §2). One nudge
   *  recovers most of these; the cap keeps a genuinely-finished model (which answers
   *  the nudge with another call-free turn) from looping, and the budget resets on
   *  any turn that DID call a tool, so a long task's later stall is still covered.
   *  Set 0 to disable the backstop. */
  maxNudges?: number;
  // ---- R3-220 accounting / compaction (all inert unless `contextWindow` is set) ----
  /** The resolved provider's context window (`describeChat().features.maxContextTokens`).
   *  Compaction is disabled when this is absent/0 — the loop then behaves as before. */
  contextWindow?: number;
  /** Headroom left below the window before compacting (default: 25% of the window). */
  reserveTokens?: number;
  /** Recent messages kept verbatim across a compaction (default 8). */
  keepRecentTurns?: number;
  /** Cumulative token budget (input+output across turns). When exceeded the loop
   *  stops — the runaway-cost guard that replaces the raw 12-turn cap. Off when unset. */
  tokenBudget?: number;
  /** Max consecutive truncated-tool-call re-prompts before giving up (default 2). */
  maxTruncationRetries?: number;
  events?: AgentEvents;
}

const textOf = (blocks: { type: string; text?: string }[]): string =>
  blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

// Terminal stops we must NOT nudge past. Only `max_tokens` survives the SDK→loop
// mapping distinctly (chatModelClient `mapStop`: 'length'→'max_tokens', while
// 'end'/'filtered'→'end_turn' and 'tool'→'tool_use'); a truncated turn is a
// token-budget problem a nudge can't fix. An empty give-up after a tool error
// arrives as 'end_turn', so it stays nudgeable.
const TERMINAL_STOPS = new Set(['max_tokens', 'refusal']);

// Future-tense intent to ACT ("I'll read…", "let me create…", "next I'll edit…").
const INTENT_RE =
  /\b(i'?ll|i will|i'?m going to|going to|let me|let's|now,? i(?:'?ll| will)?|next,? i(?:'?ll| will)?)\b[\s\S]{0,80}?\b(read|write|edit|creat|add|updat|modif|regist|check|look|call|run|search|grep|list|open|fetch|inspect|review|explor|implement|fix|appl)/i;
// A wrap-up marker → treat the turn as a genuine finish, never nudge.
const DONE_RE =
  /\b(done|complete|finished|all set|no (?:further|more) (?:changes|steps)|i(?:'| ha)ve (?:creat|add|updat|made|written|regist|edit|implement|fix|appli)|here'?s (?:a |the )?summ|to summ|in summ)/i;

/**
 * Classify a NO-tool-call turn as a stall (nudge-worthy) vs a genuine finish.
 * GLM-over-OpenRouter intermittently (a) writes "I'll read the files…" then ends
 * with no call, or (b) returns an EMPTY turn after a tool error — both silent
 * give-ups (tutorial findings §2). Conservative on purpose: a real wrap-up (a
 * summary, "Done", "I've created…") returns null so the loop never nudges a
 * finished agent. Empty text is always a stall (there is nothing a finished agent
 * would say with zero words).
 */
export function detectStall(text: string): StallReason | null {
  const t = text.trim();
  if (!t) return 'empty';
  if (DONE_RE.test(t)) return null;
  if (INTENT_RE.test(t)) return 'announced-no-call';
  return null;
}

// The single follow-up we inject to break a stall. Directive, short, and honest
// about the two outcomes so a genuinely-finished model just confirms and stops
// (→ another call-free turn, which the nudge cap then lets terminate). Exported so
// the transcript renderer can recognise the injected turn and show it as a "nudge"
// row (not a user message) when a persisted conversation is replayed.
export const NUDGE_TEXT =
  "You ended your turn without calling a tool. If the task is already complete, say so plainly in one line and stop. Otherwise don't just describe the next step — emit the tool call now.";

// ---- R3-220 token accounting + compaction ----------------------------------------

/** Rough token estimate (~4 chars/token) over a message array, used only when the
 *  provider reports no `usage` delta. Conservative by design (over- not under-counts
 *  by treating structured blocks as their JSON length). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length;
      else if (b.type === 'tool_result') chars += b.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Should the loop compact now? True once the running context passes
 *  `window − reserveTokens`. Disabled (false) when there is no window. */
export function shouldCompact(contextTokens: number, window: number | undefined, reserveTokens: number): boolean {
  if (!window || window <= 0) return false;
  return contextTokens > window - reserveTokens;
}

/** Prefix marking a `user` message as a compaction summary (not a real user turn),
 *  so the transcript renderer shows a "compacted N turns" affordance on replay. */
export const COMPACTION_MARKER = '␟[compacted-context]\n';

const SUMMARY_SYSTEM =
  'You are compacting a coding-agent transcript to fit the context window. Produce a ' +
  'DENSE structured summary under these exact headings: Goal / Constraints / Progress / ' +
  'Decisions / Next Steps / Critical Context. PRESERVE VERBATIM every file path, symbol/' +
  'identifier, and error string that later steps will need — do not paraphrase them. Be ' +
  'terse everywhere else. Output only the summary.';
const SUMMARY_INSTRUCTION =
  'Summarize everything above into the structured block. Keep exact paths, symbols, and ' +
  'error strings verbatim so work can continue from the summary alone.';

/** Compact `messages` by folding the older head into a structured summary and keeping
 *  a verbatim recent tail. The tail is snapped to start at an `assistant` message so a
 *  `tool_use`/`tool_result` pair is never split (which would malform the next request).
 *  The taint tier is NOT modelled on messages (it is run-scoped host state, R-ASG-2):
 *  this is a pure content transform over the SAME session — it starts no new external
 *  read — so it cannot launder taint (F6). Returns the original array unchanged when
 *  there is nothing safe to summarize. */
export async function compactTranscript(
  messages: ChatMessage[],
  client: ModelClient,
  keepRecentTurns: number,
): Promise<{ messages: ChatMessage[]; summarizedCount: number }> {
  if (messages.length <= keepRecentTurns + 1) return { messages, summarizedCount: 0 };

  // Snap the tail boundary to an assistant message so tool_use/tool_result pairs stay
  // together and the summary (a `user` turn) is followed by an `assistant` turn.
  // Prefer the first assistant at/after the keep-recent boundary; fall back to the
  // last assistant in the transcript so the tail is always well-formed.
  const boundary = Math.max(1, messages.length - keepRecentTurns);
  let tailStart = -1;
  for (let i = boundary; i < messages.length; i++) {
    if (messages[i].role === 'assistant') { tailStart = i; break; }
  }
  if (tailStart === -1) {
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === 'assistant') { tailStart = i; break; }
    }
  }
  if (tailStart <= 0) return { messages, summarizedCount: 0 };

  const head = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);

  // Ask the model to summarize the head. Append the instruction to the final head
  // message when it is a `user` turn (avoids introducing consecutive user turns).
  const reqMessages: ChatMessage[] = head.map((m) => ({ role: m.role, content: [...m.content] }));
  const lastMsg = reqMessages[reqMessages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    lastMsg.content = [...lastMsg.content, { type: 'text', text: SUMMARY_INSTRUCTION }];
  } else {
    reqMessages.push({ role: 'user', content: [{ type: 'text', text: SUMMARY_INSTRUCTION }] });
  }

  let summaryText = '(summary unavailable)';
  try {
    const res = await client.createMessage({ system: SUMMARY_SYSTEM, messages: reqMessages, tools: [] });
    summaryText = textOf(res.content).trim() || summaryText;
  } catch {
    // Summarization itself failed — keep the original transcript (caller will retry
    // or hit the safety-stop). Better a longer context than a lost transcript.
    return { messages, summarizedCount: 0 };
  }

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_MARKER + summaryText }],
  };
  return { messages: [summaryMsg, ...tail], summarizedCount: head.length };
}

/** Does this thrown error look like a hard context-window overflow? Used to trigger
 *  recover-then-retry compaction (F3/exit-c) rather than a dead loop. */
export function isContextOverflow(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
  const code = String((e as { code?: unknown })?.code ?? '').toLowerCase();
  return (
    code.includes('context_length') ||
    code.includes('context-length') ||
    /context (?:length|window)|maximum context|too many tokens|prompt is too long|reduce the length/.test(msg)
  );
}

// The user turn injected when a truncated (`max_tokens`) turn emitted tool calls: we
// fail the partial calls rather than execute them (F3), and tell the model to retry.
const TRUNCATED_RETRY_TEXT =
  'That turn was cut off at the token limit mid tool-call, so the call was NOT executed. ' +
  'Emit a smaller step: fewer/shorter tool calls, or a smaller file write.';

/**
 * Drive the agent loop to completion. Returns the full message transcript
 * (including the kickoff user turn). Stops when the model returns without tool
 * calls (or a terminal stop reason), when the token budget is exhausted, or when
 * `maxTurns` (a large safety-stop) is reached. With a `contextWindow` set, the loop
 * accounts tokens and compacts automatically so it can run long.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { client, tools, execute, system, prompt, events } = opts;
  const maxTurns = opts.maxTurns ?? 100;
  const maxNudges = opts.maxNudges ?? 1;
  const maxTruncationRetries = opts.maxTruncationRetries ?? 2;
  const window = opts.contextWindow;
  const reserveTokens = opts.reserveTokens ?? (window ? Math.floor(window * 0.25) : 0);
  const keepRecentTurns = opts.keepRecentTurns ?? 8;

  let messages: ChatMessage[] = [
    ...(opts.history ?? []),
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

  // Consecutive-stall counter: how many times in a row we've nudged a no-tool-call
  // turn. Reset to 0 by any turn that DOES call a tool, so the budget is per stall
  // *episode*, not per run.
  let nudges = 0;
  let truncationRetries = 0;
  // Running context size (provider-reported when available) + cumulative spend.
  let contextTokens = 0;
  let spentTokens = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Compact BEFORE the next request when the running context is near the window.
    if (shouldCompact(contextTokens, window, reserveTokens)) {
      const { messages: compacted, summarizedCount } = await compactTranscript(
        messages,
        client,
        keepRecentTurns,
      );
      if (summarizedCount > 0) {
        messages = compacted;
        contextTokens = estimateTokens(messages);
        events?.onCompact?.({ summarizedCount });
      }
    }

    const sendTurn = () =>
      client.createMessage({ system, messages, tools, onTextDelta: events?.onAssistantDelta });
    let res: ModelResponse;
    try {
      res = await sendTurn();
    } catch (e) {
      // Recover-then-retry on a hard context-overflow (exit-c): compact once and
      // re-send. If there is nothing to compact, or the retry also overflows, the
      // error propagates to the caller — a bounded recovery, never a dead loop.
      if (!isContextOverflow(e)) throw e;
      const { messages: compacted, summarizedCount } = await compactTranscript(messages, client, keepRecentTurns);
      if (summarizedCount === 0) throw e;
      messages = compacted;
      contextTokens = estimateTokens(messages);
      events?.onCompact?.({ summarizedCount });
      res = await sendTurn();
    }

    // Token accounting (R3-220): prefer the provider `usage`, else estimate. `turnCost`
    // is what this turn billed (input + output); `contextTokens` is the current window
    // occupancy (drives compaction); `spentTokens` is cumulative run spend (input is
    // re-billed every turn, so summing turnCost is the true cost signal).
    const turnCost = res.usage
      ? res.usage.inputTokens + res.usage.outputTokens
      : estimateTokens(messages) + Math.ceil(textOf(res.content).length / 4);
    contextTokens = turnCost;
    spentTokens += turnCost;
    events?.onUsage?.({ contextTokens, window, spentTokens });

    const assistantText = textOf(res.content);
    if (assistantText) events?.onAssistantText?.(assistantText);
    messages.push({ role: 'assistant', content: res.content });

    const toolUses = res.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    // Truncated-tool-call guard (F3): a `max_tokens` turn that emitted tool calls
    // was cut off mid-call, so its args may be partial. Do NOT execute them — fail
    // each with an error tool_result (keeps the conversation well-formed) and
    // re-prompt for a smaller step, bounded by maxTruncationRetries.
    if (res.stopReason === 'max_tokens' && toolUses.length > 0) {
      events?.onTruncatedToolCall?.();
      const failed: ContentBlock[] = toolUses.map((c) => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: 'tool call truncated by the token limit — not executed',
        is_error: true,
      }));
      failed.push({ type: 'text', text: TRUNCATED_RETRY_TEXT });
      messages.push({ role: 'user', content: failed });
      if (++truncationRetries > maxTruncationRetries) break;
      continue;
    }
    truncationRetries = 0;

    if (toolUses.length === 0) {
      // No tool calls. Usually the model is genuinely done — but GLM/OpenRouter
      // intermittently ends with "I'll read the files…" or an empty turn after a
      // tool error and no call (findings §2). Nudge such a STALL back into action
      // once (per episode), respecting terminal stops and a real wrap-up.
      const stall = TERMINAL_STOPS.has(res.stopReason) ? null : detectStall(assistantText);
      if (stall && nudges < maxNudges) {
        nudges++;
        events?.onNudge?.(stall);
        messages.push({ role: 'user', content: [{ type: 'text', text: NUDGE_TEXT }] });
        continue;
      }
      break;
    }

    nudges = 0; // a productive turn clears the stall budget

    const results: ToolResultBlock[] = [];
    for (const call of toolUses) {
      events?.onToolUse?.(call.name, call.input);
      let outcome: { content: string; isError?: boolean };
      try {
        outcome = await execute(call.name, call.input);
      } catch (e) {
        // A thrown executor error (e.g. host `forbidden`) becomes an error
        // tool_result so the model sees the gate's verdict and can adapt.
        const code = (e as { code?: string })?.code;
        const msg = (e as Error)?.message ?? String(e);
        outcome = { content: code ? `${code}: ${msg}` : msg, isError: true };
      }
      events?.onToolResult?.(call.name, outcome);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    messages.push({ role: 'user', content: results });

    // Runaway-cost guard: stop once cumulative spend passes the budget (the token/
    // spend bound that replaces the old raw turn cap). Compaction keeps a single
    // request small; this bounds the whole run.
    if (opts.tokenBudget && spentTokens >= opts.tokenBudget) {
      events?.onBudgetStop?.({ spentTokens, tokenBudget: opts.tokenBudget });
      break;
    }
  }

  return messages;
}
