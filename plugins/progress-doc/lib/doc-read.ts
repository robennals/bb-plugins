// What reading a progress doc can come back with. Shared by the host entry
// that reads it, the server that relays it, and the panel that shows it.
import { z } from "zod";

/** Past this a doc is not a progress doc, and shipping it every poll would hurt. */
export const MAX_DOC_BYTES = 1024 * 1024;

const hostDocReadOptions = [
  z.object({ kind: z.literal("content"), content: z.string(), mtimeMs: z.number() }),
  /** The file still has the modification time the caller already has. */
  z.object({ kind: z.literal("unchanged") }),
  z.object({ kind: z.literal("missing") }),
  z.object({ kind: z.literal("too-large"), bytes: z.number() }),
  /** The path exists but is a directory or something else that isn't a file. */
  z.object({ kind: z.literal("not-a-file") }),
] as const;

/** What the host entry answers when it could read the filesystem. */
export const hostDocReadSchema = z.discriminatedUnion("kind", [...hostDocReadOptions]);
export type HostDocRead = z.infer<typeof hostDocReadSchema>;

/** What the panel gets: the host's answer, or why the host could not be asked. */
export const docReadSchema = z.discriminatedUnion("kind", [
  ...hostDocReadOptions,
  /** The read could not run: host unreachable, permission denied, and so on. */
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type DocRead = z.infer<typeof docReadSchema>;
