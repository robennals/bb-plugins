import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PULL_REQUEST_STATUSES } from "./pr-status.js";

export const repositoryNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
export const hostPullRequestSchema = z.object({
  // GitHub's own id for the pull request, which the next refresh asks for its checks by.
  id: z.string(),
  repository: z.string(), number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  status: z.enum(PULL_REQUEST_STATUSES), summary: z.string(),
  isDraft: z.boolean(), headRefName: z.string(), baseRefName: z.string(), createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(),
  // Changes whenever anything the status or summary is built from does, so an equal
  // marker on the next refresh means the saved entry is still right.
  changeMarker: z.string(),
  // The GitHub stack the pull request is in, by its number within the repository, and
  // where in it: position 1 is based on the stack's base branch, 2 on 1, and so on. Read
  // on every refresh, since joining or leaving a stack need not change the pull request.
  // Missing from entries saved before stacks were read.
  stack: z.object({ number: z.number().int().positive(), position: z.number().int().positive() }).nullable().default(null),
  // Set while the status is FEEDBACK: when the newest of that feedback arrived, and what
  // the pull request shows instead while feedback up to then is muted.
  unaddressedFeedback: z.object({
    latestAt: z.string(), statusWhenMuted: z.enum(PULL_REQUEST_STATUSES), summaryWhenMuted: z.string(),
  }).nullable(),
});
export type HostPullRequest = z.infer<typeof hostPullRequestSchema>;
export const hostContract = defineRpcContract({
  listPullRequests: {
    input: z.object({
      repository: repositoryNameSchema,
      mergedWithinDays: z.number().int().min(1).max(90), maximumMergedPullRequests: z.number().int().min(1).max(100),
      // The entries from the last refresh, reused for pull requests that have not changed.
      savedPullRequests: z.array(hostPullRequestSchema),
    }),
    output: z.object({ pullRequests: z.array(hostPullRequestSchema) }),
  },
  // `ref` is what the thread's worktree is created from. `tracksHeadBranch` says it is
  // origin's own branch for the pull request, so the worktree's branch has it as upstream.
  preparePullRequestBranch: {
    input: z.object({
      projectPath: z.string().min(1), repository: repositoryNameSchema, number: z.number().int().positive(),
      headRefName: z.string().min(1),
    }),
    output: z.object({ ref: z.string(), tracksHeadBranch: z.boolean() }),
  },
  renameBranchToPullRequestHead: {
    input: z.object({ worktreePath: z.string().min(1), createdBranch: z.string().min(1), headRefName: z.string().min(1) }),
    output: z.null(),
  },
});
