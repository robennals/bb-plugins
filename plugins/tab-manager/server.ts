import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { messageOf } from "./errors.js";
import {
  panelTabSchema,
  removeTabs,
  reorderTabs,
  tabIdsToClose,
  terminalIdsIn,
  type PanelTab,
} from "./tabs.js";

const closeModeSchema = z.enum(["all", "others", "right"]);

/**
 * Every mutation answers with the tab list the caller should now draw. On
 * "conflict" the tabs are BB's current ones — somebody opened or closed a tab
 * between our read and our write, so the caller redraws instead of clobbering.
 */
const mutationResultSchema = z.object({
  outcome: z.enum(["updated", "conflict"]),
  revision: z.number(),
  tabs: z.array(panelTabSchema),
  /** Non-fatal: tabs closed, but these terminal sessions would not die. */
  terminalWarnings: z.array(z.string()),
});
export type TabMutationResult = z.infer<typeof mutationResultSchema>;

const tabsSchema = z.object({ revision: z.number(), tabs: z.array(panelTabSchema) });

export const rpcContract = defineRpcContract({
  tabs_list: { input: z.object({ threadId: z.string() }), output: tabsSchema },
  tabs_close: {
    input: z.object({
      threadId: z.string(),
      expectedRevision: z.number(),
      tabIds: z.array(z.string()),
    }),
    output: mutationResultSchema,
  },
  tabs_close_mode: {
    input: z.object({
      threadId: z.string(),
      mode: closeModeSchema,
      anchorId: z.string().nullable(),
    }),
    output: mutationResultSchema,
  },
  tabs_reorder: {
    input: z.object({
      threadId: z.string(),
      expectedRevision: z.number(),
      tabId: z.string(),
      toIndex: z.number().int(),
    }),
    output: mutationResultSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  async function readTabs(threadId: string) {
    const current = await bb.sdk.threads.tabs.get({ threadId });
    return tabsSchema.parse(current);
  }

  function conflict(current: { revision: number; tabs: PanelTab[] }): TabMutationResult {
    return { outcome: "conflict", revision: current.revision, tabs: current.tabs, terminalWarnings: [] };
  }

  function unchanged(current: { revision: number; tabs: PanelTab[] }): TabMutationResult {
    return { outcome: "updated", revision: current.revision, tabs: current.tabs, terminalWarnings: [] };
  }

  /**
   * Closing a terminal tab kills its session — a tab strip entry is the only
   * handle the user has on it, so leaving the shell running would strand it.
   * Failures are reported, never thrown: the tabs are already gone.
   */
  async function closeTerminals(
    tabsBefore: readonly PanelTab[],
    closedIds: readonly string[],
  ): Promise<string[]> {
    const warnings: string[] = [];
    for (const terminalId of terminalIdsIn(tabsBefore, closedIds)) {
      try {
        await bb.sdk.terminals.close({ terminalId, mode: "force" });
      } catch (cause) {
        const reason = messageOf(cause);
        bb.log.warn(`could not close terminal ${terminalId}: ${reason}`);
        warnings.push(`Terminal session ${terminalId} could not be closed: ${reason}`);
      }
    }
    return warnings;
  }

  async function writeTabs(
    threadId: string,
    expectedRevision: number,
    tabs: PanelTab[],
  ): Promise<TabMutationResult | null> {
    try {
      // The one place our deliberately-opaque tab objects meet BB's strict tab
      // union. We never construct a tab — only filter and reorder ones BB gave
      // us — so the values are exactly what the SDK type demands even though
      // `looseObject` cannot prove it. Derived from the SDK signature so this
      // breaks loudly if the argument shape ever changes.
      const sdkTabs = tabs as Parameters<typeof bb.sdk.threads.tabs.update>[0]["tabs"];
      const updated = await bb.sdk.threads.tabs.update({ threadId, expectedRevision, tabs: sdkTabs });
      const parsed = tabsSchema.parse(updated);
      return { outcome: "updated", revision: parsed.revision, tabs: parsed.tabs, terminalWarnings: [] };
    } catch (cause) {
      bb.log.warn(`tab update rejected for ${threadId}: ${messageOf(cause)}`);
      return null;
    }
  }

  async function applyClose(
    threadId: string,
    expectedRevision: number,
    current: { revision: number; tabs: PanelTab[] },
    tabIds: string[],
  ): Promise<TabMutationResult> {
    if (current.revision !== expectedRevision) return conflict(current);
    const result = await writeTabs(threadId, expectedRevision, removeTabs(current.tabs, tabIds));
    if (result === null) return conflict(await readTabs(threadId));
    return { ...result, terminalWarnings: await closeTerminals(current.tabs, tabIds) };
  }

  bb.rpc.register(rpcContract, {
    async tabs_list({ threadId }) {
      return await readTabs(threadId);
    },

    async tabs_close({ threadId, expectedRevision, tabIds }) {
      const current = await readTabs(threadId);
      return await applyClose(threadId, expectedRevision, current, tabIds);
    },

    // Resolves the mode against whatever BB has right now, so a caller with no
    // revision in hand (the command palette) can still close safely.
    async tabs_close_mode({ threadId, mode, anchorId }) {
      const current = await readTabs(threadId);
      const tabIds = tabIdsToClose(current.tabs, mode, anchorId);
      if (tabIds.length === 0) return unchanged(current);
      return await applyClose(threadId, current.revision, current, tabIds);
    },

    async tabs_reorder({ threadId, expectedRevision, tabId, toIndex }) {
      const current = await readTabs(threadId);
      if (current.revision !== expectedRevision) return conflict(current);
      const result = await writeTabs(threadId, expectedRevision, reorderTabs(current.tabs, tabId, toIndex));
      return result ?? conflict(await readTabs(threadId));
    },
  });

  bb.cli.register({
    name: "tabs",
    summary: "Inspect and close a thread's right-panel tabs",
    commands: [
      { name: "list", summary: "List a thread's panel tabs", usage: "bb tabs list <threadId>" },
      {
        name: "close-all",
        summary: "Close every panel tab in a thread",
        usage: "bb tabs close-all <threadId>",
      },
    ],
    async run(argv, ctx) {
      const [command, threadIdArg] = argv;
      const threadId = threadIdArg ?? ctx.threadId;
      if (threadId === undefined || threadId === null) {
        return { exitCode: 1, stderr: "No thread id given and no thread in context.\n" };
      }
      if (command === "list") {
        return { exitCode: 0, stdout: `${JSON.stringify(await readTabs(threadId), null, 2)}\n` };
      }
      if (command === "close-all") {
        const current = await readTabs(threadId);
        const result = await applyClose(
          threadId,
          current.revision,
          current,
          tabIdsToClose(current.tabs, "all", null),
        );
        return result.outcome === "conflict"
          ? { exitCode: 1, stderr: "Tabs changed while closing; try again.\n" }
          : { exitCode: 0, stdout: `Closed ${current.tabs.length} tab(s).\n` };
      }
      return { exitCode: 1, stderr: "Usage: bb tabs <list|close-all> [threadId]\n" };
    },
  });
}
