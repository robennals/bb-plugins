// What the panel shows, folded from successive polls of the doc.
import type { DocRead } from "./doc-read";

export type DocView =
  | { kind: "loading" }
  | Exclude<DocRead, { kind: "unchanged" }>;

/** Poll results only say "unchanged" relative to what we sent, so keep what we have. */
export function nextView(previous: DocView, read: DocRead): DocView {
  return read.kind === "unchanged" ? previous : read;
}

/** The modification time to send with the next poll, so an unchanged file costs nothing. */
export function knownMtime(view: DocView): number | null {
  return view.kind === "content" ? view.mtimeMs : null;
}
