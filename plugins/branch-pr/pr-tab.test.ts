import { describe, expect, it } from "vitest";
import { browserTabFor, isLauncherTab, planTabs, tabIdFor, type PanelTab } from "./pr-tab.js";

const PLUGIN = "branch-pr";
const URL = "https://github.com/acme/app/pull/7";

const launcher = { pluginId: PLUGIN, actionId: "open-branch-pr" };

function launcherTab(id = "panel_1"): PanelTab {
  return { id, kind: "plugin-panel", pluginId: PLUGIN, actionId: "open-branch-pr", title: "Pull request" };
}

function prTab() {
  return browserTabFor({ pluginId: PLUGIN, environmentId: "env_1", url: URL, number: 7, title: "Ship it" });
}

describe("tabIdFor", () => {
  it("is stable for the same pull request", () => {
    expect(tabIdFor(PLUGIN, URL)).toBe(tabIdFor(PLUGIN, URL));
  });

  it("separates the same number in different repositories", () => {
    expect(tabIdFor(PLUGIN, URL)).not.toBe(tabIdFor(PLUGIN, "https://github.com/acme/other/pull/7"));
  });

  it("separates different numbers in the same repository", () => {
    expect(tabIdFor(PLUGIN, URL)).not.toBe(tabIdFor(PLUGIN, "https://github.com/acme/app/pull/8"));
  });

  it("ignores the scheme, so http and https share one tab", () => {
    expect(tabIdFor(PLUGIN, URL)).toBe(tabIdFor(PLUGIN, "http://github.com/acme/app/pull/7"));
  });

  it("contains nothing but lowercase letters, digits and dashes", () => {
    expect(tabIdFor(PLUGIN, "https://git.Acme.Corp/my_app/pull/12")).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("browserTabFor", () => {
  it("builds the browser tab BB's schema wants, titled with the number", () => {
    expect(prTab()).toEqual({
      id: tabIdFor(PLUGIN, URL),
      kind: "browser",
      environmentId: "env_1",
      title: "PR #7 Ship it",
      url: URL,
    });
  });
});

describe("isLauncherTab", () => {
  it("recognises this plugin's launcher tab", () => {
    expect(isLauncherTab(launcherTab(), launcher)).toBe(true);
  });

  it("leaves another plugin's panel tab alone", () => {
    const other = { ...launcherTab(), pluginId: "code-review" };
    expect(isLauncherTab(other, launcher)).toBe(false);
  });

  it("leaves this plugin's other panel tabs alone", () => {
    const other = { ...launcherTab(), actionId: "something-else" };
    expect(isLauncherTab(other, launcher)).toBe(false);
  });
});

describe("planTabs", () => {
  const info: PanelTab = { id: "a", kind: "thread-info" };

  it("appends the pull request tab, keeping the existing ones in order", () => {
    const tab = prTab();
    const plan = planTabs({ current: [info], tab, launcher: null });
    expect(plan).toEqual({ tabs: [info, tab], alreadyOpen: false });
  });

  it("reports an already-open tab and asks for no write", () => {
    const tab = prTab();
    expect(planTabs({ current: [info, tab], tab, launcher: null })).toEqual({
      tabs: null,
      alreadyOpen: true,
    });
  });

  it("swaps the launcher tab for the pull request tab in one write", () => {
    const tab = prTab();
    const plan = planTabs({ current: [info, launcherTab()], tab, launcher });
    expect(plan).toEqual({ tabs: [info, tab], alreadyOpen: false });
  });

  it("drops the launcher tab even when the pull request tab is already open", () => {
    const tab = prTab();
    const plan = planTabs({ current: [info, tab, launcherTab()], tab, launcher });
    expect(plan).toEqual({ tabs: [info, tab], alreadyOpen: true });
  });

  it("drops every launcher tab, not just the first", () => {
    const tab = prTab();
    const current = [info, launcherTab("panel_1"), launcherTab("panel_2")];
    expect(planTabs({ current, tab, launcher }).tabs).toEqual([info, tab]);
  });

  it("keeps tab kinds it has never heard of, field for field", () => {
    const exotic: PanelTab = { id: "x", kind: "hologram", depth: 3, nested: { a: 1 } };
    const tab = prTab();
    expect(planTabs({ current: [exotic], tab, launcher: null }).tabs).toEqual([exotic, tab]);
  });
});
