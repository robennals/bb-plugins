import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { tabIdFor, type PanelTab } from "./pr-tab.js";
import plugin, { LAUNCHER_ACTION_ID, type OpenResult } from "./server.js";

const PLUGIN = "branch-pr";
const THREAD = "thr_1";
const ENVIRONMENT = "env_1";
const URL = "https://github.com/acme/app/pull/7";
const PR_TAB_ID = tabIdFor(PLUGIN, URL);

const infoTab: PanelTab = { id: "a", kind: "thread-info" };

function launcherTab(): PanelTab {
  return {
    id: "panel_1",
    kind: "plugin-panel",
    pluginId: PLUGIN,
    actionId: LAUNCHER_ACTION_ID,
    title: "Pull request",
  };
}

/**
 * A stand-in for BB's tab store. `update` enforces the same revision check the
 * real one does, so the compare-and-swap paths are exercised rather than
 * mocked away.
 */
function createTabStore(initial: PanelTab[] = [infoTab], revision = 4) {
  const state = { revision, tabs: initial };
  return {
    state,
    get: vi.fn(async () => ({ revision: state.revision, tabs: state.tabs })),
    update: vi.fn(
      async ({ expectedRevision, tabs }: { expectedRevision: number; tabs: PanelTab[] }) => {
        if (expectedRevision !== state.revision) throw new Error("revision mismatch");
        state.revision += 1;
        state.tabs = tabs;
        return { revision: state.revision, tabs: state.tabs };
      },
    ),
  };
}

type Lookup = { outcome: "available"; pullRequest: { number: number; title: string; url: string } } | { outcome: "absent" } | { outcome: "unavailable"; message: string };

const availablePr: Lookup = {
  outcome: "available",
  pullRequest: { number: 7, title: "Ship it", url: URL },
};

function createHost(options: {
  store?: ReturnType<typeof createTabStore>;
  lookup?: Lookup;
  environmentId?: string | null;
  branchName?: string | null;
  environmentGet?: () => Promise<unknown>;
} = {}) {
  const store = options.store ?? createTabStore();
  const pullRequest = vi.fn(async () => options.lookup ?? availablePr);
  const environmentGet =
    options.environmentGet ??
    (async () => ({ branchName: options.branchName ?? "feature-branch" }));
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    sdk: {
      threads: {
        get: vi.fn(async () => ({
          environmentId: options.environmentId === undefined ? ENVIRONMENT : options.environmentId,
        })),
        tabs: { get: store.get, update: store.update },
      },
      environments: { pullRequest, get: vi.fn(environmentGet) },
    },
  });
  plugin(bb);
  const open = (fromLauncher = false) =>
    harness.behavior.callRpc("open", { threadId: THREAD, fromLauncher }) as Promise<OpenResult>;
  return { harness, store, pullRequest, open };
}

describe("a branch with a pull request", () => {
  it("adds a browser tab for it and reports what it opened", async () => {
    const { store, open } = createHost();
    await expect(open()).resolves.toEqual({
      outcome: "opened",
      number: 7,
      title: "Ship it",
      url: URL,
    });
    expect(store.state.tabs).toEqual([
      infoTab,
      { id: PR_TAB_ID, kind: "browser", environmentId: ENVIRONMENT, title: "PR #7 Ship it", url: URL },
    ]);
  });

  it("does not open a second tab when one is already there", async () => {
    const { store, open } = createHost();
    await open();
    const tabsAfterFirst = store.state.tabs;
    await expect(open()).resolves.toMatchObject({ outcome: "already-open", number: 7 });
    expect(store.state.tabs).toEqual(tabsAfterFirst);
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it("swaps the launcher tab for the browser tab in a single write", async () => {
    const store = createTabStore([infoTab, launcherTab()]);
    const { open } = createHost({ store });
    await expect(open(true)).resolves.toMatchObject({ outcome: "opened" });
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.state.tabs.map((tab) => tab.id)).toEqual([infoTab.id, PR_TAB_ID]);
  });

  it("leaves the launcher tab alone when the call did not come from one", async () => {
    const store = createTabStore([infoTab, launcherTab()]);
    const { open } = createHost({ store });
    await open(false);
    expect(store.state.tabs.map((tab) => tab.id)).toEqual([infoTab.id, "panel_1", PR_TAB_ID]);
  });

  it("retries once when another client wrote the tab list first", async () => {
    const store = createTabStore();
    // Somebody else bumps the revision between our read and our write, exactly
    // once — the retry reads the new revision and succeeds.
    store.get.mockImplementationOnce(async () => {
      const snapshot = { revision: store.state.revision, tabs: store.state.tabs };
      store.state.revision += 1;
      return snapshot;
    });
    const { open } = createHost({ store });
    await expect(open()).resolves.toMatchObject({ outcome: "opened" });
    expect(store.update).toHaveBeenCalledTimes(2);
    expect(store.state.tabs.map((tab) => tab.id)).toEqual([infoTab.id, PR_TAB_ID]);
  });

  it("fails loudly when the tab list keeps moving under it", async () => {
    const store = createTabStore();
    store.get.mockImplementation(async () => {
      const snapshot = { revision: store.state.revision, tabs: store.state.tabs };
      store.state.revision += 1;
      return snapshot;
    });
    const { open } = createHost({ store });
    await expect(open()).rejects.toThrow(/Could not add the pull request tab/);
  });
});

describe("a branch without a pull request", () => {
  it("names the branch and writes no tabs", async () => {
    const { store, open } = createHost({ lookup: { outcome: "absent" }, branchName: "my-feature" });
    await expect(open()).resolves.toEqual({ outcome: "absent", branchName: "my-feature" });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("still answers when the branch name cannot be read", async () => {
    const { open } = createHost({
      lookup: { outcome: "absent" },
      environmentGet: async () => {
        throw new Error("host unreachable");
      },
    });
    await expect(open()).resolves.toEqual({ outcome: "absent", branchName: null });
  });
});

describe("when there is nothing to look up", () => {
  it("reports no branch for a thread with no workspace", async () => {
    const { pullRequest, open } = createHost({ environmentId: null });
    await expect(open()).resolves.toEqual({ outcome: "no-branch" });
    expect(pullRequest).not.toHaveBeenCalled();
  });
});

describe("when the lookup itself fails", () => {
  it("passes the reason through instead of claiming there is no pull request", async () => {
    const { store, open } = createHost({
      lookup: { outcome: "unavailable", message: "gh is not authenticated" },
    });
    await expect(open()).resolves.toEqual({
      outcome: "unavailable",
      message: "gh is not authenticated",
    });
    expect(store.update).not.toHaveBeenCalled();
  });
});
