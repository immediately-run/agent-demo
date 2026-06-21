// Shared provider-key connection for the agent surfaces (CodingAgent + the
// stage-slot ConversationStage). Both run the same BYOK loop and need the same
// thing before the first model call: the user's stored provider key BOUND to this
// app (SECRETS_SPEC §6). The browser-direct injectSecret path refuses the fetch
// ("outside manifest ∩ grant allowlist") until that (appKey, secretId) use-grant
// exists, so we mint it with the `requestSecret` powerbox — falling back to the
// host "add secret" modal when no key is stored yet.

import { useState } from "react";
import { requestSecret, requestAddSecret, useSecrets } from "@immediately-run/sdk";
import { DEFAULT_PROVIDER, PROVIDERS, type ProviderConfig } from "./modelClient";

export interface ProviderConnection {
  /** The provider this build talks to (default OpenRouter). */
  provider: ProviderConfig;
  /** True once a use-grant for the provider key is in hand this session. */
  connected: boolean;
  /** A key of the right type is stored (drives "Connect" vs "Add" wording). Note
   *  storing ≠ granting — {@link connect} still mints the per-app use-grant. */
  hasStoredKey: boolean;
  /** Human-readable note for the last connect attempt (cancel / forbidden / error). */
  keyMsg: string | null;
  /** Bind the stored key to this app (powerbox), adding one first if needed.
   *  Resolves `true` once a grant exists. Idempotent: a no-op when already
   *  connected. */
  connect: () => Promise<boolean>;
}

export function useProviderConnection(): ProviderConnection {
  const secrets = useSecrets();
  const provider = PROVIDERS[DEFAULT_PROVIDER];
  const [connected, setConnected] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  const hasStoredKey = secrets.some(
    (s) =>
      s.type === provider.secretType &&
      (s.boundOrigin ?? "").includes(new URL(provider.host).host),
  );

  const connect = async (): Promise<boolean> => {
    if (connected) return true;
    setKeyMsg(null);
    try {
      await requestSecret({ type: provider.secretType });
      setConnected(true);
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "cancelled") {
        setKeyMsg("Key setup cancelled.");
        return false;
      }
      // No matching stored secret (or none granted) → offer to add one, then bind.
      try {
        await requestAddSecret({
          type: provider.secretType,
          suggestedOrigin: provider.host,
          description: `${provider.label} API key for the coding agent`,
        });
        await requestSecret({ type: provider.secretType });
        setConnected(true);
        return true;
      } catch (e2) {
        const c2 = (e2 as { code?: string })?.code;
        setKeyMsg(
          c2 === "cancelled"
            ? "Key setup cancelled."
            : c2 === "forbidden"
              ? `This app can't manage secrets here; add a ${provider.label} key in host settings.`
              : `Couldn't connect ${provider.label}: ${(e2 as Error)?.message ?? String(e2)}`,
        );
        return false;
      }
    }
  };

  return { provider, connected, hasStoredKey, keyMsg, connect };
}
