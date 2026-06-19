// A Toolset bundles a tool list with the executor that runs those tools, so the
// agent loop (agentLoop.ts) can be fed several independent tool *sources* —
// the grant-filtered platform catalog (agentTools.ts) and the mount-scoped
// filesystem tools (fsTools.ts) — as one merged list + one dispatching executor.
//
// Merging keeps each source's confinement intact: a call is routed to the source
// that declared the tool, and a name no source declared returns `forbidden`
// without touching any executor (defense-in-depth; the host also gates).

import type { ToolExecutor } from './agentLoop';
import type { AgentTool } from './agentTools';
import { catalogToTools, createCatalogExecutor } from './agentTools';
import type { ApiMethod } from '@immediately-run/sdk';

/** A self-contained group of tools plus the executor that runs them. */
export interface Toolset {
  tools: AgentTool[];
  execute: ToolExecutor;
}

/** The platform-catalog toolset (§3.3): the app's grant-filtered §5.5 catalog as
 *  tools, routed back through the host's gated `invoke()`. */
export function catalogToolset(catalog: ApiMethod[]): Toolset {
  return { tools: catalogToTools(catalog), execute: createCatalogExecutor(catalog) };
}

/**
 * Merge several toolsets into one. The merged `tools` is the concatenation; the
 * merged `execute` dispatches each call to the toolset that owns that tool name
 * (first declarer wins on the unlikely collision). A name no toolset declares —
 * a hallucinated tool — returns `forbidden` without entering any executor.
 */
export function mergeToolsets(...sets: Toolset[]): Toolset {
  const owner = new Map<string, ToolExecutor>();
  const tools: AgentTool[] = [];
  for (const set of sets) {
    for (const tool of set.tools) {
      if (owner.has(tool.name)) continue; // first declarer wins
      owner.set(tool.name, set.execute);
      tools.push(tool);
    }
  }
  const execute: ToolExecutor = async (name, input) => {
    const run = owner.get(name);
    if (!run) return { content: `forbidden: "${name}" is not a tool this app provides`, isError: true };
    return run(name, input);
  };
  return { tools, execute };
}
