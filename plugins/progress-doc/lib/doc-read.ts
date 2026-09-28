// What reading a progress doc can come back with. Shared by the host entry
// that reads it, the server that relays it, and the panel that shows it.
import { z } from "zod";

/** Past this a doc is not a progress doc, and shipping it every poll would hurt. */
export const MAX_DOC_BYTES = 1024 * 1024;

export const docReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("content"), content: z.string(), mtimeMs: z.number() }),
  /** The file still has the modification time the caller already has. */
  z.object({ kind: z.literal("unchanged") }),
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("too-large"), bytes: z.number() }),
  /** The path exists but is a directory or something else that isn't a file. */
  z.object({ kind: z.literal("not-a-file") }),
  /** The read could not run: host unreachable, permission denied, and so on. */
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export type DocRead = z.infer<typeof docReadSchema>;
