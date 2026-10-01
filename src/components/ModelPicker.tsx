// ModelPicker (R3-620, LLM_AND_AGENTS_SPEC §0's editing-session exception) — the
// per-conversation model choice. A thin shell over `resolveConversationModel`
// (the stageSelection.ts shape): the rules live there, this only renders them.
//
// Renders NOTHING unless the host sent the chooseable set — `describeChat()`'s
// `connectedProviders`, which the host only sends a frame holding the ELEVATED
// `llm:chooseModel` capability (the conversation stage; a stage app or the panel
// sees it stripped and this picker stays absent, offering only the host's
// default path). The choice is remembered on the conversation record, not on
// the account and not on the app: `onChoose(null)` returns the conversation to
// the Settings default.
import { useMemo } from "react";
import type { ChatProviderChoice } from "@immediately-run/sdk";
import { resolveConversationModel, type HostModelView } from "../lib/resolveConversationModel";
import type { Conversation } from "../lib/conversationModel";

interface ModelPickerProps {
  /** The shown conversation's stored choice (or none). */
  stored: Conversation["model"];
  /** The host's resolved view: the Settings default + the connected ids. */
  host: HostModelView;
  /** `describeChat()`'s `connectedProviders`, or undefined when this frame does not hold `llm:chooseModel`. */
  connected: ChatProviderChoice[] | undefined;
  /** Store the pair on the conversation (null = the Settings default). */
  onChoose: (pair: { providerId: string; model: string } | null) => void;
}

export default function ModelPicker({ stored, host, connected, onChoose }: ModelPickerProps) {
  // The flat option list: one entry per connected provider × chooseable model.
  // The models are SUGGESTIONS, not a closed list — `chat()` passes the model
  // string through to the provider exactly as the Settings field does — but a
  // picker can only offer what it can list, and the record can hold any string
  // the user set when it was listed.
  const options = useMemo(() => {
    const out: { label: string; pair: { providerId: string; model: string } }[] = [];
    for (const c of connected ?? []) {
      for (const model of c.models) out.push({ label: `${c.displayName} · ${model}`, pair: { providerId: c.providerId, model } });
    }
    return out;
  }, [connected]);

  const resolved = useMemo(() => resolveConversationModel({ model: stored }, host), [stored, host]);

  // The default's label names what it would actually run — the honest default,
  // never "default" with the real model hidden behind it.
  const defaultLabel =
    resolved.source === "default" && resolved.model
      ? `Settings default · ${resolved.model.model}`
      : "Settings default";

  // The select's value is the stored pair's composite (options and the stale
  // option below both key on it), or "" for the Settings default.
  const value = stored ? stored.providerId + "\u0000" + stored.model : "";

  if (!connected || connected.length === 0) return null;

  return (
    <label className="ca-model">
      <span className="ca-model-label">Model</span>
      <select
        className="ca-model-select"
        value={value}
        onChange={(e) => {
          if (!e.target.value) {
            onChoose(null);
            return;
          }
          const found = options.find((o) => o.pair.providerId + "\u0000" + o.pair.model === e.target.value);
          onChoose(found ? found.pair : null);
        }}
      >
        <option value="">{defaultLabel}</option>
        {options.map((o) => (
          <option key={o.pair.providerId + "\u0000" + o.pair.model} value={o.pair.providerId + "\u0000" + o.pair.model}>
            {o.label}
          </option>
        ))}
        {/* A stale stored pair (the provider was disconnected) still names itself,
            so the choice is visibly inert rather than silently substituted. */}
        {stored && !options.some((o) => o.pair.providerId === stored.providerId && o.pair.model === stored.model) && (
          <option value={stored.providerId + "\u0000" + stored.model}>
            {`${stored.providerId} · ${stored.model} (not connected)`}
          </option>
        )}
      </select>
    </label>
  );
}
