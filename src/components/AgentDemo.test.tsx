// @vitest-environment happy-dom
// R3-612 — the demo.txt destroy leg (R-IX-5: where a thing can be created it can
// be removed). The create control delegated into the settings mount, so the
// remove control takes it back through the SAME mount; its busy state is named
// ("Removing…"), and a mount refusal surfaces verbatim — never a fake success.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@immediately-run/sdk", () => ({
  useCatalog: vi.fn(() => []),
  invoke: vi.fn(async () => ({})),
  postToRegion: vi.fn(async () => {}),
  invokeTask: vi.fn(async () => ({})),
  capFile: vi.fn((ref: unknown, opts: unknown) => ({ $cap: "file", ref, opts })),
  openSettings: vi.fn(async () => ({ id: "m1", path: "/settings" })),
  openFs: vi.fn(() => {
    throw new Error("openFs not staged for this test");
  }),
}));

import AgentDemo from "./AgentDemo";
import { openFs } from "@immediately-run/sdk";

afterEach(() => cleanup());

describe("AgentDemo — demo.txt has a remove beside its create (R3-612 / R-IX-5)", () => {
  beforeEach(() => {
    vi.mocked(openFs).mockClear();
  });

  it("removes through the settings mount, announcing the busy state by name", async () => {
    let release!: () => void;
    const rm = vi.fn(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    vi.mocked(openFs).mockImplementation(() => ({ rm }) as never);

    render(<AgentDemo />);
    const removeBtn = screen.getByRole("button", { name: "Remove demo.txt" });
    const editBtn = screen.getByRole("button", { name: "Edit demo.txt in my space" });
    fireEvent.click(removeBtn);

    // In flight: the busy label is the NAMED one, and BOTH controls on the row
    // are disabled (the item's busy-state contract).
    expect(screen.getByRole("button", { name: "Removing…" })).toBeTruthy();
    expect(editBtn.hasAttribute("disabled")).toBe(true);

    // The rm call happens after openSettings() resolves (a microtask later than
    // the click), so wait for it before releasing the gate.
    await waitFor(() => expect(rm).toHaveBeenCalledWith("demo.txt"));
    release();
    await waitFor(() => expect(screen.getByText("removed demo.txt from your settings")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove demo.txt" })).toBeTruthy());
  });

  it("a mount refusal surfaces verbatim, never as success", async () => {
    const rm = vi.fn(() => Promise.reject(Object.assign(new Error("EROFS: read-only file system"), { code: "read-only" })));
    vi.mocked(openFs).mockImplementation(() => ({ rm }) as never);

    render(<AgentDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Remove demo.txt" }));

    await waitFor(() => expect(screen.getByText("read-only")).toBeTruthy());
    expect(screen.queryByText("removed demo.txt from your settings")).toBeNull();
  });
});
