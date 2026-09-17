// bb-plugin-branch-pr — backend.
//
// One job: find the GitHub pull request for the thread's branch and put a
// browser tab for it in the thread's right-hand panel. BB resolves the pull
// request itself (`environments.pullRequest`), so there is no `gh` plumbing
// here — only the tab write, which is a compare-and-swap against a list BB
// owns and other clients may be editing at the same time.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { messageOf } from "./errors.js";
import { browserTabFor, panelTabsSchema, planTabs } from "./pr-tab.js";

/**
 * The `threadPanelAction` id in app.tsx. The server needs it to recognise the
 * launcher tab it is asked to swap out, so it lives here and app.tsx imports
 * it — one definition, not two that must agree.
 */
export const LAUNCHER_ACTION_ID = "open-branch-pr";

/**
 * Every outcome the UI has a different sentence for.
 *
 * `absent` and `unavailable` stay apart all the way to the surface on purpose:
 * BB's own contract is explicit that a lookup which could not run (gh missing,
 * not signed in, host unreachable) must never be drawn as "this branch has no
 * pull request".
 */
const resultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("opened"),
    number: z.number(),
    title: z.string(),
    url: z.string(),
  }),
  z.object({
    outcome: z.literal("already-open"),
    number: z.number(),
    title: z.string(),
    url: z.string(),
  }),
  /** The host checked, and the branch has no pull request. */
  z.object({ outcome: z.literal("absent"), branchName: z.string().nullable() }),
  /** The thread has no workspace, so there is no branch to look one up for. */
  z.object({ outcome: z.literal("no-branch") }),
  /** The lookup itself failed. Never render this as "no pull request". */
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);
export type OpenResult = z.infer<typeof resultSchema>;

export const rpcContract = defineRpcContract({
  open: {
    input: z.object({
      threadId: z.string(),
      /**
       * True when the call comes from the panel tab the palette and the
       * Actions list open. That tab exists only to run this lookup, so on
       * success it is removed in the same write that adds the browser tab.
       */
      fromLauncher: z.boolean(),
    }),
    output: resultSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  /** The thread's environment, or null when it has no workspace yet. */
  async function environmentIdOf(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.environmentId;
  }

  /** Only wanted on the "no pull request" path, to name the branch in the message. */
  async function branchNameOf(environmentId: string): Promise<string | null> {
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      return environment.branchName;
    } catch (cause) {
      bb.log.warn(`could not read environment ${environmentId}: ${messageOf(cause)}`);
      return null;
    }
  }

  /**
   * Add the pull request's tab, dropping the launcher tab when we were called
   * from one. The tab list is BB's and another client may be writing it, so
   * this is a compare-and-swap: re-read and retry once on rejection, then give
   * up loudly — a silent no-op would leave the user pressing a dead button.
   */
  async function writeTab(
    threadId: string,
    environmentId: string | null,
    pullRequest: { number: number; title: string; url: string },
    fromLauncher: boolean,
  ): Promise<{ alreadyOpen: boolean }> {
    const tab = browserTabFor({ pluginId: bb.pluginId, environmentId, ...pullRequest });
    const launcher = fromLauncher
      ? { pluginId: bb.pluginId, actionId: LAUNCHER_ACTION_ID }
      : null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = panelTabsSchema.parse(await bb.sdk.threads.tabs.get({ threadId }));
      const plan = planTabs({ current: current.tabs, tab, launcher });
      if (plan.tabs === null) return { alreadyOpen: plan.alreadyOpen };
      try {
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          // The one place these deliberately-opaque tab objects meet BB's
          // strict tab union. Every entry is either one BB gave us or the
          // browser tab built above, so the values are exactly what the SDK
          // type demands even though `looseObject` cannot prove it. Derived
          // from the SDK signature so this breaks loudly if the shape moves.
          tabs: plan.tabs as Parameters<typeof bb.sdk.threads.tabs.update>[0]["tabs"],
        });
        return { alreadyOpen: plan.alreadyOpen };
      } catch (cause) {
        lastError = cause;
        bb.log.warn(`tab update rejected for ${threadId}: ${messageOf(cause)}`);
      }
    }
    throw new Error(`Could not add the pull request tab: ${messageOf(lastError)}`);
  }

  async function open(threadId: string, fromLauncher: boolean): Promise<OpenResult> {
    const environmentId = await environmentIdOf(threadId);
    if (environmentId === null) return { outcome: "no-branch" };
    const lookup = await bb.sdk.environments.pullRequest({ environmentId });
    if (lookup.outcome === "unavailable") {
      return { outcome: "unavailable", message: lookup.message };
    }
    if (lookup.outcome === "absent") {
      return { outcome: "absent", branchName: await branchNameOf(environmentId) };
    }
    const { number, title, url } = lookup.pullRequest;
    const { alreadyOpen } = await writeTab(
      threadId,
      environmentId,
      { number, title, url },
      fromLauncher,
    );
    return { outcome: alreadyOpen ? "already-open" : "opened", number, title, url };
  }

  bb.rpc.register(rpcContract, {
    open: ({ threadId, fromLauncher }) => open(threadId, fromLauncher),
  });
}
