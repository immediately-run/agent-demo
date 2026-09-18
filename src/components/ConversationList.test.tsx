// @vitest-environment happy-dom
// R3-612 — the first component tests in this repo (the item's harness: happy-dom +
// @testing-library/react, the SDK barrel mocked exactly as the lib tests mock it).
//
// What is under test is the ACCESSIBLE shape, not the pixels: the row is a plain
// <li> whose open control is a real button (WCAG 4.1.2 — two controls, two names),
// delete removes through the store, and a `conversation-updated` message patches
// the ONE row it names without re-listing the store (R-IX-4). Rows come from the
// REAL fs-injected store over MemFs — never a hand-typed array (R2).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

vi.mock("@immediately-run/sdk", () => ({
  postToRegion: vi.fn(async () => {}),
  revealRegion: vi.fn(async () => {}),
  useWorkspace: vi.fn(() => null),
  onRegionMessage: vi.fn(
    (listener: (m: { from: string; data: unknown }) => void) => {
      regionListeners.push(listener);
      return () => {
        const i = regionListeners.indexOf(listener);
        if (i >= 0) regionListeners.splice(i, 1);
      };
    },
  ),
}));

// The store is REAL (fs-injected core over MemFs); only its mount resolution is
// replaced, so list/load/save/remove run the shipped code. One seeded row per
// store, created through the store itself — the list test fixture is store output,
// not a literal. (The vi.mock factory below is hoisted, so it reaches the impl
// through this holder rather than a top-level const.)
const storeHolder = vi.hoisted(() => ({
  make: null as null | (() => Promise<unknown>),
}));

vi.mock("../lib/conversationStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/conversationStore")>();
  return { ...actual, openConversationStore: () => storeHolder.make!() };
});

type SpiedStore = import("../lib/conversationStore").ConversationStore & {
  list: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};
let lastStore: SpiedStore | null = null;

const makeStore = async (): Promise<SpiedStore> => {
  const { createConversationStore } = await import("../lib/conversationStore");
  const { MemFs } = await import("../lib/testing/memStoreFs");
  const base = createConversationStore({
    recordRoot: "/settings",
    fs: new MemFs(),
    tabId: "tab-conversation-list",
  });
  await base.create("notes");
  const wrapped = {
    ...base,
    list: vi.fn(base.list.bind(base)),
    load: vi.fn(base.load.bind(base)),
    save: vi.fn(base.save.bind(base)),
    remove: vi.fn(base.remove.bind(base)),
  };
  lastStore = wrapped;
  return wrapped;
};
storeHolder.make = makeStore;

import ConversationList from "./ConversationList";
import { STAGE_REGION } from "../lib/conversationIpc";

const regionListeners: Array<(m: { from: string; data: unknown }) => void> = [];

