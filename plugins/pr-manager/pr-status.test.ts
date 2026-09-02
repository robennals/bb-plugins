import { describe, expect, it } from "vitest";
import {
  classifyPullRequest, latestCheckRuns, normalizeCheck, summarizePullRequest, unaddressedFeedbackFrom,
  type PullRequestStatusInput, type RollupEntry,
} from "./pr-status.js";
const rollup = (entries: RollupEntry[]) => latestCheckRuns(entries.map(normalizeCheck));
const base = (overrides: Partial<PullRequestStatusInput> = {}): PullRequestStatusInput => ({
  state: "OPEN", mergedAt: null, isDraft: false, reviewDecision: "REVIEW_REQUIRED",
  author: "robennals", requestedReviewers: ["octocat"], reviews: [], comments: [],
  checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }], ...overrides,
});
const review = (author: string, state: string, submittedAt = "2026-08-19T22:00:00Z") => ({ author, isBot: false, state, submittedAt });
const comment = (author: string, createdAt: string, isBot = false) => ({ author, isBot, createdAt });

describe("classifyPullRequest", () => {
  it("uses the intended status priority", () => {
    expect(classifyPullRequest(base({ mergedAt: "2026-08-20T10:00:00Z", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("MERGED");
    expect(classifyPullRequest(base({ reviews: [review("danielbachhuber", "CHANGES_REQUESTED")], requestedReviewers: [], checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("FAILING");
    expect(classifyPullRequest(base({ reviews: [review("danielbachhuber", "CHANGES_REQUESTED")], requestedReviewers: [], isDraft: true }))).toBe("FEEDBACK");
    expect(classifyPullRequest(base({ isDraft: true }))).toBe("DRAFT");
    expect(classifyPullRequest(base({ reviewDecision: "APPROVED", requestedReviewers: [] }))).toBe("APPROVED");
    expect(classifyPullRequest(base())).toBe("WAITING");
    expect(classifyPullRequest(base({ requestedReviewers: [], reviewDecision: "" }))).toBe("OPEN");
  });
  it("keeps partially requested approvals waiting", () => {
    expect(classifyPullRequest(base({ reviewDecision: "APPROVED", requestedReviewers: ["hubot"] }))).toBe("WAITING");
  });
  it("ignores a cancelled check run that a later re-run superseded", () => {
    const checks = rollup([
      { workflowName: "Check PR title", name: "Validate PR title", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-01T20:51:05Z" },
      { workflowName: "Check PR title", name: "Validate PR title", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-01T20:51:15Z" },
    ]);
    expect(checks).toHaveLength(1);
    expect(classifyPullRequest(base({ checks }))).toBe("WAITING");
  });
  it("keeps distinct checks that share a name across workflows", () => {
    const checks = rollup([
      { workflowName: "Test", name: "Identify changed files", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-01T20:51:05Z" },
      { workflowName: "Storybook", name: "Identify changed files", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-01T20:51:03Z" },
    ]);
    expect(checks).toHaveLength(2);
    expect(classifyPullRequest(base({ checks }))).toBe("FAILING");
  });
  it("treats a commit status as pending until it leaves PENDING, keyed by context", () => {
    const checks = rollup([
      { context: "ci/circleci", state: "PENDING", createdAt: "2026-09-01T20:51:05Z" },
      { context: "ci/circleci", state: "SUCCESS", createdAt: "2026-09-01T20:59:05Z" },
    ]);
    expect(checks).toEqual([{ identity: "ci/circleci", startedAt: "2026-09-01T20:59:05Z", status: "COMPLETED", conclusion: "SUCCESS" }]);
    expect(rollup([{ context: "ci/circleci", state: "PENDING", createdAt: "2026-09-01T20:51:05Z" }])[0]!.status).toBe("IN_PROGRESS");
  });
});

describe("unaddressedFeedbackFrom", () => {
  it("clears a changes-requested review once that reviewer is re-requested", () => {
    // PR 5622: GitHub leaves reviewDecision at CHANGES_REQUESTED even after the
    // re-request, so the pending review request is the only thing that clears it.
    const input = base({
      reviewDecision: "CHANGES_REQUESTED", requestedReviewers: ["danielbachhuber"],
      reviews: [review("danielbachhuber", "CHANGES_REQUESTED")],
    });
    expect(unaddressedFeedbackFrom(input)).toEqual([]);
    expect(classifyPullRequest(input)).toBe("WAITING");
  });
  it("reports a changes-requested review that has not been re-requested", () => {
    const input = base({ reviewDecision: "CHANGES_REQUESTED", requestedReviewers: [], reviews: [review("danielbachhuber", "CHANGES_REQUESTED")] });
    expect(unaddressedFeedbackFrom(input)).toEqual(["danielbachhuber"]);
    expect(summarizePullRequest(input, "FEEDBACK")).toBe("Feedback from danielbachhuber needs a response");
  });
  it("treats a comment review like changes requested, and re-requesting clears it too", () => {
    expect(unaddressedFeedbackFrom(base({ requestedReviewers: [], reviews: [review("tilgovi", "COMMENTED")] }))).toEqual(["tilgovi"]);
    expect(unaddressedFeedbackFrom(base({ requestedReviewers: ["tilgovi"], reviews: [review("tilgovi", "COMMENTED")] }))).toEqual([]);
  });
  it("does not treat an approval as feedback", () => {
    expect(unaddressedFeedbackFrom(base({ requestedReviewers: [], reviews: [review("tilgovi", "APPROVED")] }))).toEqual([]);
  });
  it("reports a bare comment until the author comments back", () => {
    const commented = base({ requestedReviewers: [], comments: [comment("tilgovi", "2026-08-19T10:00:00Z")] });
    expect(unaddressedFeedbackFrom(commented)).toEqual(["tilgovi"]);
    const replied = base({ requestedReviewers: [], comments: [comment("tilgovi", "2026-08-19T10:00:00Z"), comment("robennals", "2026-08-19T11:00:00Z")] });
    expect(unaddressedFeedbackFrom(replied)).toEqual([]);
    const commentedAgain = base({ requestedReviewers: [], comments: [comment("robennals", "2026-08-19T11:00:00Z"), comment("tilgovi", "2026-08-19T12:00:00Z")] });
    expect(unaddressedFeedbackFrom(commentedAgain)).toEqual(["tilgovi"]);
  });
  it("ignores bots and the author's own activity", () => {
    // psi-product PRs collect github-actions comments; they are not feedback.
    const input = base({
      requestedReviewers: [],
      comments: [comment("github-actions", "2026-08-18T10:34:01Z", true)],
      reviews: [review("robennals", "COMMENTED")],
    });
    expect(unaddressedFeedbackFrom(input)).toEqual([]);
    expect(classifyPullRequest(input)).toBe("OPEN");
  });
});

describe("summarizePullRequest", () => {
  it("describes the states that need the author to act", () => {
    expect(summarizePullRequest(base({ isDraft: true }), "DRAFT")).toBe("Draft; mark it ready for review when it is");
    expect(summarizePullRequest(base({ requestedReviewers: [] }), "OPEN")).toBe("No review requested yet");
    expect(summarizePullRequest(base({ checks: [{ status: "IN_PROGRESS", conclusion: "" }] }), "WAITING"))
      .toBe("Waiting for octocat · 1 check running");
    expect(summarizePullRequest(base({ isDraft: true, checks: [{ status: "IN_PROGRESS", conclusion: "" }] }), "DRAFT"))
      .toBe("Draft; mark it ready for review when it is · 1 check running");
  });
});
