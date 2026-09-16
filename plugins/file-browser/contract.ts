import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Git runs on the machine that holds the workspace, which is not always the
 * machine BB's server runs on — so every git call goes through the host entry
 * rather than through `node:child_process` in the server bundle.
 */

/** One path's standing relative to the commit the branch forked from. */
export const changeStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
]);

export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const changedPathSchema = z.object({
  path: z.string(),
  status: changeStatusSchema,
  /** Previous path for a rename; null otherwise. */
  from: z.string().nullable(),
});

export type ChangedPath = z.infer<typeof changedPathSchema>;

export const branchChangesSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("changes"),
    /** The ref the fork point was computed against, e.g. `origin/main`. */
    baseRef: z.string(),
    /** The merge-base commit itself — what `diff` is asked to compare with. */
    baseCommit: z.string(),
    /** Current branch name, or null on a detached HEAD. */
    branch: z.string().nullable(),
    changes: z.array(changedPathSchema),
  }),
  /** Not a git repository, or git could not answer. Browsing still works. */
  z.object({
    kind: z.literal("unavailable"),
    reason: z.string(),
  }),
]);

export type BranchChanges = z.infer<typeof branchChangesSchema>;

export const hostContract = defineRpcContract({
  branchChanges: {
    input: z
      .object({
        root: z.string().min(1),
        /** Setting override; null asks the host to detect the default branch. */
        baseBranch: z.string().nullable(),
      })
      .strict(),
    output: branchChangesSchema,
  },
  fileDiff: {
    input: z
      .object({
        root: z.string().min(1),
        baseCommit: z.string().min(1),
        /** Workspace-relative, forward-slashed. */
        path: z.string().min(1),
        status: changeStatusSchema,
        from: z.string().nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("patch"),
        patch: z.string(),
        /** Both sides in full, for the diff viewer's expand-context controls. */
        oldContent: z.string().nullable(),
        newContent: z.string().nullable(),
        oldPath: z.string(),
        newPath: z.string(),
      }),
      z.object({ kind: z.literal("unchanged") }),
      z.object({ kind: z.literal("binary") }),
      z.object({ kind: z.literal("error"), reason: z.string() }),
    ]),
  },
});
