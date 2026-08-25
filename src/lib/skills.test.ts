// R3-331 — host-trusted skills. The security-shaped tests here are the point of the
// file: a skill is trusted because the HOST wrote it, so the tests prove there is no
// path by which an app introduces, names, or shadows one.

import { describe, it, expect, vi } from 'vitest';
// The module's own source as bytes — this suite ASSERTS on it (see 'exit 3'), so it
// must be the real file rather than a reviewer's memory of it.
import skillsSource from './skills.ts?raw';

// `toolset.ts` → `agentTools.ts` imports the SDK for `invoke()`; stub it the way the
// other suites do so the test runs without the sandbox runtime.
vi.mock('@immediately-run/sdk', () => ({ invoke: vi.fn() }));
import {
  HOST_SKILLS,
  createSkillsToolset,
  selectSkills,
  skillSummaries,
  withSkills,
  type SkillDef,
} from './skills';
import { buildSystemPrompt } from './agentPrompt';
import { mergeToolsets, type Toolset } from './toolset';
import { runAgent, type ModelClient, type ChatMessage } from './agentLoop';

const toolNamesOf = (t: Toolset) => t.tools.map((x) => x.name);

const emptyToolset = (names: string[]): Toolset => ({
  tools: names.map((name) => ({ name, description: `${name} tool`, input_schema: { type: 'object' } })),
  execute: async () => ({ content: 'ok' }),
});

describe('the host registry', () => {
  it('ships the three seed skills with bodies', () => {
    expect(HOST_SKILLS.map((s) => s.name)).toEqual(['sdk', 'design-system', 'editor-first-editing']);
    for (const s of HOST_SKILLS) {
      expect(s.body.length).toBeGreaterThan(200);
      expect(s.description.length).toBeGreaterThan(40);
      expect(s.version).toBeTruthy();
    }
  });

  it('is frozen — nothing at runtime can extend or replace it', () => {
    expect(Object.isFrozen(HOST_SKILLS)).toBe(true);
    expect(() => {
      (HOST_SKILLS as SkillDef[]).push({ name: 'evil', version: '1', description: 'x', body: 'y' });
    }).toThrow();
  });
});

