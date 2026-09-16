import type { ChangedPath, ChangeStatus } from "../contract.js";

/**
 * Parse `git diff --name-status -z <base>`. NUL separation is what makes this
 * safe: a path with a newline, a quote or a non-ASCII byte arrives verbatim
 * instead of being C-quoted, so no unescaping is needed and none can go wrong.
 *
 * Records are `<status>\0<path>\0`, except renames and copies, which are
 * `<status><score>\0<old>\0<new>\0`.
 */
export function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changes: ChangedPath[] = [];

  let index = 0;
  while (index < fields.length) {
    const code = fields[index];
    if (code === undefined || code === "") break;
    index += 1;

    const letter = code[0];
    // R100/C75 carry a similarity score; every other status is a bare letter.
    const isPaired = letter === "R" || letter === "C";
    // `split` leaves a trailing "" after the final separator, so an empty field
    // is the end of the output, not a file — and a record cut short by it is
    // incomplete rather than a change to a file with no name.
    const first = fields[index];
    index += 1;
    if (first === undefined || first === "") break;

    if (isPaired) {
      const second = fields[index];
      index += 1;
      if (second === undefined || second === "") break;
      changes.push({
        path: second,
        // A copy leaves the original in place, so only the new path is "new"
        // work; calling it a rename would imply the source is gone.
        status: letter === "R" ? "renamed" : "added",
        from: letter === "R" ? first : null,
      });
      continue;
    }

    const status = statusForLetter(letter);
    if (status === null) continue;
    changes.push({ path: first, status, from: null });
  }

  return changes;
}

function statusForLetter(letter: string | undefined): ChangeStatus | null {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T": // typechange (symlink ↔ file): still "this differs from the base"
      return "modified";
    // U (unmerged) and X (unknown) are conflict/plumbing states with no useful
    // "what did this branch do" answer; leave them unhighlighted.
    default:
      return null;
  }
}

/** Parse the NUL-separated output of `git ls-files --others --exclude-standard -z`. */
export function parseUntracked(output: string): ChangedPath[] {
  return output
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => ({ path, status: "untracked" as const, from: null }));
}

/**
 * Merge the tracked and untracked listings into one entry per path. The tracked
 * listing wins: git only reports a path as untracked when it is not tracked at
 * all, so an overlap means one of the two views is stale and the tracked one is
 * the one the diff can actually render.
 */
export function mergeChanges(
  tracked: readonly ChangedPath[],
  untracked: readonly ChangedPath[],
): ChangedPath[] {
  const byPath = new Map<string, ChangedPath>();
  for (const change of untracked) byPath.set(change.path, change);
  for (const change of tracked) byPath.set(change.path, change);
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/**
 * Pick the ref to measure the fork point against, from the candidates that
 * exist in this repository. `origin/HEAD` is the reliable answer when the clone
 * has it; the rest are the conventional names, tried in the order a repository
 * is likely to use them.
 */
export function baseRefCandidates(originHead: string | null): string[] {
  const candidates = originHead === null ? [] : [originHead];
  return [
    ...candidates,
    "origin/main",
    "origin/master",
    "origin/develop",
    "main",
    "master",
  ];
}

/** `refs/remotes/origin/main` → `origin/main`; anything else is left alone. */
export function shortenRemoteHead(symbolicRef: string): string | null {
  const trimmed = symbolicRef.trim();
  if (trimmed === "") return null;
  const prefix = "refs/remotes/";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}