beforeEach(() => {
  regionListeners.length = 0;
  lastStore = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const postFromStage = (data: unknown): void => {
  for (const l of [...regionListeners]) l({ from: STAGE_REGION, data });
};

const renderWithNotesRow = async () => {
  render(<ConversationList />);
  await waitFor(() => expect(screen.getByText("notes")).toBeTruthy());
};

describe("ConversationList — the row is two controls, two names (R3-612 / WCAG 4.1.2)", () => {
  it("the open control is a real button named by its content, and never absorbs the delete label", async () => {
    await renderWithNotesRow();

    // The open control's accessible name is its content ("notes just now") — the
    // delete label ("Delete notes") must not be absorbed into it. (A regex /notes/
    // here would match BOTH controls — the delete row's name legitimately contains
    // the title; the defect under test is the OPEN control carrying "Delete …".)
    const open = screen.getByRole("button", { name: "notes just now" });
    expect(open.getAttribute("aria-label")).toBeNull();
    expect(open.textContent).not.toContain("Delete");
    expect(screen.getByRole("button", { name: "Delete notes" })).not.toBe(open);

    // The <li> itself is not interactive: no button role, no tabindex.
    const row = open.closest("li")!;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
  });

  it("delete removes through the store and the row goes", async () => {
    await renderWithNotesRow();
    const id = (await lastStore!.list())[0].id;

    fireEvent.click(screen.getByRole("button", { name: "Delete notes" }));

    await waitFor(() => expect(screen.queryByText("notes")).toBeNull());
    await waitFor(() => expect(lastStore!.remove).toHaveBeenCalledWith(id));
  });

  it("a conversation-updated message patches the ONE row it names and never calls list() again (R-IX-4)", async () => {
    await renderWithNotesRow();

    // The stage saved the conversation (retitled) and posted the id. Apply the
    // save through the SAME real store, then replay the message the stage posts.
    const id = (await lastStore!.list())[0].id;
    const saved = await lastStore!.load(id);
    expect(saved).toBeTruthy();
    await lastStore!.save({ ...saved!, title: "notes, renamed" });
    const listCalls = lastStore!.list.mock.calls.length;

    postFromStage({ type: "conversation-updated", id });

    await waitFor(() =>
      expect(screen.getByText("notes, renamed")).toBeTruthy(),
    );
    expect(lastStore!.list.mock.calls.length).toBe(listCalls);
    expect(lastStore!.load).toHaveBeenCalledWith(id);
  });

  it("the message for a row deleted elsewhere removes that row", async () => {
    await renderWithNotesRow();
    const id = (await lastStore!.list())[0].id;
    await lastStore!.remove(id);

    postFromStage({ type: "conversation-updated", id });

    await waitFor(() => expect(screen.queryByText("notes")).toBeNull());
  });
});

describe("ConversationList — the other-repositories count names what it counts (R3-475)", () => {
  // Two stamped repos ride the REAL store (one with two members, one with one), so
  // the group counts are the producer's own arithmetic; the workspace mock stays
  // null, so every stamped repo groups under "other repositories" by rule.
  const seedWithOthers = async () => {
    storeHolder.make = async () => {
      const { createConversationStore } = await import("../lib/conversationStore");
      const { MemFs } = await import("../lib/testing/memStoreFs");
      const base = createConversationStore({
        recordRoot: "/settings",
        fs: new MemFs(),
        tabId: "tab-conversation-list-others",
      });
      await base.create("notes");
      await base.create("recipe plan", "other/repo");
      await base.create("recipe followup", "other/repo");
      await base.create("solo elsewhere", "third/repo");
      const wrapped = {
        ...base,
        list: vi.fn(base.list.bind(base)),
        load: vi.fn(base.load.bind(base)),
        save: vi.fn(base.save.bind(base)),
        remove: vi.fn(base.remove.bind(base)),
      };
      lastStore = wrapped;
      return wrapped;
    };
  };

  it("the count carries a hover label and an accessible text — singular and plural", async () => {
    await seedWithOthers();
    render(<ConversationList />);
    await waitFor(() => expect(screen.getByText("Other repositories")).toBeTruthy());

    // The accessible form is REAL (visually hidden) text; the visible digit is
    // aria-hidden so the number is never announced as a bare "2".
    const pluralLabel = screen.getByText("2 conversations in other/repo");
    expect(pluralLabel.classList.contains("cl-vh")).toBe(true);
    const pluralDigit = screen.getByText("2");
    expect(pluralDigit.getAttribute("aria-hidden")).toBe("true");
    expect(pluralDigit.parentElement!.getAttribute("title")).toBe("2 conversations in other/repo");

    const singularLabel = screen.getByText("1 conversation in third/repo");
    expect(singularLabel.classList.contains("cl-vh")).toBe(true);
    const singularDigit = screen.getByText("1");
    expect(singularDigit.getAttribute("aria-hidden")).toBe("true");
    expect(singularDigit.parentElement!.getAttribute("title")).toBe("1 conversation in third/repo");
  });
});
