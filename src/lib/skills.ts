// Host-trusted agent skills (R3-331 / AHG-T2-1): durable, reusable instruction
// blocks the model can pull on demand.
//
// WHY THIS EXISTS. R3-221 moved the agent from a static prompt to a generated one —
// live tool list, environment grounding, and a small host-authored platform-rules
// block. That block is deliberately the *invariants*, not a manual. Everything
// larger and more specific (how to call an SDK export, what the design system's
// tokens are, that an app delegates editing to the platform editor) had no home: it
// either bloated the one fixed block or never reached the model at all.
//
// THE TRUST RULE (LLM_AND_AGENTS_SPEC — skills are HOST-TRUSTED). A skill's text is
// trusted because THE HOST WROTE IT, never because of where it was found. Pi
// discovers `SKILL.md` from the working directory; that inverts here, because the
// working directory is app-authored, low-trust content — a prompt-injection surface
// that must be fenced as data (ADVERSARIAL_REVIEW F5). So:
//
//   * every skill body is a MODULE CONSTANT compiled into this app's own bytes;
//   * nothing in this file reads a mount, a working tree, or any app-controlled
//     path — there is no fs import here and no code path that takes one;
//   * `load_skill` resolves ONLY against the frozen host registry, so an app cannot
//     introduce, name, or shadow a skill (`skills.test.ts` proves each of these).
//
// An app-AUTHORED skill would be a different feature with a different gate, and is
// out of scope.
//
// LOAD ON DEMAND. The point is to keep the base prompt small against the context
// budget R3-220 manages: the generated prompt carries each skill's one-line
// DESCRIPTION, and the body arrives only when the model calls `load_skill`.

import type { ToolExecutor } from './agentLoop';
import { mergeToolsets, type Toolset } from './toolset';
import { SDK_API_MAP, SDK_API_MAP_VERSION } from './skills/sdkApiMap.generated';

/** One host-shipped instruction block. */
export interface SkillDef {
  /** Stable identifier the model passes to `load_skill`. */
  name: string;
  /** Version of the block, so a transcript records which text the model was given. */
  version: string;
  /** The one-line trigger description that goes in the system prompt. This is what
   *  the model selects on, so it says WHEN to load, not just what the skill covers. */
  description: string;
  /** The instruction text. Host bytes — never read from a mount. */
  body: string;
  /** The skill is offered only when the live toolset contains at least one of these
   *  tools. A skill about authoring code is meaningless to an agent that holds no
   *  working tree (the real case: `ConversationStage` falls back to a catalog-only
   *  toolset when no stage worktree is conferred), and an affordance the model
   *  cannot act on is worse than no affordance. Absent ⇒ always offered. */
  requiresAnyTool?: readonly string[];
}

/** Tools that mean "this agent can actually author code in a working tree". */
const AUTHORING_TOOLS = ['write_file', 'edit_file'] as const;

const SDK_SKILL: SkillDef = {
  name: 'sdk',
  version: SDK_API_MAP_VERSION,
  description:
    'The @immediately-run/sdk API map — every export, its real signature, and the shapes it takes. ' +
    'Load this BEFORE importing anything from the SDK or guessing an export name or argument list.',
  body: SDK_API_MAP,
  requiresAnyTool: AUTHORING_TOOLS,
};

