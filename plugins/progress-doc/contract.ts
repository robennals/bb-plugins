import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostDocReadSchema } from "./lib/doc-read";

/**
 * The progress doc lives on the machine that holds the thread's workspace,
 * which is not always the machine BB's server runs on — so every file read
 * goes through the host entry rather than `node:fs` in the server bundle.
 */

export const markdownFileSchema = z.object({
  name: z.string(),
  /** Absolute. */
  path: z.string(),
  mtimeMs: z.number(),
});
export type MarkdownFile = z.infer<typeof markdownFileSchema>;

export const listMarkdownResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), dir: z.string(), files: z.array(markdownFileSchema) }),
  z.object({ kind: z.literal("missing"), dir: z.string() }),
]);
export type ListMarkdownResult = z.infer<typeof listMarkdownResultSchema>;

/** `~`, `~/…` or absolute: the server validates with `parsePathInput` before calling. */
const hostPathSchema = z.string().min(1);

export const hostContract = defineRpcContract({
  resolvePath: {
    input: z.object({ path: hostPathSchema }).strict(),
    output: z.object({ path: z.string() }),
  },
  listMarkdown: {
    input: z.object({ dir: hostPathSchema }).strict(),
    output: listMarkdownResultSchema,
  },
  readDoc: {
    input: z.object({ path: hostPathSchema, knownMtimeMs: z.number().nullable() }).strict(),
    output: hostDocReadSchema,
  },
});
