import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import type { PanelTab } from "./tabs.js";

const THREAD = "thr_1";

function baseTabs(): PanelTab[] {
  return [
    { id: "a", kind: "thread-info" },
    { id: "b", kind: "terminal", terminalId: "term_1" },
    { id: "c", kind: "browser", url: "https://example.com", title: "Example" },
  ];
}

/**
 * A stand-in for BB's tab store: `update` enforces the same revision check the
 * server does, so the conflict paths are exercised for real rather than mocked.
 */
function createTabStore(initial: PanelTab[] = baseTabs(), revision = 4) {
  const state = { revision, tabs: initial };
  return {
    state,
    get: vi.fn(async () => ({ revision: state.revision, tabs: state.tabs })),
    update: vi.fn(async ({ expectedRevision, tabs }: { expectedRevision: number; tabs: PanelTab[] }) => {
      if (expectedRevision !== state.revision) throw new Error("revision mismatch");
      state.revision += 1;
      state.tabs = tabs;
      return { revision: state.revision, tabs: state.tabs };
    }),
  };
}

function createHost(store = createTabStore(), closeTerminal = vi.fn(async () => ({}))) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "tab-manager",
    sdk: {
      threads: { tabs: { get: store.get, update: store.update } },
      terminals: { close: closeTerminal },
    },
  });
  plugin(bb);
  return { harness, store, closeTerminal };
}

describe("tabs_list", () => {
  it("returns the thread's current tabs and revision", async () => {
    const { harness } = createHost();
    await expect(harness.behavior.callRpc("tabs_list", { threadId: THREAD })).resolves.toEqual({
      revision: 4,
      tabs: baseTabs(),
    });
  });
});

describe("tabs_close", () => {
  it("removes the named tabs and keeps the rest in order", async () => {
    const { harness, store } = createHost();
    const result = await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["a"],
    });
    expect(result.outcome).toBe("updated");
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["b", "c"]);
    expect(store.state.revision).toBe(5);
  });

  it("closes the underlying session when a terminal tab goes", async () => {
    const { harness, closeTerminal } = createHost();
    await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["b"],
    });
    expect(closeTerminal).toHaveBeenCalledWith({ terminalId: "term_1", mode: "force" });
  });

  it("does not touch terminal sessions whose tabs survive", async () => {
    const { harness, closeTerminal } = createHost();
    await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["c"],
    });
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("still reports success when a terminal refuses to die, and warns", async () => {
    const closeTerminal = vi.fn(async () => {
      throw new Error("busy");
    });
    const { harness } = createHost(createTabStore(), closeTerminal);
    const result = await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["b"],
    });
    expect(result.outcome).toBe("updated");
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["a", "c"]);
    expect(result.terminalWarnings).toEqual([
      "Terminal session term_1 could not be closed: busy",
    ]);
  });

  it("reports a conflict with fresh tabs when BB rejects the write", async () => {
    const store = createTabStore();
    // Passes our own revision check, then loses a race inside BB.
    store.update.mockRejectedValueOnce(new Error("revision mismatch"));
    const { harness } = createHost(store);
    const result = await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 4,
      tabIds: ["a"],
    });
    expect(result.outcome).toBe("conflict");
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["a", "b", "c"]);
  });

  it("refuses a stale write and hands back BB's current tabs", async () => {
    const { harness, store } = createHost();
    const result = await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 1,
      tabIds: ["a"],
    });
    expect(result.outcome).toBe("conflict");
    expect(result.revision).toBe(4);
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("does not close terminal sessions for a conflicted write", async () => {
    const { harness, closeTerminal } = createHost();
    await harness.behavior.callRpc("tabs_close", {
      threadId: THREAD,
      expectedRevision: 1,
      tabIds: ["b"],
    });
    expect(closeTerminal).not.toHaveBeenCalled();
  });
});

