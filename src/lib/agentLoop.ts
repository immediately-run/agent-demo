// Provider-agnostic agentic tool-use loop (LLM_AND_AGENTS_SPEC §3.3). The loop is
// the heart of the in-browser coding agent: send the conversation + tool list to a
// ModelClient, execute any tool calls the model emits, append the results, and
// repeat until the model stops or a turn cap is hit. The ModelClient seam keeps
// the loop independent of any one provider (Claude impl: claudeClient.ts).
//
// Confinement (G12/T24) is NOT enforced here — it falls out of the capability
// model: the `tools` handed to the model ARE the app's grant-filtered §5.5
// catalog (agentTools.ts), and `execute` routes through the host's gated
// `invoke()`, so an off-catalog/hallucinated tool returns `forbidden` at the host.

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

/** One model turn: the assistant's emitted blocks + why it stopped. */
export interface ModelResponse {
  content: (TextBlock | ToolUseBlock)[];
  /** Anthropic stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | … */
  stopReason: string;
}

/** The provider seam — one model turn. Implemented by `claudeClient.ts` over
 *  `hostFetch`/`hostFetchStream`; faked in tests. When the client streams, it
 *  calls `onTextDelta` with each token slice as it arrives (the assembled turn
 *  is still returned whole); a non-streaming client simply never calls it. */
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
  /** Hard cap on model turns (default 12) — bounds runaway loops. */
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

/**
 * Drive the agent loop to completion. Returns the full message transcript
 * (including the kickoff user turn). Stops when the model returns without tool
 * calls (or a terminal stop reason), or when `maxTurns` is reached.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { client, tools, execute, system, prompt, events } = opts;
  const maxTurns = opts.maxTurns ?? 12;
  const maxNudges = opts.maxNudges ?? 1;

  const messages: ChatMessage[] = [
    ...(opts.history ?? []),
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

  // Consecutive-stall counter: how many times in a row we've nudged a no-tool-call
  // turn. Reset to 0 by any turn that DOES call a tool, so the budget is per stall
  // *episode*, not per run.
  let nudges = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.createMessage({
      system,
      messages,
      tools,
      onTextDelta: events?.onAssistantDelta,
    });

    const assistantText = textOf(res.content);
    if (assistantText) events?.onAssistantText?.(assistantText);
    messages.push({ role: 'assistant', content: res.content });

    const toolUses = res.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
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
  }

  return messages;
}
