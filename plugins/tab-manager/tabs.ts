import { z } from "zod";

/**
 * BB does not export its panel-tab union, and `threads.tabs.update` validates
 * each tab against a strict server-side schema. So we keep every tab object
 * opaque — `looseObject` preserves the fields we do not name, letting a tab
 * survive a read/filter/write round trip even when BB adds fields or kinds we
 * have never heard of. Only `id` and `kind` are ours to rely on.
 */
export const panelTabSchema = z.looseObject({ id: z.string(), kind: z.string() });
export type PanelTab = z.infer<typeof panelTabSchema>;

export const panelTabsSchema = z.object({
  revision: z.number(),
  tabs: z.array(panelTabSchema),
});
export type PanelTabs = z.infer<typeof panelTabsSchema>;

export type CloseMode = "all" | "others" | "right";

/** A tab row as the popover draws it. */
export interface TabDescription {
  label: string;
  detail: string | null;
}

function optionalString(tab: PanelTab, key: string): string | null {
  const value = tab[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

function terminalDetail(tab: PanelTab): string | null {
  const target = tab.target;
  if (target === null || typeof target !== "object") return null;
  const cwd = (target as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/** Turn a kind we do not know about into something readable: "foo-bar" → "Foo bar". */
function humanizeKind(kind: string): string {
  const spaced = kind.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function describeTab(tab: PanelTab): TabDescription {
  switch (tab.kind) {
    case "thread-info":
      return { label: "Thread info", detail: null };
    case "git-diff":
      return { label: "Git diff", detail: null };
    case "new-tab":
      return { label: "New tab", detail: null };
    case "plugin-panel":
      return {
        label: optionalString(tab, "title") ?? "Plugin panel",
        detail: optionalString(tab, "pluginId"),
      };
    case "browser": {
      const url = optionalString(tab, "url");
      return { label: optionalString(tab, "title") ?? url ?? "Browser", detail: url };
    }
    case "side-chat":
      return { label: optionalString(tab, "title") ?? "Side chat", detail: "Side chat" };
    case "terminal":
      return { label: "Terminal", detail: terminalDetail(tab) };
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview": {
      const path = optionalString(tab, "path");
      if (path === null) return { label: "File", detail: null };
      return { label: basename(path), detail: path };
    }
    default:
      return { label: humanizeKind(tab.kind), detail: null };
  }
}

/**
 * Ids a bulk close should remove. An anchor that is not in `tabs` closes
 * nothing for the anchored modes rather than guessing at a position.
 */
export function tabIdsToClose(
  tabs: readonly PanelTab[],
  mode: CloseMode,
  anchorId: string | null,
): string[] {
  if (mode === "all") return tabs.map((tab) => tab.id);
  if (anchorId === null) return [];
  const anchorIndex = tabs.findIndex((tab) => tab.id === anchorId);
  if (anchorIndex === -1) return [];
  if (mode === "others") return tabs.filter((tab) => tab.id !== anchorId).map((tab) => tab.id);
  return tabs.slice(anchorIndex + 1).map((tab) => tab.id);
}

export function removeTabs(tabs: readonly PanelTab[], tabIds: readonly string[]): PanelTab[] {
  const removing = new Set(tabIds);
  return tabs.filter((tab) => !removing.has(tab.id));
}

/**
 * Move `tabId` so it lands at `toIndex` in the resulting array. An unknown id
 * or an out-of-range index leaves the order untouched.
 */
export function reorderTabs(
  tabs: readonly PanelTab[],
  tabId: string,
  toIndex: number,
): PanelTab[] {
  const fromIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (fromIndex === -1) return [...tabs];
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= tabs.length) return [...tabs];
  const next = [...tabs];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

/** Terminal ids belonging to the tabs being removed, for session cleanup. */
export function terminalIdsIn(tabs: readonly PanelTab[], tabIds: readonly string[]): string[] {
  const removing = new Set(tabIds);
  const terminalIds: string[] = [];
  for (const tab of tabs) {
    if (!removing.has(tab.id) || tab.kind !== "terminal") continue;
    const terminalId = optionalString(tab, "terminalId");
    if (terminalId !== null) terminalIds.push(terminalId);
  }
  return terminalIds;
}
