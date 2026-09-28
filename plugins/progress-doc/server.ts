// bb-plugin-progress-doc — backend.
//
// The panel's RPCs, turned into calls on the host entry that runs on the
// thread's machine. The one piece of state is which doc the thread shows,
// kept in the thread's plugin metadata so re-adding the tab finds it again.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./contract";
import type { DocRead } from "./lib/doc-read";
import { messageOf } from "./lib/errors";
import { DOC_DIRECTORY, docFileName } from "./lib/naming";
import { parsePathInput } from "./lib/paths";
import { DEFAULT_PROMPT, PATH_PLACEHOLDER, fillPrompt } from "./lib/prompt";
import { rpcContract, type ChosenResult, type ListFilesResult, type LoadResult } from "./rpc";

/**
 * The thread's choice, as stored in metadata. Anyone — including the thread's
 * own agent — can write this namespace, so a value is only trusted once it has
 * this shape; anything else reads as "no doc chosen".
 */
const choiceSchema = z.object({
  docPath: z.string().startsWith("/"),
  askedAgent: z.boolean().default(false),
});
type StoredChoice = z.infer<typeof choiceSchema>;

class NoMachineError extends Error {}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    prompt: {
      type: "string",
      label: `Prompt sent when you ask the agent to keep a progress doc (${PATH_PLACEHOLDER} becomes the doc's path)`,
      experimental_multiline: true,
      experimental_schema: z
        .string()
        .refine(
          (value) => value.includes(PATH_PLACEHOLDER),
          `The prompt must contain ${PATH_PLACEHOLDER} so the agent knows where to write.`,
        ),
      default: DEFAULT_PROMPT,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  /** The machine holding the thread's workspace, where its doc lives. */
  async function hostIdFor(thread: { environmentId: string | null }): Promise<string> {
    if (thread.environmentId === null) throw new NoMachineError();
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return environment.hostId;
  }

  async function hostIdOf(threadId: string): Promise<string> {
    return hostIdFor(await bb.sdk.threads.get({ threadId }));
  }

  async function readChoice(threadId: string): Promise<StoredChoice | null> {
    const parsed = choiceSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }));
    return parsed.success ? parsed.data : null;
  }

  async function recordChoice(threadId: string, choice: StoredChoice): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({ threadId, set: choice });
  }

  async function readDoc(hostId: string, docPath: string, knownMtimeMs: number | null): Promise<DocRead> {
    try {
      return await host.call("readDoc", { path: docPath, knownMtimeMs }, { hostId });
    } catch (cause) {
      return { kind: "error", message: messageOf(cause) };
    }
  }

  async function choose(threadId: string, rawPath: string): Promise<ChosenResult> {
    const parsed = parsePathInput(rawPath);
    if (!parsed.ok) return { ok: false, message: parsed.reason };
    try {
      const hostId = await hostIdOf(threadId);
      const { path: docPath } = await host.call("resolvePath", { path: parsed.path }, { hostId });
      await recordChoice(threadId, { docPath, askedAgent: false });
      return { ok: true, docPath };
    } catch (cause) {
      return { ok: false, message: describe(cause) };
    }
  }

  async function askAgent(threadId: string): Promise<ChosenResult> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const hostId = await hostIdFor(thread);
      const fileName = docFileName(thread.title ?? thread.titleFallback, threadId);
      const { path: docPath } = await host.call(
        "resolvePath",
        { path: `${DOC_DIRECTORY}/${fileName}` },
        { hostId },
      );
      const { prompt } = await settings.get();
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: fillPrompt(prompt, docPath), mentions: [] }],
      });
      // Only after the message is on its way: a recorded doc that the agent
      // was never asked for would sit on "waiting for the agent" forever.
      await recordChoice(threadId, { docPath, askedAgent: true });
      return { ok: true, docPath };
    } catch (cause) {
      return { ok: false, message: describe(cause) };
    }
  }

  function describe(cause: unknown): string {
    return cause instanceof NoMachineError
      ? "This thread has no workspace yet, so there is no machine to keep a doc on."
      : messageOf(cause);
  }

  bb.rpc.register(rpcContract, {
    load: async ({ threadId, knownMtimeMs }): Promise<LoadResult> => {
      const choice = await readChoice(threadId);
      if (choice === null) return { kind: "unchosen" };
      let hostId: string;
      try {
        hostId = await hostIdOf(threadId);
      } catch (cause) {
        if (cause instanceof NoMachineError) return { kind: "no-machine" };
        throw cause;
      }
      return {
        kind: "chosen",
        docPath: choice.docPath,
        askedAgent: choice.askedAgent,
        doc: await readDoc(hostId, choice.docPath, knownMtimeMs),
      };
    },
    listFiles: async ({ threadId }): Promise<ListFilesResult> => {
      try {
        const hostId = await hostIdOf(threadId);
        return await host.call("listMarkdown", { dir: DOC_DIRECTORY }, { hostId });
      } catch (cause) {
        return { kind: "error", message: describe(cause) };
      }
    },
    choosePath: ({ threadId, path }) => choose(threadId, path),
    askAgent: ({ threadId }) => askAgent(threadId),
    forget: async ({ threadId }) => {
      await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["docPath", "askedAgent"] });
      return { ok: true as const };
    },
  });
}
