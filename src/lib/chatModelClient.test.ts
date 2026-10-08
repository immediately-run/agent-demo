// createChatModelClient (R3-620): the per-conversation pair rides the chat
// request when the caller has one, and is absent otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@immediately-run/sdk';

const requests: ChatRequest[] = [];

vi.mock('@immediately-run/sdk', () => ({
  chat: vi.fn((req: ChatRequest) => {
    requests.push(req);
    return (async function* () {
      yield { type: 'text-delta', text: 'ok' };
      return { stopReason: 'end' };
    })();
  }),
}));

import { createChatModelClient } from './chatModelClient';

const turn = { system: 's', messages: [], tools: [] };

beforeEach(() => {
  requests.length = 0;
});

describe('createChatModelClient — the model pair (R3-620)', () => {
  it('a chosen pair rides the request, beside the unchanged hint', async () => {
    const pair = { providerId: 'llm.chat.anthropic', model: 'claude-x' };
    const out = await createChatModelClient(pair).createMessage(turn);
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toEqual(pair);
    expect(requests[0].modelHint).toBe('smart');
    expect(out.stopReason).toBe('end_turn');
  });

  it('no pair → the request carries no model field at all', async () => {
    await createChatModelClient().createMessage(turn);
    expect(requests).toHaveLength(1);
    expect('model' in requests[0]).toBe(false);
    expect(requests[0].modelHint).toBe('smart');
  });
});
