// Turning what a person typed or pasted into a path the host can read.
import path from "node:path";

export type PathInput = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Accept an absolute path or one under `~/`, as typed or pasted. Terminals and
 * file managers often copy paths wrapped in quotes or with a trailing newline,
 * so one matching pair of quotes and surrounding whitespace are dropped.
 * Relative paths are refused: there is no directory they could sensibly be
 * relative to.
 */
export function parsePathInput(raw: string): PathInput {
  let value = raw.trim();
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote)) {
    value = value.slice(1, -1).trim();
  }
  if (value === "") return { ok: false, reason: "Enter the path of a markdown file." };
  if (value === "~" || value.startsWith("~/") || value.startsWith("/")) {
    return { ok: true, path: value };
  }
  return {
    ok: false,
    reason: `"${value}" is not an absolute path. Start it with / or ~/.`,
  };
}

/** Replace a leading `~` with the home directory, and normalise the result. */
export function expandHome(input: string, home: string): string {
  if (input === "~") return path.normalize(home);
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return path.normalize(input);
}

export function sortNewestFirst<T extends { mtimeMs: number; name: string }>(files: readonly T[]): T[] {
  return [...files].sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
  );
}
