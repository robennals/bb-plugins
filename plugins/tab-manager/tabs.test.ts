import { describe, expect, it } from "vitest";
import {
  describeTab,
  panelTabSchema,
  removeTabs,
  reorderTabs,
  tabIdsToClose,
  terminalIdsIn,
  type PanelTab,
} from "./tabs.js";

function tab(id: string, kind: string, extra: Record<string, unknown> = {}): PanelTab {
  return { id, kind, ...extra };
}

const tabs: PanelTab[] = [
  tab("a", "thread-info"),
  tab("b", "git-diff"),
  tab("c", "terminal", { terminalId: "term_1" }),
  tab("d", "browser", { url: "https://example.com", title: "Example" }),
];

describe("panelTabSchema", () => {
  it("preserves fields it does not name so a tab survives a round trip", () => {
    const parsed = panelTabSchema.parse({
      id: "x",
      kind: "workspace-file-preview",
      path: "src/app.tsx",
      lineRange: { startLineNumber: 3, endLineNumber: 9 },
      statusLabel: null,
    });
    expect(parsed).toEqual({
      id: "x",
      kind: "workspace-file-preview",
      path: "src/app.tsx",
      lineRange: { startLineNumber: 3, endLineNumber: 9 },
      statusLabel: null,
    });
  });

  it("accepts a kind this plugin has never heard of", () => {
    expect(panelTabSchema.parse({ id: "x", kind: "future-kind" }).kind).toBe("future-kind");
  });
});

describe("describeTab", () => {
  it("names BB's fixed tabs", () => {
    expect(describeTab(tab("a", "thread-info")).label).toBe("Thread info");
    expect(describeTab(tab("b", "git-diff")).label).toBe("Git diff");
    expect(describeTab(tab("n", "new-tab")).label).toBe("New tab");
  });

  it("prefers a browser tab's title and keeps the url as detail", () => {
    expect(describeTab(tab("d", "browser", { url: "https://example.com", title: "Example" })))
      .toEqual({ label: "Example", detail: "https://example.com" });
  });

  it("falls back to the url when a browser tab has no title", () => {
    expect(describeTab(tab("d", "browser", { url: "https://example.com", title: null })))
      .toEqual({ label: "https://example.com", detail: "https://example.com" });
  });

  it("shows a file's basename with its full path as detail", () => {
    expect(describeTab(tab("f", "host-file-preview", { path: "/home/me/notes/todo.md" })))
      .toEqual({ label: "todo.md", detail: "/home/me/notes/todo.md" });
  });

  it("labels a terminal with its working directory when it has one", () => {
    expect(
      describeTab(tab("c", "terminal", { target: { kind: "host_path", cwd: "/work/repo" } })),
    ).toEqual({ label: "Terminal", detail: "/work/repo" });
    expect(describeTab(tab("c", "terminal", { target: { kind: "thread", threadId: "t" } })))
      .toEqual({ label: "Terminal", detail: null });
  });

  it("credits a plugin panel to its plugin", () => {
    expect(describeTab(tab("p", "plugin-panel", { title: "Issue 42", pluginId: "linear" })))
      .toEqual({ label: "Issue 42", detail: "linear" });
  });

  it("falls back to a generic name for a side chat with no title", () => {
    expect(describeTab(tab("s", "side-chat", { title: "" })))
      .toEqual({ label: "Side chat", detail: "Side chat" });
  });

  it("humanizes an unknown kind rather than showing it raw", () => {
    expect(describeTab(tab("z", "some-new-kind")).label).toBe("Some new kind");
  });
});

describe("tabIdsToClose", () => {
  it("closes every tab for 'all', ignoring the anchor", () => {
    expect(tabIdsToClose(tabs, "all", null)).toEqual(["a", "b", "c", "d"]);
    expect(tabIdsToClose(tabs, "all", "b")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps only the anchor for 'others'", () => {
    expect(tabIdsToClose(tabs, "others", "b")).toEqual(["a", "c", "d"]);
  });

  it("closes only what follows the anchor for 'right'", () => {
    expect(tabIdsToClose(tabs, "right", "b")).toEqual(["c", "d"]);
    expect(tabIdsToClose(tabs, "right", "d")).toEqual([]);
  });

  it("closes nothing when the anchor is missing or absent", () => {
    expect(tabIdsToClose(tabs, "right", "missing")).toEqual([]);
    expect(tabIdsToClose(tabs, "others", null)).toEqual([]);
  });
});

describe("removeTabs", () => {
  it("drops the named tabs and keeps the rest in order", () => {
    expect(removeTabs(tabs, ["b", "d"]).map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("ignores ids that are not present", () => {
    expect(removeTabs(tabs, ["missing"]).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("reorderTabs", () => {
  it("moves a tab to the requested index", () => {
    expect(reorderTabs(tabs, "d", 0).map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
    expect(reorderTabs(tabs, "a", 2).map((entry) => entry.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("is a no-op when the tab is already at that index", () => {
    expect(reorderTabs(tabs, "b", 1).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the order alone for an unknown id or an out-of-range index", () => {
    expect(reorderTabs(tabs, "missing", 0).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(reorderTabs(tabs, "a", 9).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(reorderTabs(tabs, "a", -1).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("terminalIdsIn", () => {
  it("returns terminal ids only for the tabs being removed", () => {
    expect(terminalIdsIn(tabs, ["c", "d"])).toEqual(["term_1"]);
    expect(terminalIdsIn(tabs, ["a", "b"])).toEqual([]);
  });

  it("skips a terminal tab with no terminal id", () => {
    expect(terminalIdsIn([tab("c", "terminal")], ["c"])).toEqual([]);
  });
});
