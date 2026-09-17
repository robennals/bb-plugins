// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelTab } from "./tabs.js";

const THREAD = "thr_1";

function tabs(): PanelTab[] {
  return [
    { id: "a", kind: "thread-info" },
    { id: "b", kind: "browser", url: "https://example.com", title: "Example" },
    { id: "c", kind: "terminal", terminalId: "term_1" },
  ];
}

function mutationResult(remaining: PanelTab[], outcome: "updated" | "conflict" = "updated") {
  return { outcome, revision: 5, tabs: remaining, terminalWarnings: [] };
}

async function loadApp() {
  return await loadPluginApp(() => import("./app"));
}

// renderSlot mounts into document.body; without this every later query sees
// the previous test's rows too.
let mounted: { lifecycle: { unmount: () => void } } | null = null;
afterEach(() => {
  mounted?.lifecycle.unmount();
  mounted = null;
});

/** Renders the side-panel action, which draws the tab list without a popover. */
async function renderPanel(rpc: Record<string, (input: never) => unknown>) {
  const app = await loadApp();
  const registration = app.threadPanelActions.find((entry) => entry.id === "manage-tabs")!;
  const slot = renderSlot(registration, { threadId: THREAD, params: null }, { rpc });
  mounted = slot;
  await slot.findByText("Thread info");
  return slot;
}

describe("registrations", () => {
  // The frontend harness captures no command-palette actions, so the palette
  // registration is verified by hand against a running bb, not here.
  it("registers a thread header action and a side-panel action", async () => {
    const app = await loadApp();
    expect(app.threadHeaderActions.map((entry) => entry.id)).toContain("tab-manager");
    expect(app.threadPanelActions.map((entry) => entry.id)).toContain("manage-tabs");
  });
});

// The header button's popover is not asserted here: the vendored
// PopoverContent branches on viewport and renders through the host's portal
// scope, and neither branch mounts under jsdom (reproduced with click,
// pointerDown, and body-scoped queries). It wraps the same TabList the
// side-panel tests below exercise, so only the trigger goes unverified —
// checked by hand against a running bb instead.
describe("the tab list", () => {
  let listTabs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listTabs = vi.fn(() => ({ revision: 4, tabs: tabs() }));
  });

  it("draws a row per tab, labelled by kind", async () => {
    const slot = await renderPanel({ tabs_list: listTabs });
    expect(await slot.findByText("Thread info")).toBeTruthy();
    expect(await slot.findByText("Example")).toBeTruthy();
    expect(await slot.findByText("Terminal")).toBeTruthy();
    expect(await slot.findByText("3 tabs")).toBeTruthy();
  });

  it("closes one tab with its current revision", async () => {
    const close = vi.fn(() => mutationResult([tabs()[0]!, tabs()[2]!]));
    const slot = await renderPanel({ tabs_list: listTabs, tabs_close: close });
    (await slot.findByLabelText("Close Example")).click();
    await slot.findByText("2 tabs");
    expect(close).toHaveBeenCalledWith({
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["b"],
    });
  });

  it("closes the tabs below a row", async () => {
    const closeMode = vi.fn(() => mutationResult([tabs()[0]!]));
    const slot = await renderPanel({ tabs_list: listTabs, tabs_close_mode: closeMode });
    (await slot.findByLabelText("Close tabs below Thread info")).click();
    await slot.findByText("1 tab");
    expect(closeMode).toHaveBeenCalledWith({ threadId: THREAD, mode: "right", anchorId: "a" });
  });

  it("closes every tab from the footer", async () => {
    const closeMode = vi.fn(() => mutationResult([]));
    const slot = await renderPanel({ tabs_list: listTabs, tabs_close_mode: closeMode });
    (await slot.findByText("Close all")).click();
    await slot.findByText("This thread has no panel tabs.");
    expect(closeMode).toHaveBeenCalledWith({ threadId: THREAD, mode: "all", anchorId: null });
  });

  it("moves a tab up by one position", async () => {
    const reorder = vi.fn(() => mutationResult([tabs()[1]!, tabs()[0]!, tabs()[2]!]));
    const slot = await renderPanel({ tabs_list: listTabs, tabs_reorder: reorder });
    (await slot.findByLabelText("Move Example up")).click();
    await slot.findByText("3 tabs");
    expect(reorder).toHaveBeenCalledWith({
      threadId: THREAD,
      expectedRevision: 4,
      tabId: "b",
      toIndex: 0,
    });
  });

  it("does not offer to move the first tab up or the last tab down", async () => {
    const slot = await renderPanel({ tabs_list: listTabs });
    expect((await slot.findByLabelText("Move Thread info up")).hasAttribute("disabled")).toBe(true);
    expect((await slot.findByLabelText("Move Terminal down")).hasAttribute("disabled")).toBe(true);
    expect((await slot.findByLabelText("Move Example up")).hasAttribute("disabled")).toBe(false);
  });

  it("does not offer to close below the last tab", async () => {
    const slot = await renderPanel({ tabs_list: listTabs });
    expect((await slot.findByLabelText("Close tabs below Terminal")).hasAttribute("disabled"))
      .toBe(true);
  });

  it("adopts BB's tabs when a write conflicts", async () => {
    const close = vi.fn(() => mutationResult([tabs()[0]!], "conflict"));
    const slot = await renderPanel({ tabs_list: listTabs, tabs_close: close });
    (await slot.findByLabelText("Close Example")).click();
    await slot.findByText("1 tab");
    expect(slot.queryByText("Example")).toBeNull();
  });

  it("reports a failing load instead of rendering an empty list", async () => {
    const app = await loadApp();
    const registration = app.threadPanelActions.find((entry) => entry.id === "manage-tabs")!;
    const slot = renderSlot(
      registration,
      { threadId: THREAD, params: null },
      {
        rpc: {
          tabs_list: () => {
            throw new Error("thread is gone");
          },
        },
      },
    );
    mounted = slot;
    expect(await slot.findByText("thread is gone")).toBeTruthy();
  });
});
