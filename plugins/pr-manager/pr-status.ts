export type PullRequestStatus = "OPEN" | "DRAFT" | "WAITING" | "FAILING" | "FEEDBACK" | "APPROVED" | "MERGED";
export const PULL_REQUEST_STATUSES = ["FAILING", "FEEDBACK", "DRAFT", "OPEN", "WAITING", "APPROVED", "MERGED"] as const;

// An entry of the status check rollup: either a check run (name, workflowName, status,
// conclusion, startedAt) or a commit status (context, state, createdAt).
export interface RollupEntry {
  name?: string; workflowName?: string; context?: string;
  status?: string; conclusion?: string; state?: string; startedAt?: string; createdAt?: string;
}
export interface CheckRun { identity: string; startedAt: string; status: string; conclusion: string }
export interface ReviewInput { author: string; isBot: boolean; state: string; submittedAt: string }
export interface CommentInput { author: string; isBot: boolean; createdAt: string }
export interface PullRequestStatusInput {
  state: string; mergedAt: string | null; isDraft: boolean; reviewDecision: string;
  author: string; requestedReviewers: string[];
  reviews: ReviewInput[]; comments: CommentInput[];
  checks: Array<{ status: string; conclusion: string }>;
}

export function normalizeCheck(check: RollupEntry): CheckRun {
  const state = check.conclusion ?? check.state ?? "";
  const status = check.status ?? (state === "PENDING" || state === "EXPECTED" ? "IN_PROGRESS" : "COMPLETED");
  // Commit statuses identify themselves by context; check runs by name within a workflow.
  const identity = check.context ?? `${check.workflowName ?? ""}/${check.name ?? ""}`;
  return { identity, startedAt: check.startedAt ?? check.createdAt ?? "", status: status.toUpperCase(), conclusion: state.toUpperCase() };
}
// Re-running a check appends another entry to the status check rollup instead of
// replacing the earlier attempt, so the rollup still reports the cancelled run of a
// check that has since passed. GitHub's checks UI (and `gh pr checks`) only show the
// most recent run of each check, so drop the superseded ones the same way.
export function latestCheckRuns(checks: CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const check of checks) {
    const previous = latest.get(check.identity);
    if (previous === undefined || check.startedAt > previous.startedAt) latest.set(check.identity, check);
  }
  return [...latest.values()];
}

const FAILING_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "STALE", "TIMED_OUT"]);
const FEEDBACK_REVIEW_STATES = new Set(["CHANGES_REQUESTED", "COMMENTED"]);
const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Feedback is outstanding until the ball is back in the reviewer's court:
//   - a "changes requested" or "comment" review, unless that reviewer has since been
//     re-requested (GitHub leaves reviewDecision at CHANGES_REQUESTED forever, so the
//     pending re-request is the only signal that it was handled);
//   - a plain PR comment with no review attached, unless the author has commented since.
// Bots and the author's own activity never count as feedback.
export function unaddressedFeedbackFrom(input: PullRequestStatusInput): string[] {
  const reRequested = new Set(input.requestedReviewers.map((reviewer) => reviewer.toLowerCase()));
  const ownComments = input.comments.filter((comment) => sameUser(comment.author, input.author));
  const latestOwnComment = ownComments.reduce((latest, comment) => comment.createdAt > latest ? comment.createdAt : latest, "");
  const reviewers = new Set<string>();
  for (const review of input.reviews) {
    if (review.isBot || sameUser(review.author, input.author)) continue;
    if (!FEEDBACK_REVIEW_STATES.has(review.state.toUpperCase())) continue;
    if (reRequested.has(review.author.toLowerCase())) continue;
    reviewers.add(review.author);
  }
  for (const comment of input.comments) {
    if (comment.isBot || sameUser(comment.author, input.author)) continue;
    if (comment.createdAt <= latestOwnComment) continue;
    reviewers.add(comment.author);
  }
  return [...reviewers];
}

export function classifyPullRequest(input: PullRequestStatusInput): PullRequestStatus {
  if (input.state === "MERGED" || input.mergedAt !== null) return "MERGED";
  if (input.checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) return "FAILING";
  if (unaddressedFeedbackFrom(input).length > 0) return "FEEDBACK";
  if (input.isDraft) return "DRAFT";
  if (input.reviewDecision === "APPROVED" && input.requestedReviewers.length === 0) return "APPROVED";
  return input.requestedReviewers.length > 0 ? "WAITING" : "OPEN";
}

export function summarizePullRequest(input: PullRequestStatusInput, status: PullRequestStatus): string {
  const failing = input.checks.filter((check) => FAILING_CONCLUSIONS.has(check.conclusion)).length;
  const pending = input.checks.filter((check) => check.status !== "COMPLETED").length;
  const running = pending > 0 ? ` · ${pending} ${pending === 1 ? "check" : "checks"} running` : "";
  switch (status) {
    case "MERGED": return input.mergedAt === null ? "Merged" : `Merged ${input.mergedAt.slice(0, 10)}`;
    case "FAILING": return `${failing} ${failing === 1 ? "check is" : "checks are"} failing`;
    case "FEEDBACK": return `Feedback from ${unaddressedFeedbackFrom(input).join(", ")} needs a response`;
    case "APPROVED": return "Approved; all requested reviews are complete";
    case "DRAFT": return `Draft; mark it ready for review when it is${running}`;
    case "OPEN": return `No review requested yet${running}`;
    case "WAITING": return `Waiting for ${input.requestedReviewers.join(", ")}${running}`;
  }
}