const DESIGN_SYSTEM_SKILL: SkillDef = {
  name: 'design-system',
  version: '1',
  description:
    'The immediately.run design system — colour/type/radius/shadow tokens and the brand rules. ' +
    'Load this before writing any CSS or choosing colours, fonts, or spacing for an app.',
  requiresAnyTool: AUTHORING_TOOLS,
  body: `# immediately.run design system

The brand in one line: cool near-black canvas, magenta↔violet signature gradient,
Gabarito display, Space Mono details, hairline borders, hard-offset hover shadows.
**Dark is the default.** No emoji. Sentence case. Headlines end on a period.

## Rules
- Never hard-code a colour, font, radius or shadow — use the tokens below via \`var(--token)\`.
- Define the dark palette on \`:root\` and re-declare only the changed tokens under a light block.
- The gradient (\`--grad\`) is the signature: use it on hero numerals and key accents, sparingly.
- Borders are hairlines (\`--line\`); depth comes from the hard offset shadow, not blur.
- Import global CSS from \`App.tsx\` (platform rule), and keep tokens in that one stylesheet.

## Tokens (dark — the default)
\`\`\`css
:root {
  /* surfaces */
  --bg: #0a0b11;            /* cool near-black page background */
  --panel: #13141d;         /* tile / card surface */
  --panel-2: #191b26;       /* raised / hover surface */
  /* borders */
  --line: rgba(180,170,225,.14);
  --line-2: rgba(180,170,225,.22);
  /* text */
  --ink: #ecebf4;           /* primary */
  --ink-2: #9b97b3;         /* secondary */
  --ink-3: #6a677f;         /* captions, disabled */
  /* accents */
  --accent: oklch(0.74 0.17 350);    /* pink-magenta — the through-line */
  --accent-2: oklch(0.66 0.18 295);  /* violet */
  --accent-3: oklch(0.82 0.12 340);  /* soft pink highlight */
  --accent-pink: #f49ad4;
  --accent-violet: #b285f2;
  --accent-hot: #c43d96;
  --grad: linear-gradient(96deg, #f6f1fb 0%, #f49ad4 46%, #b285f2 100%);
  --glow: 0 0 0 1px rgba(150,110,240,.5), 0 0 34px rgba(150,110,240,.32);
  /* type families */
  --disp: "Gabarito", system-ui, sans-serif;      /* display / headings */
  --sans: "Public Sans", system-ui, sans-serif;   /* body / UI */
  --mono: "Space Mono", ui-monospace, monospace;  /* code, stats, labels */
  /* type scale (font shorthand) */
  --display: 800 clamp(56px,12vw,168px)/.86 var(--disp);  /* hero, letter-spacing:-.04em */
  --h1: 800 clamp(40px,8vw,96px)/.85 var(--disp);
  --h2: 800 clamp(32px,5vw,58px)/.95 var(--disp);
  --h3: 800 21px/1 var(--disp);
  --h3-soft: 600 24px/1.1 var(--disp);
  --num: 800 62px/.8 var(--disp);                 /* big numerals — paint with --grad */
  --deck: 500 clamp(19px,2.2vw,26px)/1.32 var(--sans);
  --body: 400 16px/1.5 var(--sans);
  --body-sm: 400 14.5px/1.5 var(--sans);
  --label: 600 14.5px/1 var(--sans);
  --mono-sm: 400 13px/1.4 var(--mono);
  --mono-xs: 400 11px/1.3 var(--mono);
  /* tracking */
  --track-display: -.04em; --track-tight: -.03em; --track-snug: -.02em;
  /* radii */
  --r-xs: 5px;   /* logo square, inline code */
  --r-sm: 6px;   /* small tags, keycaps */
  --r-md: 12px;  /* code blocks, inputs */
  --r-lg: 16px;  /* cards, tiles, panels */
  --r-xl: 18px;  /* modals */
  --r-pill: 30px;/* buttons, nav links, badges */
  /* shadows */
  --shadow-card: 6px 6px 0 var(--accent-2);   /* hard offset on tile hover */
  --shadow-modal: 0 24px 70px rgba(0,0,0,.5);
  --shadow-pop: 0 12px 34px rgba(0,0,0,.45);
}
\`\`\`

## Light overrides (only these change)
\`\`\`css
--bg: #f6f4fb; --panel: #ffffff; --panel-2: #f0ecf8;
--line: rgba(40,24,70,.12); --line-2: rgba(40,24,70,.20);
--ink: #1c1726; --ink-2: #5d5670; --ink-3: #938aa6;
--accent: oklch(0.58 0.21 1); --accent-2: oklch(0.52 0.21 295); --accent-3: oklch(0.50 0.20 350);
--grad: linear-gradient(96deg, #c43d96 0%, #9a45e6 100%);
--glow: 0 0 0 1px rgba(150,90,235,.4), 0 8px 26px rgba(150,90,235,.20);
--shadow-modal: 0 24px 70px rgba(40,24,70,.18);
--shadow-pop: 0 12px 34px rgba(40,24,70,.14);
\`\`\`
`,
};

