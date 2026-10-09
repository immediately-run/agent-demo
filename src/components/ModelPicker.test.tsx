// @vitest-environment happy-dom
// R3-620 — the per-conversation model picker's shell: what it renders and what
// each selection hands back. The rules themselves are pinned in
// `modelPickerOptions.test.ts`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ChatProviderChoice } from "@immediately-run/sdk";
import ModelPicker from "./ModelPicker";
import { pairKey } from "../lib/modelPickerOptions";
import type { HostModelView } from "../lib/resolveConversationModel";

afterEach(cleanup);

const connected: ChatProviderChoice[] = [
  { providerId: "llm.chat.openrouter", displayName: "OpenRouter", models: ["capable/model", "quick/model"] },
  { providerId: "llm.chat.anthropic", displayName: "Anthropic", models: ["claude-x"] },
];
const host: HostModelView = {
  default: { providerId: "llm.chat.openrouter", model: "capable/model" },
  connectedProviderIds: connected.map((c) => c.providerId),
};
const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("ModelPicker (R3-620)", () => {
  it("renders nothing when the host sent no connected set", () => {
    const { container } = render(<ModelPicker stored={undefined} host={host} connected={undefined} onChoose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("offers the Settings default first, then every connected provider's models", () => {
    render(<ModelPicker stored={undefined} host={host} connected={connected} onChoose={() => {}} />);
    expect(optionLabels()).toEqual([
      "Settings default · capable/model",
      "OpenRouter · capable/model",
      "OpenRouter · quick/model",
      "Anthropic · claude-x",
    ]);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("");
  });

  it("shows the stored choice as selected", () => {
    const stored = { providerId: "llm.chat.anthropic", model: "claude-x" };
    render(<ModelPicker stored={stored} host={host} connected={connected} onChoose={() => {}} />);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(pairKey(stored));
  });

  it("a stored pair whose provider is gone names itself as not connected", () => {
    render(
      <ModelPicker stored={{ providerId: "llm.chat.gemini", model: "gemini-x" }} host={host} connected={connected} onChoose={() => {}} />,
    );
    expect(optionLabels().at(-1)).toBe("llm.chat.gemini · gemini-x (not connected)");
  });

  it("choosing a model hands back its pair; choosing the default hands back null", () => {
    const onChoose = vi.fn();
    render(<ModelPicker stored={undefined} host={host} connected={connected} onChoose={onChoose} />);
    const select = screen.getByLabelText("Model");
    fireEvent.change(select, { target: { value: pairKey({ providerId: "llm.chat.anthropic", model: "claude-x" }) } });
    expect(onChoose).toHaveBeenLastCalledWith({ providerId: "llm.chat.anthropic", model: "claude-x" });
    fireEvent.change(select, { target: { value: "" } });
    expect(onChoose).toHaveBeenLastCalledWith(null);
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  it("is disabled while a run is in flight", () => {
    render(<ModelPicker stored={undefined} host={host} connected={connected} disabled onChoose={() => {}} />);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
  });
});
