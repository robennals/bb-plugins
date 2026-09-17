// The tab arithmetic, kept free of the SDK so it can be tested on its own.
import { z } from "zod";

/**
 * BB does not export its panel-tab union, and `threads.tabs.update` validates
 * each tab against a strict server-side schema. Tabs we did not create are kept
 * opaque — `looseObject` round-trips the fields we do not name, so a tab kind
 * this plugin has never heard of survives a read/filter/write untouched. Only
 * `id` and `kind` are ours to rely on.
 */
export const panelTabSchema = z.looseObject({ id: z.string(), kind: z.string() });
export type PanelTab = z.infer<typeof panelTabSchema>;

export const panelTabsSchema = z.object({
  revision: z.number(),
  tabs: z.array(panelTabSchema),
});

/**
 * A `browser` entry in a thread's tab list, as BB's tab schema wants it.
 * Extends `PanelTab` so it can sit in a list beside the opaque tabs BB gave us.
 */
export interface BrowserTab extends PanelTab {
  kind: "browser";
  environmentId: string | null;
  title: string | null;
  url: string;
}

/** Identifies this plugin's transient launcher tab. */
export interface LauncherRef {
  pluginId: string;
  actionId: string;
}

/** Lowercase, dash-separated, safe to embed in a tab id. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The tab id for one pull request. Derived from the url rather than random so
 * a second open recognises the tab it already wrote — and derived from the
 * whole url, not the PR number, because `acme/app#7` and `acme/other#7` are
 * different pull requests that must not share a tab.
 */
export function tabIdFor(pluginId: string, url: string): string {
  return `${slug(pluginId)}-pr-${slug(url.replace(/^https?:\/\//, ""))}`;
}

export function browserTabFor(args: {
  pluginId: string;
  environmentId: string | null;
  url: string;
  number: number;
  title: string;
}): BrowserTab {
  return {
    id: tabIdFor(args.pluginId, args.url),
    kind: "browser",
    environmentId: args.environmentId,
    title: `PR #${args.number} ${args.title}`,
    url: args.url,
  };
}

/**
 * Is this the panel tab whose only job was to launch the lookup? The palette
 * and the panel Actions list can only open a tab, so the lookup runs inside
 * one; on success it is swapped for the browser tab rather than left behind.
 */
export function isLauncherTab(tab: PanelTab, launcher: LauncherRef): boolean {
  return (
    tab.kind === "plugin-panel" &&
    tab.pluginId === launcher.pluginId &&
    tab.actionId === launcher.actionId
  );
}

export interface TabPlan {
  /** The list to write, or null when the thread's tabs are already right. */
  tabs: PanelTab[] | null;
  /** True when the pull request's tab was open before this plan. */
  alreadyOpen: boolean;
}

/**
 * Work out the tab list this thread should have: the pull request's tab
 * present exactly once, and the launcher tab — when there is one to drop —
 * gone, both in a single write so the panel never shows both at once.
 */
export function planTabs(args: {
  current: readonly PanelTab[];
  tab: BrowserTab;
  launcher: LauncherRef | null;
}): TabPlan {
  const { current, tab, launcher } = args;
  const alreadyOpen = current.some((entry) => entry.id === tab.id);
  const kept =
    launcher === null
      ? [...current]
      : current.filter((entry) => !isLauncherTab(entry, launcher));
  const next = alreadyOpen ? kept : [...kept, tab];
  const unchanged =
    next.length === current.length &&
    next.every((entry, index) => entry.id === current[index]?.id);
  return { tabs: unchanged ? null : next, alreadyOpen };
}
