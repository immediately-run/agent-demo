// @vitest-environment happy-dom
// R3-612 — CodingAgent names where its runs are kept and offers a fresh start.
// The store is the REAL fs-injected core over MemFs; the component's mount effect
// restores the newest conversation's transcript, so "New conversation" is proven
// against a transcript that actually exists (a seeded user turn), not an empty one.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

vi.mock("@immediately-run/sdk", () => ({
  useCatalog: vi.fn(() => []),
  useMounts: vi.fn(() => []),
  getAppMountPath: vi.fn(() => "/app"),
  describeChat: vi.fn(() => null),
  // Read at toolset-construction time (createDiagnosticsToolset's default reader,
  // createGitToolset's state), inside the component's useMemo during render.
  getDiagnostics: vi.fn(() => ({
    buildErrors: [],
    consoleEntries: [],
    provenance: null,
  })),
  getVcsState: vi.fn(() => ({
    changes: [],
    branch: null,
    prs: [],
    diffLoading: false,
  })),
  invoke: vi.fn(async () => ({})),
}));

// openConversationStore resolves to the real store; the handle is parked here so
// tests can drive saves/creates through the same instance the component holds.
const storeHolder = vi.hoisted(() => ({
  store: null as null | import("../lib/conversationStore").ConversationStore,
}));

vi.mock("../lib/conversationStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/conversationStore")>();
  const { createConversationStore } = actual;
  const { MemFs } = await import("../lib/testing/memStoreFs");
  const store = createConversationStore({
    recordRoot: "/settings",
    fs: new MemFs(),
    tabId: "tab-coding-agent",
  });
  const seeded = await store.create();
  await store.save({
    ...seeded,
    messages: [
      { role: "user", content: [{ type: "text", text: "seed turn" }] },
    ],
  });
  storeHolder.store = store;
  return { ...actual, openConversationStore: async () => store };
});

import CodingAgent from "./CodingAgent";

afterEach(() => cleanup());

describe("CodingAgent — a fresh start, and runs name where they live (R3-612 / R-IX-5)", () => {
  it("New conversation clears the transcript and creates a conversation in the store", async () => {
    render(<CodingAgent />);
    // The mount effect restored the seeded transcript.
    await waitFor(() => expect(screen.getByText("seed turn")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    // Transcript cleared; the empty state names the Conversations list (R-IX-5).
    await waitFor(() => expect(screen.queryByText("seed turn")).toBeNull());
    expect(
      screen.getByText("Runs are saved to your Conversations list."),
    ).toBeTruthy();

    // And a SECOND conversation exists in the real store — the run target moved.
    const list = await storeHolder.store!.list();
    expect(list).toHaveLength(2);
  });
});