describe("tabs_close_mode", () => {
  it("closes everything for 'all' without needing a revision from the caller", async () => {
    const { harness, store } = createHost();
    const result = await harness.behavior.callRpc("tabs_close_mode", {
      threadId: THREAD,
      mode: "all",
      anchorId: null,
    });
    expect(result.outcome).toBe("updated");
    expect(result.tabs).toEqual([]);
    expect(store.state.tabs).toEqual([]);
  });

  it("closes the tabs below the anchor for 'right'", async () => {
    const { harness } = createHost();
    const result = await harness.behavior.callRpc("tabs_close_mode", {
      threadId: THREAD,
      mode: "right",
      anchorId: "a",
    });
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["a"]);
  });

  it("keeps only the anchor for 'others'", async () => {
    const { harness } = createHost();
    const result = await harness.behavior.callRpc("tabs_close_mode", {
      threadId: THREAD,
      mode: "others",
      anchorId: "c",
    });
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["c"]);
  });

  it("writes nothing when the mode selects no tabs", async () => {
    const { harness, store } = createHost();
    const result = await harness.behavior.callRpc("tabs_close_mode", {
      threadId: THREAD,
      mode: "right",
      anchorId: "c",
    });
    expect(result.outcome).toBe("updated");
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe("tabs_reorder", () => {
  it("moves a tab to the requested index", async () => {
    const { harness } = createHost();
    const result = await harness.behavior.callRpc("tabs_reorder", {
      threadId: THREAD,
      expectedRevision: 4,
      tabId: "c",
      toIndex: 0,
    });
    expect(result.outcome).toBe("updated");
    expect(result.tabs.map((tab: PanelTab) => tab.id)).toEqual(["c", "a", "b"]);
  });

  it("refuses a stale reorder", async () => {
    const { harness, store } = createHost();
    const result = await harness.behavior.callRpc("tabs_reorder", {
      threadId: THREAD,
      expectedRevision: 2,
      tabId: "c",
      toIndex: 0,
    });
    expect(result.outcome).toBe("conflict");
    expect(store.update).not.toHaveBeenCalled();
  });

  it("preserves fields this plugin does not understand", async () => {
    const store = createTabStore([
      { id: "a", kind: "thread-info" },
      {
        id: "f",
        kind: "workspace-file-preview",
        path: "src/app.tsx",
        lineRange: { startLineNumber: 2, endLineNumber: 8 },
        projectId: "proj_1",
      },
    ]);
    const { harness } = createHost(store);
    await harness.behavior.callRpc("tabs_reorder", {
      threadId: THREAD,
      expectedRevision: 4,
      tabId: "f",
      toIndex: 0,
    });
    expect(store.state.tabs[0]).toEqual({
      id: "f",
      kind: "workspace-file-preview",
      path: "src/app.tsx",
      lineRange: { startLineNumber: 2, endLineNumber: 8 },
      projectId: "proj_1",
    });
  });
});

describe("bb tabs CLI", () => {
  let harness: ReturnType<typeof createHost>["harness"];
  let store: ReturnType<typeof createTabStore>;

  beforeEach(() => {
    ({ harness, store } = createHost());
  });

  it("lists tabs as JSON", async () => {
    const result = await harness.behavior.runCli(["list", THREAD]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toEqual({ revision: 4, tabs: baseTabs() });
  });

  it("closes every tab with close-all", async () => {
    const result = await harness.behavior.runCli(["close-all", THREAD]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Closed 3 tab(s).");
    expect(store.state.tabs).toEqual([]);
  });

  it("reports a conflict instead of claiming success", async () => {
    store.update.mockRejectedValueOnce(new Error("revision mismatch"));
    const result = await harness.behavior.runCli(["close-all", THREAD]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Tabs changed while closing");
  });

  it("fails when no thread id is given or in context", async () => {
    const result = await harness.behavior.runCli(["list"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No thread id");
  });

  it("rejects an unknown subcommand", async () => {
    const result = await harness.behavior.runCli(["nope", THREAD]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: bb tabs");
  });
});
