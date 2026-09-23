// @vitest-environment happy-dom
// R3-695 — the attended-resume affordance's shape, pinned (AGENT_RUN_DURABILITY
// §5.3, the 2026-09-15 disposition): the offered choices are EXACTLY TWO
// ("Resume run", "Keep the files and end the run"), the file-changes-stay copy
// is said plainly, and the third spec'd choice — discard the tail AND revert
// the run's writes — is NOT offered (a discard button would silently keep the
// files: the rev-2 trap). Extracted from ConversationStage so the shape is
// assertable without mounting the stage.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ResumeAffordance from "./ResumeAffordance";

afterEach(cleanup);

describe("ResumeAffordance — the two-choice shape (R-ARD-15 / §5.3 disposition)", () => {
  it("offers exactly the two disposition choices — resume, and keep-the-files-and-end — and no third", () => {
    render(<ResumeAffordance journalDepth={14} onResume={() => {}} onKeepAndEnd={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Resume run", "Keep the files and end the run"]);
    // No discard-and-revert anywhere: the disposition killed it, and copy that
    // offers what will not happen is the trap the disposition exists to remove.
    expect(document.body.textContent).not.toMatch(/discard/i);
  });

  it("says the file changes stay, renders the work artifact ('interrupted after N steps'), never an unanswerable question", () => {
    render(<ResumeAffordance journalDepth={14} onResume={() => {}} onKeepAndEnd={() => {}} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("interrupted after 14 steps");
    expect(text).toContain("the file changes so far stay");
    expect(text).not.toMatch(/\?$/); // §5.3: never a question the user cannot answer
  });

  it("routes each choice to its verb", () => {
    const onResume = vi.fn();
    const onKeepAndEnd = vi.fn();
    render(<ResumeAffordance journalDepth={3} onResume={onResume} onKeepAndEnd={onKeepAndEnd} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume run" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep the files and end the run" }));
    expect(onKeepAndEnd).toHaveBeenCalledTimes(1);
  });
});
