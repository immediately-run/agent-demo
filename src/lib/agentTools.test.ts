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
    // No advertised schema → permissive fallback (host still validates + gates).
    expect(tools[0].input_schema.additionalProperties).toBe(true);
  });

  it("uses a method's advertised paramsSchema as the tool input_schema (R3-75)", () => {
    // The fix for the nested-param marshalling gap: a self-describing method carries
    // its JSON Schema, so the model emits a real array instead of guessing.
    const filesSchema = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    };
    const withSchema: ApiMethod[] = [
      { name: 'authoring:typecheck', capability: 'authoring:run', paramsSchema: filesSchema },
    ];
    const [tool] = catalogToTools(withSchema);
    expect(tool.name).toBe('authoring__typecheck');
    expect(tool.input_schema).toEqual(filesSchema); // advertised schema wins
    expect((tool.input_schema.properties as { files?: { type?: string } }).files?.type).toBe('array');
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

// R3-75 Phase 4 confinement invariant (T24/G12): the authoring tools
// (authoring:typecheck|lint|format, gated by `authoring:run`) reach the model
// through the SAME catalog path — no special wiring — so the tool list equals the
// GRANTED catalog exactly. When the host grants `authoring:run` they appear; when
// it doesn't (they never enter the grant-filtered catalog) they are absent from
// the tool list AND a forced call returns `forbidden` without invoking the host.
describe('authoring tools ride the catalog path (T24/G12)', () => {
  const AUTHORING: ApiMethod[] = [
    { name: 'authoring:typecheck', capability: 'authoring:run' },
    { name: 'authoring:lint', capability: 'authoring:run' },
    { name: 'authoring:format', capability: 'authoring:run' },
  ];

  it('surfaces the three authoring tools when the catalog carries authoring:run', () => {
    const names = catalogToTools(AUTHORING).map((t) => t.name);
    expect(names).toEqual(['authoring__typecheck', 'authoring__lint', 'authoring__format']);
  });

  it('the tool list is exactly the granted catalog — no authoring tool the gate would not admit', () => {
    // Ungranted catalog: authoring:run absent → the three methods never appear.
    const ungranted: ApiMethod[] = [{ name: 'spaces:share', capability: 'spaces:admin' }];
    const names = catalogToTools(ungranted).map((t) => t.name);
    expect(names).not.toContain('authoring__typecheck');
    expect(names).not.toContain('authoring__lint');
    expect(names).not.toContain('authoring__format');
  });

  it('routes a granted authoring call through the host gated invoke()', async () => {
    invoke.mockResolvedValue({ diagnostics: [] });
    const exec = createCatalogExecutor(AUTHORING);
    const res = await exec('authoring__typecheck', { files: ['/src/App.tsx'] });
    expect(invoke).toHaveBeenCalledWith('authoring:typecheck', { files: ['/src/App.tsx'] });
    expect(res).toEqual({ content: '{"diagnostics":[]}' });
  });

  it('an ungranted authoring call is forbidden WITHOUT touching the host (G12)', async () => {
    const exec = createCatalogExecutor([{ name: 'spaces:share', capability: 'spaces:admin' }]);
    const res = await exec('authoring__format', { source: 'x', parser: 'typescript' });
    expect(invoke).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content).toContain('forbidden');
  });
});