const EDITOR_FIRST_SKILL: SkillDef = {
  name: 'editor-first-editing',
  version: '1',
  description:
    'The editor-first rule: an app that lets a user edit a file delegates to the PLATFORM editor ' +
    'instead of shipping its own textarea. Load this before building any editing or "open file" affordance.',
  requiresAnyTool: AUTHORING_TOOLS,
  body: `# Editor-first editing (EDITOR_FIRST_EDITING_SPEC)

**The rule.** An app that wants the user to edit a file does **not** ship its own
editor. It hands the file to the platform editor, which already has the document
model, the syntax awareness, the save path, the undo history, and the permission
story. An app-local \`<textarea>\` re-implements all of that badly and silently
diverges from what the platform thinks the file contains.

## What to do instead
- **Open an existing file for editing:** \`openInEditor(target)\` from
  \`@immediately-run/sdk\`. Load the \`sdk\` skill for the exact signature.
- **Ask to leave present mode and edit what is on screen:** \`requestEdit()\`.
- **Create / rename / delete:** \`createFile\`, \`createFolder\`, \`renameEntry\`,
  \`deleteEntry\`, \`uploadFile\` — the SDK \`editor\` module, not your own fs writes.
- **Delegate one file to another app:** the \`edit-file\` task, invoked with a file
  capability. The user picks the target; your app never needs the wider grant.

## Why (the parts that bite)
- **Authority.** Delegating means your app does not need a broad write grant to let
  the user change a file: the capability is scoped to the one file, handed over for
  the one edit. An in-app editor forces you to ask for more than you need.
- **Read-only targets.** Not everything is editable. Surface the editor affordance
  only when the target really is writable — never let the user type into a box and
  then meet a raw \`EROFS\`. If you cannot determine editability, do not offer the
  affordance.
- **One document model.** Two editors over one file produce two versions of the
  truth; whichever writes last wins, and the user loses work they watched appear.

## The exception
An app whose *whole purpose* is a specialised authoring surface (a canvas, a
spreadsheet grid, a diagram tool) is editing its own document, not a text file, and
this rule does not apply. The test: would the platform editor be a worse experience
for this exact content? If the answer is no, delegate.
`,
};

/** The host-owned registry. Frozen so nothing at runtime can extend or replace it. */
export const HOST_SKILLS: readonly SkillDef[] = Object.freeze([
  SDK_SKILL,
  DESIGN_SYSTEM_SKILL,
  EDITOR_FIRST_SKILL,
]);

/** A skill as the system prompt needs to advertise it — name + trigger, no body. */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * Which skills are offered given the live toolset. A skill whose `requiresAnyTool`
 * matches nothing in `toolNames` is dropped: the prompt must not advertise an
 * affordance the surrounding grant makes meaningless (the same absent-when-ungranted
 * instinct the catalog tools use).
 */
export function selectSkills(
  toolNames: readonly string[],
  skills: readonly SkillDef[] = HOST_SKILLS,
): SkillDef[] {
  const have = new Set(toolNames);
  return skills.filter((s) => !s.requiresAnyTool || s.requiresAnyTool.some((t) => have.has(t)));
}

/** The prompt-facing catalog: one line per skill, bodies excluded. */
export const skillSummaries = (skills: readonly SkillDef[]): SkillSummary[] =>
  skills.map((s) => ({ name: s.name, description: s.description }));

/**
 * Build the `load_skill` {@link Toolset} over a fixed set of host skills.
 *
 * Returns an EMPTY toolset when `skills` is empty, so an agent with nothing to load
 * never sees the tool — the merged tool list stays exactly the tools that exist.
 *
 * Resolution is registry-only: `name` indexes a Map built from the host array. There
 * is no path, no fs, and no fallback lookup, so a name that is not a host skill
 * simply is not found — an app cannot introduce or shadow one.
 */
export function createSkillsToolset(skills: readonly SkillDef[] = HOST_SKILLS): Toolset {
  if (skills.length === 0) return { tools: [], execute: async () => ({ content: 'forbidden: no skills', isError: true }) };

  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name);

  const execute: ToolExecutor = async (toolName, input) => {
    if (toolName !== 'load_skill') {
      return { content: `forbidden: "${toolName}" is not a skill tool`, isError: true };
    }
    const requested = typeof input.name === 'string' ? input.name : '';
    const skill = byName.get(requested);
    if (!skill) {
      return {
        content: `no such skill: "${requested}". Available: ${names.join(', ')}`,
        isError: true,
      };
    }
    return { content: `<skill name="${skill.name}" version="${skill.version}">\n${skill.body}\n</skill>` };
  };

  return {
    tools: [
      {
        name: 'load_skill',
        description:
          'Load a host-provided skill: a reference block of platform knowledge that is not in your prompt. ' +
          'Call it when the skill\'s description matches what you are about to do — the content is authoritative, ' +
          'so prefer it over anything you remember. Available skills are listed in your system prompt.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name, exactly as listed in your system prompt.', enum: names },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    ],
    execute,
  };
}

/**
 * Attach the skills toolset to an already-merged base toolset, and report the
 * summaries the prompt should advertise.
 *
 * Ordering matters and is the reason this helper exists: which skills are offered
 * depends on which tools the run actually got, so selection has to happen AFTER the
 * base toolset is merged. Both agent surfaces call this so the two never drift.
 */
export function withSkills(
  base: Toolset,
  skills: readonly SkillDef[] = HOST_SKILLS,
): { toolset: Toolset; skills: SkillSummary[] } {
  const selected = selectSkills(base.tools.map((t) => t.name), skills);
  if (selected.length === 0) return { toolset: base, skills: [] };
  return {
    toolset: mergeToolsets(base, createSkillsToolset(selected)),
    skills: skillSummaries(selected),
  };
}
