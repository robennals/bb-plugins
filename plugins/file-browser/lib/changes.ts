import type { BranchChanges, ChangedPath, ChangeStatus } from "../contract.js";
import { ancestorsOf, normalizeRelative } from "./tree.js";

/** Everything the explorer needs to colour a row, resolved once per listing. */
export interface ChangeIndex {
  /** Files git reported, by workspace-relative path. */
  byPath: ReadonlyMap<string, ChangedPath>;
  /** Every directory with a changed file somewhere beneath it. */
  changedDirectories: ReadonlySet<string>;
  /** Files the branch deleted — they are gone from disk, so not in the tree. */
  deletedPaths: readonly ChangedPath[];
  baseRef: string | null;
  baseCommit: string | null;
  branch: string | null;
  /** Why nothing is highlighted, when git could not answer. */
  unavailable: string | null;
}

export const EMPTY_CHANGE_INDEX: ChangeIndex = {
  byPath: new Map(),
  changedDirectories: new Set(),
  deletedPaths: [],
  baseRef: null,
  baseCommit: null,
  branch: null,
  unavailable: null,
};

export function indexChanges(changes: BranchChanges): ChangeIndex {
  if (changes.kind === "unavailable") {
    return { ...EMPTY_CHANGE_INDEX, unavailable: changes.reason };
  }

  const byPath = new Map<string, ChangedPath>();
  const changedDirectories = new Set<string>();
  const deletedPaths: ChangedPath[] = [];

  for (const change of changes.changes) {
    const path = normalizeRelative(change.path);
    if (path === "") continue;
    const normalized: ChangedPath = { ...change, path };
    byPath.set(path, normalized);
    if (change.status === "deleted") deletedPaths.push(normalized);
    // A folder is "changed" when anything under it is, at any depth — that is
    // what makes a collapsed tree still tell you where the work is.
    for (const ancestor of ancestorsOf(path)) changedDirectories.add(ancestor);
  }

  return {
    byPath,
    changedDirectories,
    deletedPaths,
    baseRef: changes.baseRef,
    baseCommit: changes.baseCommit,
    branch: changes.branch,
    unavailable: null,
  };
}

/**
 * The status to paint a row with. A directory reports `modified` when anything
 * beneath it changed: rolling up the exact mix of adds and deletes would need a
 * vocabulary the one-letter badge does not have.
 */
export function statusForRow(
  index: ChangeIndex,
  path: string,
  kind: "file" | "directory",
): ChangeStatus | null {
  if (kind === "file") return index.byPath.get(path)?.status ?? null;
  return index.changedDirectories.has(path) ? "modified" : null;
}

/** One-letter badge, matching git's own `--name-status` letters. */
export function statusLetter(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "modified":
      return "M";
  }
}

export function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return "Added on this branch";
    case "deleted":
      return "Deleted on this branch";
    case "renamed":
      return "Renamed on this branch";
    case "untracked":
      return "New, not yet tracked by git";
    case "modified":
      return "Modified on this branch";
  }
}

/**
 * Host theme tokens only — `--color-diff-added` and friends follow the user's
 * BB code theme, so the tree agrees with the diff viewer beside it in both
 * light and dark.
 */
export function statusTextClass(status: ChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-diff-added";
    case "deleted":
      return "text-diff-removed";
    case "modified":
    case "renamed":
      return "text-attention";
  }
}
