// ModelPicker (R3-620, LLM_AND_AGENTS_SPEC §0's editing-session exception) — the
// per-conversation model choice. A thin shell: the option list, the labels and
// the key↔pair mapping are `buildModelPickerView`'s, and the run's rule is
// `resolveConversationModel`'s.
//
// Renders nothing unless the host sent the chooseable set — `describeChat()`'s
// `connectedProviders`, which the host only sends a frame holding the elevated
// `llm:chooseModel` capability (the conversation stage; a stage app or the panel
// sees it stripped and this picker stays absent, offering only the host's
// default path). The choice is remembered on the conversation record, not on
// the account and not on the app: `onChoose(null)` returns the conversation to
// the Settings default.
import { useMemo } from "react";
import type { ChatProviderChoice } from "@immediately-run/sdk";
import type { HostModelView } from "../lib/resolveConversationModel";
import { buildModelPickerView, pairForKey, DEFAULT_MODEL_KEY } from "../lib/modelPickerOptions";
import type { Conversation } from "../lib/conversationModel";

interface ModelPickerProps {
  /** The shown conversation's stored choice (or none). */
  stored: Conversation["model"];
  /** The host's resolved view: the Settings default + the connected ids. */
  host: HostModelView;
  /** `describeChat()`'s `connectedProviders`, or undefined when this frame does not hold `llm:chooseModel`. */
  connected: ChatProviderChoice[] | undefined;
  /** A run is in flight: the choice applies to the next run, so it cannot change now. */
  disabled?: boolean;
  /** Store the pair on the conversation (null = the Settings default). */
  onChoose: (pair: { providerId: string; model: string } | null) => void;
}

export default function ModelPicker({ stored, host, connected, disabled, onChoose }: ModelPickerProps) {
  const view = useMemo(() => buildModelPickerView(stored, host, connected), [stored, host, connected]);
  if (!view) return null;

  return (
    <label className="ca-model">
      <span>Model</span>
      <select
        className="ca-model-select"
        value={view.value}
        disabled={disabled}
        title={disabled ? "The model can be changed when this run ends" : undefined}
        onChange={(e) => {
          const pair = pairForKey(view, e.target.value);
          if (pair !== undefined) onChoose(pair);
        }}
      >
        <option value={DEFAULT_MODEL_KEY}>{view.defaultLabel}</option>
        {view.options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