describe('exit 3 — no skill body is ever read from a mount or an app-controlled path', () => {
  it('the skills module imports no filesystem and takes no fs injection', () => {
    // fsTools.ts deliberately DOES import fs; skills.ts must not, and must not accept
    // one either. Read the source rather than trusting the reviewer's memory of it.
    expect(skillsSource).not.toMatch(/from ['"](?:node:)?fs['"]/);
    expect(skillsSource).not.toMatch(/openFs|openAppFs|readFile|readdir|readBlob/);
  });

  it('an app cannot INTRODUCE a skill — an unknown name is simply not found', async () => {
    const { execute } = createSkillsToolset();
    const res = await execute('load_skill', { name: 'app-authored' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no such skill');
    // The refusal lists only host skills, so it cannot leak a path either.
    expect(res.content).not.toContain('/');
  });

  it('an app cannot NAME a path — a traversal-shaped name resolves to nothing', async () => {
    const { execute } = createSkillsToolset();
    for (const name of ['../../etc/passwd', '/app/SKILL.md', './sdk', 'sdk/../sdk']) {
      const res = await execute('load_skill', { name });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('no such skill');
    }
  });

  it('an app cannot SHADOW a host skill — the registry the toolset closes over is fixed', async () => {
    const skills = [...HOST_SKILLS];
    const { execute } = createSkillsToolset(skills);
    // Mutating the array the toolset was built from after the fact changes nothing:
    // the executor resolves against the Map captured at construction.
    skills.push({ name: 'sdk', version: '9', description: 'shadow', body: 'PWNED' });
    skills.unshift({ name: 'design-system', version: '9', description: 'shadow', body: 'PWNED' });
    const sdk = await execute('load_skill', { name: 'sdk' });
    expect(sdk.content).not.toContain('PWNED');
    expect(sdk.content).toContain('@immediately-run/sdk');
    const ds = await execute('load_skill', { name: 'design-system' });
    expect(ds.content).not.toContain('PWNED');
  });

  it('the skills executor answers to `load_skill` and nothing else', async () => {
    const { execute } = createSkillsToolset();
    const res = await execute('read_file', { path: 'src/App.tsx' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('forbidden');
  });
});

describe('exit 1 — descriptions in the prompt, bodies out of it', () => {
  it('the prompt carries every skill description and no skill body', () => {
    const skills = skillSummaries(HOST_SKILLS);
    const prompt = buildSystemPrompt({ tools: [{ name: 'write_file', description: 'write' }], skills });
    for (const s of HOST_SKILLS) {
      expect(prompt).toContain(s.name);
      // The body's distinctive interior must NOT be there.
      expect(prompt).not.toContain(s.body.slice(200, 400));
    }
    expect(prompt).toContain('load_skill');
  });

  it('the base prompt does not grow materially — the section costs a few % of the bodies', () => {
    const tools = [{ name: 'write_file', description: 'write' }];
    const without = buildSystemPrompt({ tools });
    const with_ = buildSystemPrompt({ tools, skills: skillSummaries(HOST_SKILLS) });
    const bodyBytes = HOST_SKILLS.reduce((n, s) => n + s.body.length, 0);
    const added = with_.length - without.length;
    expect(bodyBytes).toBeGreaterThan(20_000); // the bodies really are large…
    expect(added).toBeLessThan(bodyBytes * 0.05); // …and the prompt pays ~3% of that
    expect(added).toBeLessThan(1_000); // absolute guard: a catalog, not a manual
  });

  it('omits the section entirely when no skill is offered', () => {
    const prompt = buildSystemPrompt({ tools: [{ name: 'spaces__share', description: 'share' }] });
    expect(prompt).not.toContain('Available skills');
  });
});

describe('exit 4 — absent when the surrounding grant makes them meaningless', () => {
  it('offers the authoring skills when the run can author', () => {
    const names = selectSkills(['write_file', 'grep']).map((s) => s.name);
    expect(names).toEqual(['sdk', 'design-system', 'editor-first-editing']);
  });

  it('offers NOTHING to a catalog-only run, and `load_skill` is not in the toolset', () => {
    // The live case: ConversationStage falls back to catalog-only when no stage
    // worktree is conferred.
    const base = emptyToolset(['spaces__share', 'contribute']);
    const { toolset, skills } = withSkills(base);
    expect(skills).toEqual([]);
    expect(toolNamesOf(toolset)).not.toContain('load_skill');
    expect(toolNamesOf(toolset)).toEqual(['spaces__share', 'contribute']);
  });

  it('keeps the prompt exactly the live toolset — `load_skill` is described only when present', () => {
    const base = emptyToolset(['write_file', 'edit_file']);
    const { toolset, skills } = withSkills(base);
    expect(toolNamesOf(toolset)).toContain('load_skill');
    const prompt = buildSystemPrompt({ tools: toolset.tools, skills });
    // Every tool named in "Available tools" exists, and load_skill is one of them.
    const listed = prompt
      .split('Available tools:\n')[1]
      .split('\n\n')[0]
      .split('\n')
      .map((l) => l.replace(/^- /, '').split(':')[0]);
    expect(listed.sort()).toEqual(['edit_file', 'load_skill', 'write_file']);
  });
});

describe('exit 2 — a run that needs an SDK export loads the skill and gets the real signature', () => {
  it('drives the loop end to end: load_skill → the body reaches the next request', async () => {
    const base = emptyToolset(['write_file', 'edit_file']);
    const { toolset, skills } = withSkills(base);
    const system = buildSystemPrompt({ tools: toolset.tools, skills, today: '2026-08-25' });

    const seen: ChatMessage[][] = [];
    let turn = 0;
    const client: ModelClient = {
      async createMessage(req) {
        seen.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
        turn++;
        if (turn === 1) {
          // The prompt told it a skill covers the SDK; it pulls the skill first.
          return {
            content: [{ type: 'tool_use', id: 't1', name: 'load_skill', input: { name: 'sdk' } }],
            stopReason: 'tool_use',
          };
        }
        // Second turn: write the import, taken from what the skill actually said.
        const body = JSON.stringify(req.messages);
        const hasRename = body.includes('rename(fromRel: string, toRel: string)');
        return {
          content: [
            {
              type: 'tool_use',
              id: 't2',
              name: 'write_file',
              input: {
                path: 'src/move.ts',
                content: hasRename
                  ? 'import { openFs } from "@immediately-run/sdk";\nexport const mv = (m: never, a: string, b: string) => openFs(m).rename(a, b);\n'
                  : '// guessed\n',
              },
            },
          ],
          stopReason: 'tool_use',
        };
      },
    };

    // The first request must ADVERTISE the skill without carrying its body.
    const transcript = await runAgent({
      client,
      tools: toolset.tools,
      execute: toolset.execute,
      system,
      prompt: 'Move src/a.ts to src/b.ts using the SDK filesystem port.',
      maxTurns: 2,
    });

    expect(JSON.stringify(seen[0])).not.toContain('rename(fromRel');
    // …and the second request DOES, because load_skill put it there.
    expect(JSON.stringify(seen[1])).toContain('rename(fromRel: string, toRel: string)');

    const written = transcript
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_use' && b.name === 'write_file');
    expect(written).toBeDefined();
    // The signature it emitted is the SDK's real one, not a guess.
    const input = (written as { input: Record<string, unknown> }).input;
    expect(String(input.content)).toContain('openFs(m).rename(a, b)');
  });
});

describe('the skill body is delivered as fenced, attributed host text', () => {
  it('wraps the body so the model can tell the skill from the conversation', async () => {
    const { execute } = createSkillsToolset();
    const res = await execute('load_skill', { name: 'design-system' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/^<skill name="design-system" version="1">\n/);
    expect(res.content).toMatch(/\n<\/skill>$/);
    expect(res.content).toContain('--accent-hot');
  });
});

describe('merging', () => {
  it('a skills toolset merges without shadowing an existing tool name', () => {
    const base = emptyToolset(['load_skill']); // pathological: something else claimed it
    const merged = mergeToolsets(base, createSkillsToolset());
    expect(toolNamesOf(merged).filter((n) => n === 'load_skill')).toHaveLength(1);
  });
});
