import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PULL_REQUEST_STATUSES } from "./pr-status.js";

export const repositoryNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const normalizedPullRequestSchema = z.object({
  // GitHub's own id for the pull request, which the next refresh asks for its checks by.
  id: z.string(),
  repository: z.string(), number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  status: z.enum(PULL_REQUEST_STATUSES), summary: z.string(),
  isDraft: z.boolean(), headRefName: z.string(), baseRefName: z.string(), createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(),
  // Changes whenever anything the status or summary is built from does, so an equal
  // marker on the next refresh means the saved entry is still right.
  changeMarker: z.string(),
});
export type HostPullRequest = z.infer<typeof normalizedPullRequestSchema>;
export const hostContract = defineRpcContract({
  listPullRequests: {
    input: z.object({
      repository: repositoryNameSchema,
      mergedWithinDays: z.number().int().min(1).max(90), maximumMergedPullRequests: z.number().int().min(1).max(100),
      // The entries from the last refresh, reused for pull requests that have not changed.
      savedPullRequests: z.array(normalizedPullRequestSchema),
    }),
    output: z.object({ pullRequests: z.array(normalizedPullRequestSchema) }),
  },
  preparePullRequestBranch: {
    input: z.object({ projectPath: z.string().min(1), repository: repositoryNameSchema, number: z.number().int().positive() }),
    output: z.object({ ref: z.string() }),
  },
});
