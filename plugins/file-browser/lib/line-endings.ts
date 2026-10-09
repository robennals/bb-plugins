/**
 * A `<textarea>` hands back its text with every line break as a bare `\n`,
 * whatever the file had. Saving that as it comes would rewrite every line of a
 * Windows-style file and turn a one-word edit into a whole-file diff, so the
 * editor notes the file's convention on the way in and restores it on the way
 * out.
 */

export type LineEnding = "lf" | "crlf";

/**
 * `mixed` is a file that uses both, or a carriage return on its own. There is
 * no convention to restore for one of those, so it is not offered for editing.
 */
export function lineEndingOf(content: string): LineEnding | "mixed" {
  if (!content.includes("\r")) return "lf";
  const withoutCrlf = content.replace(/\r\n/g, "");
  return withoutCrlf.includes("\r") || withoutCrlf.includes("\n") ? "mixed" : "crlf";
}

/** `text` is editor text, so its line breaks are all `\n`. */
export function withLineEnding(text: string, lineEnding: LineEnding): string {
  return lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}
