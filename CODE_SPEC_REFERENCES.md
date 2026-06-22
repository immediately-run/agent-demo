# CODE_SPEC_REFERENCES — agent-demo

Durable index of **non-trivial** code↔spec mappings. Seeded by the 2026-06
code-verification pass (R3-124; plan `08-system-apps.md`). Trivial mappings are
inline `// <SPEC> §X` comments.

## Catalog-as-tools (the load-bearing one)

**Spec:** `LLM_AND_AGENTS_SPEC §3.3` (the agent's tool list **is** the
grant-filtered SDK method catalog) + `UI_AS_APPS_SPEC §5.5` (the method catalog)
+ CLAUDE.md security rule #8. core_concepts §6 (Service) / §5 (Capability).

**Mapping (non-obvious — a reader wouldn't rediscover the chain quickly):**

```
SDK catalog (grant-filtered, ApiMethod[])
  → catalogToolset(catalog)                 src/lib/toolset.ts
  → catalogToTools() (ApiMethod → tool fmt, `:`↔`__` bijection)  src/lib/agentTools.ts
  → createCatalogExecutor() (off-catalog call → forbidden, before invoke())  agentTools.ts
  → mergeToolsets(catalogToolset(catalog), fsTools)  toolset.ts
  → invoke()                                 host-brokered, gated again (§8.4)
```

The agent can therefore never exceed the app's grants: hallucinated/off-catalog
tools are rejected at `agentTools.ts` *before* reaching `invoke()`, and the host
re-gates at use. There is **no hand-rolled tool that shells around the SDK** —
verified 2026-06. `CodingAgent.tsx` / `ConversationStage.tsx` instantiate the
merged toolset.

## BYOK streaming + secrets

**Spec:** `LLM_AND_AGENTS_SPEC §2.2` (transport) + `SECRETS_SPEC §6` (secret
injection, never read by the app).

**Mapping:** `claudeClient.ts` / `openaiClient.ts` route every call through the
host fetch helper (`hostFetch`); `modelClient.ts` sets `streamImpl: null`
(SECRETS_SPEC §2.2 — the backend stream proxy never injects BYOK secrets, so
streaming is disabled by design). Secrets are injected host-side via
`injectSecret` (declared in `package.json` `requests.net:fetch.hosts`), never
read by the app. The dev/test-only `apiKey` header paths are explicitly gated
("prod relies on injectSecret").

## net:fetch host declaration (verified 2026-06)

`package.json` declares **two** hosts and the code calls **both**, with no
undeclared host and no dead declaration:
- `https://api.anthropic.com/v1/` ← `claudeClient.ts` (`/v1/messages`),
  `injectSecret { family: "anthropic", type: "api-key" }` → `x-api-key`.
- `https://openrouter.ai/api/v1/` ← `openaiClient.ts` / `modelClient.ts`
  (`/api/v1/chat/completions`), `injectSecret { type: "bearer-token" }`.

## Model ids (verified 2026-06 against the `claude-api` skill)

- Anthropic default `claude-opus-4-8` (`claudeClient.ts` / `modelClient.ts`) is
  the **current** Opus model id — not stale, no date suffix. Conforms.
- OpenRouter default `openai/gpt-4o-mini` is a non-Anthropic id (out of scope).

---

## Recorded findings (code-verification pass, 2026-06)

- **SDK-version skew (record only, do NOT bump):** agent-demo pins
  `@immediately-run/sdk` at **`^0.12.0`** — the highest pin in the fleet (others
  on `0.2.8` / `0.8.1`; file-explorer `0.11.0`). Fleet maintenance debt; a
  coordinated bump is a separate gated change.
- **Vocabulary:** no `kernel` in comments; "provider" consistently the
  **LLM service-provider** sense (core_concepts §6), not app-identity — no rename
  needed. `main.tsx` carries no app logic/CSS (CLAUDE.md conformant).
