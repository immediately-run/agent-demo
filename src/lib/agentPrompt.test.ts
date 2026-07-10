import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, todayIso, type PromptTool } from './agentPrompt';

const fsTools: PromptTool[] = [
  { name: 'read_file', description: 'Read a UTF-8 text file from the workspace.' },
  { name: 'write_file', description: 'Create or overwrite a whole workspace file.' },
];
const authoringTools: PromptTool[] = [
  { name: 'authoring__typecheck', description: 'Type-check the given files.' },
  { name: 'authoring__lint', description: 'Lint the given files.' },
];

describe('buildSystemPrompt (R3-221 — generate from live toolset)', () => {
  it('(a) advertises exactly the tools given — no authoring__* when not granted', () => {
    const prompt = buildSystemPrompt({ tools: fsTools });
    expect(prompt).toContain('read_file:');
    expect(prompt).toContain('write_file:');
    expect(prompt).not.toContain('authoring__'); // grant absent → not named
  });

  it('(a) advertises authoring__* when those tools ARE in the toolset', () => {
    const prompt = buildSystemPrompt({ tools: [...fsTools, ...authoringTools] });
    expect(prompt).toContain('authoring__typecheck:');
    expect(prompt).toContain('authoring__lint:');
  });

  it('(b) always carries the host-authored platform hard rules (the "works on IR" win)', () => {
    const prompt = buildSystemPrompt({ tools: fsTools });
    expect(prompt).toContain('src/App.tsx'); // App.tsx is the entry / default export
    expect(prompt).toContain('import.meta'); // "NEVER use import.meta"
    expect(prompt.toLowerCase()).toContain('import "./index.css"'.toLowerCase()); // CSS from App.tsx
    expect(prompt.toLowerCase()).toContain('one react component per file'); // Fast Refresh
  });

  it('(c) grounds the environment: date + workspace root + route when present', () => {
    const prompt = buildSystemPrompt({
      tools: fsTools,
      today: '2026-07-10',
      workspaceRoot: '/app',
      route: '/src/App.tsx',
    });
    expect(prompt).toContain('Date: 2026-07-10');
    expect(prompt).toContain('Workspace root: /app');
    expect(prompt).toContain('Current route: /src/App.tsx');
  });

  it('(d) omitting env fields is graceful — workflow guidance stays intact', () => {
    const prompt = buildSystemPrompt({ tools: fsTools });
    expect(prompt).not.toContain('Date:');
    expect(prompt).not.toContain('Workspace root:');
    expect(prompt).toContain('Explore before you edit'); // workflow guidance present
    expect(prompt).toContain('forbidden'); // forbidden-handling guidance present
    expect(prompt).toContain('offset'); // read-until-complete guidance present
  });

  it('is deterministic (pure) for the same context', () => {
    const ctx = { tools: fsTools, today: '2026-07-10', workspaceRoot: '/app' };
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt(ctx));
  });

  it('handles an empty toolset without throwing', () => {
    const prompt = buildSystemPrompt({ tools: [] });
    expect(prompt).toContain('(no tools available)');
  });

  it('todayIso returns a YYYY-MM-DD string', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
