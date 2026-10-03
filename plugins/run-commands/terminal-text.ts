// Turning what a terminal prints into plain text worth storing and showing.
// The output view is read-only text, not a terminal emulator, so colour and
// cursor codes are dropped and carriage-return progress lines are collapsed.

// One whole escape sequence: CSI (colours, cursor moves), OSC (window titles,
// links) ended by BEL or ST, or a two-character escape.
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const ESCAPE_AT_START = new RegExp(`^(?:${ESCAPE.source})`);
/** Past this, a "sequence" that never ends is junk, not something to wait for. */
const LONGEST_ESCAPE = 256;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}

/**
 * Strip escapes from text that arrives in pieces. A read can end halfway
 * through a sequence, so a trailing unfinished one is held back as `rest`, to
 * be put in front of the next piece, rather than leaking half of it as text.
 */
export function stripAnsiStreaming(text: string): { plain: string; rest: string } {
  const start = text.lastIndexOf("\u001b");
  const tail = start === -1 ? "" : text.slice(start);
  const unfinished =
    tail !== "" && !ESCAPE_AT_START.test(tail) && tail.length < LONGEST_ESCAPE;
  return unfinished
    ? { plain: stripAnsi(text.slice(0, start)), rest: tail }
    : { plain: stripAnsi(text), rest: "" };
}

/**
 * Has the command printed the address it serves? Compared on host and port
 * only (`localhost:3000`), because that is what dev servers print, with or
 * without a scheme or a trailing path.
 */
export function outputMentions(output: string, url: string): boolean {
  return output.includes(new URL(url).host);
}

/**
 * The text as a terminal would leave it on screen, line by line: a carriage
 * return goes back to the start of the line, so only what was written after
 * the last one survives — which is how a progress bar ends up as one line.
 */
export function displayText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const settled = line.replace(/\r+$/, "");
      return settled.slice(settled.lastIndexOf("\r") + 1);
    })
    .join("\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
