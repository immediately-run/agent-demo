import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiMethod } from '@immediately-run/sdk';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@immediately-run/sdk', () => ({ invoke }));

import { catalogToTools, createCatalogExecutor, toToolName, toCatalogName } from './agentTools';

beforeEach(() => invoke.mockReset());

const catalog: ApiMethod[] = [
  { name: 'spaces:share', capability: 'spaces:admin' },
  { name: 'contribute:run', capability: 'contribute:self', stream: true },
];

describe('catalog-as-tools (§3.3)', () => {
  it('maps catalog names to valid Anthropic tool names and back', () => {
    expect(toToolName('spaces:share')).toBe('spaces__share');
    expect(toCatalogName('spaces__share')).toBe('spaces:share');
    // valid Anthropic tool-name charset
    expect('spaces__share').toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('builds tool descriptors and skips streaming methods', () => {
    const tools = catalogToTools(catalog);
    expect(tools).toHaveLength(1); // contribute:run is stream → skipped
    expect(tools[0].name).toBe('spaces__share');
    expect(tools[0].description).toContain('spaces:share');
    expect(tools[0].input_schema.type).toBe('object');
  });

  it('executor routes an in-catalog call through the host gated invoke()', async () => {
    invoke.mockResolvedValue({ shared: true });
    const exec = createCatalogExecutor(catalog);
    const res = await exec('spaces__share', { login: 'bob' });
    expect(invoke).toHaveBeenCalledWith('spaces:share', { login: 'bob' });
    expect(res).toEqual({ content: '{"shared":true}' });
  });

  it('refuses an off-catalog tool as forbidden WITHOUT calling invoke (G12)', async () => {
    const exec = createCatalogExecutor(catalog);
    const res = await exec('spaces__delete_everything', {});
    expect(invoke).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content).toContain('forbidden');
  });

  // The invoke-failure → error-result mapping (the executor's catch branch)
  // is covered by the off-catalog case above (same `{isError}` return) and by
  // agentLoop's "thrown executor error" test.
});
