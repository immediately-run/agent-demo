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

*2026-10-01 (R3-859 + R3-860; lands with site-main #663):* once every host catalog method advertises a
`paramsSchema`, `catalogToTools`'s
`PERMISSIVE_INPUT_SCHEMA` fallback (`src/lib/agentTools.ts`) is unreachable
against the first-party host. Left in place deliberately: against a
THIRD-party host (an older or non-immediately.run catalog) the fallback is
still the shape. Do not delete it without a host-capability signal.

## BYOK streaming + secrets

**Spec:** `LLM_AND_AGENTS_SPEC §2.2` (transport) + `SECRETS_SPEC §6` (secret
injection, never read by the app).

**Mapping (verified 2026-10-09):** the BYOK client modules are gone (removed
with the SDK `chat()` move — `chatModelClient.ts` carries the model call over
`llm:chat`, host-side key injection included; no BYOK secret or `apiKey`
header path remains). `net:fetch` is hosts-only — the hosts list below; no
`injectSecret` declaration exists.

## net:fetch host declaration (verified 2026-10-09)

`package.json` declares **two** hosts; neither is called by fixed app code
(the model call is the SDK `chat()` over `llm:chat` — `chatModelClient.ts`),
both are exercised host-/agent-side under the grant's allowlist:
- `https://example.com` — the `fetch:fetch` demo (the M2 attenuated-delegation
  probe and `download_file`'s tests).
- `https://placehold.co` — R3-863's poster-download live leg (poster-shaped
  placeholder images, fetched by the host for `download_file`).

## Model ids (verified 2026-10-09)

No repo code pins a model id: `chatModelClient.ts` states the provider AND the
model are the user's host-side preference — this client names neither.

---

## Recorded findings (code-verification pass, 2026-06)

- **SDK-version skew (resolved 2026-09-15):** agent-demo pinned
  `@immediately-run/sdk` at `^0.12.0` → **`^0.68.0`** by R3-559 (the checkpoint
  journal needs `openLocalStore()` from R3-558; verified against sdk main and
  the published 0.68.0). Recorded here because the old "do NOT bump" note is
  superseded — the coordinated fleet bump remains separate maintenance debt.
- **Vocabulary:** no `kernel` in comments; "provider" consistently the
  **LLM service-provider** sense (core_concepts §6), not app-identity — no rename
  needed. `main.tsx` carries no app logic/CSS (CLAUDE.md conformant).
