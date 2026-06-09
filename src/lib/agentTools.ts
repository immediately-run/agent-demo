// Catalog-as-tools (LLM_AND_AGENTS_SPEC §3.3, "the grant-filtered §5.5 catalog
// verbatim"): turn the app's `useCatalog()` methods into the tool list handed to
// the model, and route the model's tool calls back through the host's gated
// `invoke()`. The model's reach is therefore EXACTLY the app's grants — an
// off-catalog or hallucinated tool returns `forbidden` at the §8.4 gate (G12/T24).

import { invoke, type ApiMethod } from '@immediately-run/sdk';

/** An Anthropic-shaped tool descriptor (`name` + `description` for the model +
 *  JSON-Schema `input_schema`). */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
}

// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$ — catalog names carry a
// colon (`spaces:share`), which is invalid. Map `:` ⇄ `__` bijectively. (Catalog
// names are `scheme:method` over alphanumerics, so `__` cannot collide.)
export const toToolName = (catalogName: string): string => catalogName.replace(/:/g, '__');
export const toCatalogName = (toolName: string): string => toolName.replace(/__/g, ':');

/**
 * Build the model's tool list from the app's grant-filtered catalog. Streaming
 * methods (`stream:true`) are skipped — a one-shot tool-use call can't consume a
 * stream. The SDK `ApiMethod` carries no param schema, so the schema is
 * permissive (`additionalProperties:true`); the host validates params and gates
 * the call regardless.
 */
export function catalogToTools(catalog: ApiMethod[]): AgentTool[] {
  return catalog
    .filter((m) => !m.stream)
    .map((m) => ({
      name: toToolName(m.name),
      description:
        `Platform method "${m.name}" (capability: ${m.capability}). ` +
        `Call it to perform this action on the user's behalf through the host. ` +
        `Params are passed as a JSON object and validated host-side.`,
      input_schema: { type: 'object', properties: {}, additionalProperties: true },
    }));
}

/**
 * Build a {@link ToolExecutor} bound to the current catalog. Confinement is
 * defense-in-depth: a tool name not in the catalog is rejected here as
 * `forbidden` WITHOUT calling `invoke` (the host would also reject it), and an
 * in-catalog call routes through the host's gated `invoke()`.
 */
export function createCatalogExecutor(catalog: ApiMethod[]) {
  const allowed = new Set(catalog.map((m) => toToolName(m.name)));
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }> => {
    if (!allowed.has(toolName)) {
      return { content: `forbidden: "${toCatalogName(toolName)}" is not in this app's catalog`, isError: true };
    }
    try {
      const result = await invoke(toCatalogName(toolName), input);
      return { content: JSON.stringify(result ?? null) };
    } catch (e) {
      const code = (e as { code?: string })?.code ?? 'error';
      const msg = (e as Error)?.message ?? String(e);
      return { content: `${code}: ${msg}`, isError: true };
    }
  };
}
