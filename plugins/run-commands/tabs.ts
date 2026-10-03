// The tab arithmetic, kept free of the SDK so it can be tested on its own.
import { z } from "zod";

/**
 * BB does not export its panel-tab union, and `threads.tabs.update` validates
 * each tab against a strict server-side schema. Tabs we did not create are kept
 * opaque — `looseObject` round-trips the fields we do not name, so a tab kind
 * this plugin has never heard of survives a read/write untouched. Only `id`
 * and `kind` are ours to rely on.
 */
export const panelTabSchema = z.looseObject({ id: z.string(), kind: z.string() });
export type PanelTab = z.infer<typeof panelTabSchema>;

export const panelTabsSchema = z.object({
  revision: z.number(),
  tabs: z.array(panelTabSchema),
});

/** Lowercase, dash-separated, safe to embed in a tab id. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A browser tab for the address a command serves. The id is derived from the
 * address, so running the command again finds the tab it opened last time.
 */
export function browserTabFor(args: {
  pluginId: string;
  environmentId: string | null;
  url: string;
  title: string;
}): PanelTab {
  return {
    id: `${slug(args.pluginId)}-web-${slug(args.url.replace(/^https?:\/\//, ""))}`,
    kind: "browser",
    environmentId: args.environmentId,
    title: args.title,
    url: args.url,
  };
}

/** The thread's tabs with `tab` added, or null when it is already there. */
export function withTab(current: readonly PanelTab[], tab: PanelTab): PanelTab[] | null {
  return current.some((entry) => entry.id === tab.id) ? null : [...current, tab];
}
