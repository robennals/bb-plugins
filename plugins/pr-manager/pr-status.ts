export type PullRequestStatus = "WAITING" | "FAILING" | "FEEDBACK" | "APPROVED" | "MERGED";
export interface PullRequestStatusInput {
  state: string; mergedAt: string | null; isDraft: boolean; reviewDecision: string;
  requestedReviewers: string[]; approvedBy: string[]; changesRequestedBy: string[]; checks: Array<{ status: string; conclusion: string }>;
}
const FAILING_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "STALE", "TIMED_OUT"]);
function hasChangesRequested(input: PullRequestStatusInput): boolean {
  return input.changesRequestedBy.length > 0 || input.reviewDecision === "CHANGES_REQUESTED";
}
function isApproved(input: PullRequestStatusInput): boolean {
  return input.approvedBy.length > 0 || input.reviewDecision === "APPROVED";
}
export function classifyPullRequest(input: PullRequestStatusInput): PullRequestStatus {
  if (input.state === "MERGED" || input.mergedAt !== null) return "MERGED";
  if (input.checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) return "FAILING";
  if (hasChangesRequested(input)) return "FEEDBACK";
  if (isApproved(input)) return "APPROVED";
  return "WAITING";
}
export function summarizePullRequest(input: PullRequestStatusInput, status: PullRequestStatus): string {
  const failing = input.checks.filter((check) => FAILING_CONCLUSIONS.has(check.conclusion)).length;
  const pending = input.checks.filter((check) => check.status !== "COMPLETED").length;
  switch (status) {
    case "MERGED": return input.mergedAt === null ? "Merged" : `Merged ${input.mergedAt.slice(0, 10)}`;
    case "FAILING": return `${failing} ${failing === 1 ? "check is" : "checks are"} failing`;
    case "FEEDBACK": return input.changesRequestedBy.length > 0
      ? `Changes requested by ${input.changesRequestedBy.join(", ")}; feedback needs a response`
      : "Changes requested; feedback needs a response";
    case "APPROVED": {
      const approval = input.approvedBy.length > 0 ? `Approved by ${input.approvedBy.join(", ")}` : "Approved";
      const outstanding = input.requestedReviewers.length > 0
        ? `${approval} · still waiting for ${input.requestedReviewers.join(", ")}`
        : `${approval}; all requested reviews are complete`;
      return input.isDraft ? `Draft · ${outstanding}` : outstanding;
    }
    case "WAITING": {
      const review = input.requestedReviewers.length > 0 ? `Waiting for ${input.requestedReviewers.join(", ")}` : "Waiting for review";
      if (input.isDraft) return `Draft · ${review}`;
      return pending > 0 ? `${review} · ${pending} ${pending === 1 ? "check" : "checks"} running` : review;
    }
  }
}
