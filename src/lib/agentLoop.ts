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

/** Optional UI hooks so a panel can render the loop as it runs. */
export interface AgentEvents {
  /** A streamed token slice of the in-flight assistant turn (live preview). */
  onAssistantDelta?(text: string): void;
  /** The complete assistant text for a turn, once the turn is in. */
  onAssistantText?(text: string): void;
  onToolUse?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: { content: string; isError?: boolean }): void;
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
  events?: AgentEvents;
}

const textOf = (blocks: { type: string; text?: string }[]): string =>
  blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * Drive the agent loop to completion. Returns the full message transcript
 * (including the kickoff user turn). Stops when the model returns without tool
 * calls (or a terminal stop reason), or when `maxTurns` is reached.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { client, tools, execute, system, prompt, events } = opts;
  const maxTurns = opts.maxTurns ?? 12;

  const messages: ChatMessage[] = [
    ...(opts.history ?? []),
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

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
    // No tool calls → the model is done (end_turn / refusal / max_tokens).
    if (toolUses.length === 0) break;

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
