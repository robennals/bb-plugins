// The panel's RPC surface. Kept apart from server.ts so app.tsx can import it
// without pulling the server's Node-only code into the browser bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listMarkdownResultSchema } from "./contract";
import { docReadSchema } from "./lib/doc-read";

/** The `threadPanelAction` id in app.tsx. */
export const PANEL_ACTION_ID = "progress-doc";

const failureSchema = z.object({ ok: z.literal(false), message: z.string() });
const chosenSchema = z.union([z.object({ ok: z.literal(true), docPath: z.string() }), failureSchema]);

export const rpcContract = defineRpcContract({
  load: {
    input: z.object({ threadId: z.string(), knownMtimeMs: z.number().nullable() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("unchosen") }),
      /** The thread has no workspace, so there is no machine to read from. */
      z.object({ kind: z.literal("no-machine") }),
      z.object({
        kind: z.literal("chosen"),
        docPath: z.string(),
        /** True when this plugin asked the agent to create the doc. */
        askedAgent: z.boolean(),
        doc: docReadSchema,
      }),
    ]),
  },
  listFiles: {
    input: z.object({ threadId: z.string() }),
    output: z.union([listMarkdownResultSchema, z.object({ kind: z.literal("error"), message: z.string() })]),
  },
  choosePath: {
    input: z.object({ threadId: z.string(), path: z.string() }),
    output: chosenSchema,
  },
  askAgent: {
    input: z.object({ threadId: z.string() }),
    output: chosenSchema,
  },
  forget: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
});

export type LoadResult = z.infer<(typeof rpcContract)["load"]["output"]>;
export type ListFilesResult = z.infer<(typeof rpcContract)["listFiles"]["output"]>;
export type ChosenResult = z.infer<typeof chosenSchema>;
