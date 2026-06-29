// A ModelClient (the `agentLoop.ts` provider seam) backed by the platform `llm.chat`
// service — the SDK `chat()` — replacing the per-app `net:fetch` BYOK client
// (`modelClient.ts`). Aligns agent-demo with AGENT_AUTHORING_ARCHITECTURE §3: the
// workbench agent's loop is `read → chat() → write`, and §2/H2 favour `chat()` (the
// user's key injected host-side) over `net:fetch` + secrets.
//
// The provider AND the model are the USER's host-side preference (SP §5.1) — this
// client names neither, so agent-demo no longer hard-codes OpenRouter or a model: it
// inherits whatever the user chose (e.g. OpenRouter + `z-ai/glm-5.2`). The app holds no
// secret/`net:fetch` grant; it needs only the `llm:chat` capability.
import {
  chat,
  type ChatMessage as ChatReqMessage,
  type ChatRequest,
  type ChatDelta,
  type ContentPart,
} from '@immediately-run/sdk';
import type { ChatMessage, ModelClient, TextBlock, ToolUseBlock } from './agentLoop';
import type { AgentTool } from './agentTools';

// The loop's Anthropic-shaped conversation → the SDK's tool-aware ChatRequest. The
// agentic history round-trips: a `tool_use` block becomes a `tool-use` content part, a
// `tool_result` becomes a `tool-result` part (SDK 0.18.1).
function toChatMessages(system: string | undefined, messages: ChatMessage[]): ChatReqMessage[] {
  const out: ChatReqMessage[] = [];
  if (system) out.push({ role: 'system', content: [{ type: 'text', text: system }] });
  for (const m of messages) {
    const content: ContentPart[] = m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool-use', id: b.id, name: b.name, input: b.input };
      return {
        type: 'tool-result',
        toolCallId: b.tool_use_id,
        content: b.content,
        ...(b.is_error ? { isError: true } : {}),
      };
    });
    out.push({ role: m.role, content });
  }
  return out;
}

function toChatTools(tools: AgentTool[]): NonNullable<ChatRequest['tools']> {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

// SDK ChatResult.stopReason ('end'|'length'|'tool'|'filtered') → the loop's
// Anthropic-style stop reason (the loop branches on 'tool_use' to keep iterating).
const mapStop = (s: string): string => (s === 'tool' ? 'tool_use' : s === 'length' ? 'max_tokens' : 'end_turn');

/** A {@link ModelClient} over the host `llm.chat` slot. Streams text deltas (forwarded
 *  to `onTextDelta`) and assembles tool calls; the resolved provider + model are the
 *  user's preference, never named here. */
export function createChatModelClient(): ModelClient {
  return {
    async createMessage(req) {
      const chatReq: ChatRequest = {
        messages: toChatMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: toChatTools(req.tools) } : {}),
        modelHint: 'smart',
      };
      let text = '';
      const toolUses: ToolUseBlock[] = [];
      let stopReason = 'end_turn';
      const gen = chat(chatReq);
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          stopReason = mapStop(step.value.stopReason);
          break;
        }
        const d: ChatDelta = step.value;
        if (d.type === 'text-delta') {
          text += d.text;
          req.onTextDelta?.(d.text);
        } else if (d.type === 'tool-call') {
          toolUses.push({ type: 'tool_use', id: d.id, name: d.name, input: (d.input ?? {}) as Record<string, unknown> });
        }
      }
      const content: (TextBlock | ToolUseBlock)[] = [];
      if (text) content.push({ type: 'text', text });
      content.push(...toolUses);
      return { content, stopReason };
    },
  };
}
