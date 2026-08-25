// The SDK skill is GENERATED from the installed @immediately-run/sdk (R3-331). This
// suite is the anti-drift half of that decision: a stale API map the model trusts
// absolutely is a worse failure than no map at all.
//
// The STALENESS gate itself is `node scripts/gen-sdk-skill.mjs --check`, run ahead of
// vitest by `npm test` — it needs node builtins, and `src/` deliberately compiles
// without node types so app code cannot reach for them. What is asserted here is what
// the generated artifact must CONTAIN for the skill to be worth loading.

import { describe, it, expect } from 'vitest';
import { SDK_API_MAP, SDK_API_MAP_VERSION } from './sdkApiMap.generated';

describe('the generated SDK API map', () => {
  it('names the SDK version it was generated from, in both the constant and the text', () => {
    expect(SDK_API_MAP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(SDK_API_MAP).toContain(`@immediately-run/sdk ${SDK_API_MAP_VERSION}`);
  });

  it('carries real signatures for the exports an agent actually reaches for', () => {
    expect(SDK_API_MAP).toContain('chat(req: ChatRequest)');
    expect(SDK_API_MAP).toContain('openFs(mount: SandboxMount): MountFs');
    expect(SDK_API_MAP).toContain('rename(fromRel: string, toRel: string)');
    expect(SDK_API_MAP).toContain('mimeTypeFor(path: string)');
    expect(SDK_API_MAP).toContain('contribute');
  });

  it('expands the interfaces an author has to get right, and only names the aliases', () => {
    expect(SDK_API_MAP).toMatch(/interface MountFs \{[^\n]*writeFile/);
    expect(SDK_API_MAP).toMatch(/interface ChatRequest \{/);
    // A union alias adds nothing a signature did not already say.
    expect(SDK_API_MAP).toMatch(/types: [^\n]*ChatStopReason/);
  });

  it('tells the model where the exports come from and that the list is closed', () => {
    expect(SDK_API_MAP).toContain('exported from the package root');
    expect(SDK_API_MAP).toContain('A name that is not in this list does not exist.');
  });
});
