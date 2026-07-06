import { describe, it, expect, vi } from 'vitest';
import type { Diagnostics } from '@immediately-run/sdk';

// Mock the SDK so importing diagnosticsTools never touches browser globals; tests
// inject their own reader, so the default `getDiagnostics` is only a fallback.
vi.mock('@immediately-run/sdk', () => ({
  getDiagnostics: (): Diagnostics => ({ buildErrors: [], consoleEntries: [], provenance: null }),
}));

import { createDiagnosticsToolset, formatDiagnostics } from './diagnosticsTools';

const EMPTY: Diagnostics = { buildErrors: [], consoleEntries: [], provenance: null };

describe('formatDiagnostics', () => {
  it('renders build errors with path:line — message', () => {
    const out = formatDiagnostics({
      buildErrors: [{ message: 'Cannot find name "foo"', path: '/src/App.tsx', line: 12, column: 3 }],
      consoleEntries: [],
      provenance: null,
    });
    expect(out).toContain('1 build error');
    expect(out).toContain('/src/App.tsx:12:3 — Cannot find name "foo"');
  });

  it('reports a clean compile when there are no build errors', () => {
    expect(formatDiagnostics(EMPTY)).toContain('No build errors');
  });

  it('surfaces console warnings/errors but drops log/info/debug noise', () => {
    const out = formatDiagnostics({
      buildErrors: [],
      consoleEntries: [
        { level: 'log', text: 'chatty', at: 1 },
        { level: 'warn', text: 'deprecated API', at: 2 },
        { level: 'error', text: 'boom', at: 3 },
      ],
      provenance: null,
    });
    expect(out).toContain('2 console warning/error');
    expect(out).toContain('[warn] deprecated API');
    expect(out).toContain('[error] boom');
    expect(out).not.toContain('chatty');
  });
});

describe('createDiagnosticsToolset (§3.3, R3-74)', () => {
  it('offers a single read-only get_diagnostics tool', () => {
    const { tools } = createDiagnosticsToolset({ read: () => EMPTY });
    expect(tools.map((t) => t.name)).toEqual(['get_diagnostics']);
    expect(tools[0].input_schema.additionalProperties).toBe(false);
  });

  it('returns the formatted current snapshot', async () => {
    const snap: Diagnostics = {
      buildErrors: [{ message: 'oops', path: '/src/x.ts', line: 1 }],
      consoleEntries: [],
      provenance: null,
    };
    const { execute } = createDiagnosticsToolset({ read: () => snap });
    const r = await execute('get_diagnostics', {});
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('/src/x.ts:1 — oops');
  });

  it('degrades to an empty snapshot without diagnostics:read (no crash)', async () => {
    // The host answers the empty snapshot when the grant is absent (R3-74).
    const { execute } = createDiagnosticsToolset({ read: () => EMPTY });
    const r = await execute('get_diagnostics', {});
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('No build errors');
  });

  it('refuses a non-diagnostics tool name as forbidden', async () => {
    const { execute } = createDiagnosticsToolset({ read: () => EMPTY });
    const r = await execute('rm_rf', {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('forbidden');
  });

  it('maps a reader throw to an error result rather than throwing', async () => {
    const { execute } = createDiagnosticsToolset({
      read: () => {
        throw new Error('channel gone');
      },
    });
    const r = await execute('get_diagnostics', {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('channel gone');
  });
});
