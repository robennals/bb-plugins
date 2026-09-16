import { describe, expect, it } from "vitest";
import {
  approvedBy, classifyPullRequest, latestCheckRuns, normalizeCheck, summarizePullRequest, unaddressedFeedbackFrom,
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
    expect(classifyPullRequest(base({ reviews: [review("danielbachhuber", "CHANGES_REQUESTED")], requestedReviewers: [] }))).toBe("FEEDBACK");
    expect(classifyPullRequest(base({ isDraft: true, reviews: [review("octocat", "APPROVED")] }))).toBe("DRAFT");
    expect(classifyPullRequest(base({ reviews: [review("octocat", "APPROVED")], requestedReviewers: [] }))).toBe("APPROVED");
    expect(classifyPullRequest(base({ reviews: [review("octocat", "APPROVED")], requestedReviewers: ["hubot"] }))).toBe("PART_APPROVED");
    expect(classifyPullRequest(base())).toBe("WAITING");
    expect(classifyPullRequest(base({ requestedReviewers: [], reviewDecision: "" }))).toBe("OPEN");
  });
  // A draft is work in progress, so it stays out of the statuses that head the list
  // however noisy it is: nothing is owed to a reviewer until it is marked ready.
  it("keeps a draft in DRAFT whatever feedback or checks say", () => {
    expect(classifyPullRequest(base({ isDraft: true, reviews: [review("danielbachhuber", "CHANGES_REQUESTED")], requestedReviewers: [] }))).toBe("DRAFT");
    expect(classifyPullRequest(base({ isDraft: true, comments: [comment("danielbachhuber", "2026-08-19T22:00:00Z")] }))).toBe("DRAFT");
    expect(classifyPullRequest(base({ isDraft: true, checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("DRAFT");
    // Merged still wins: a draft cannot be merged, but a merged PR must never read DRAFT.
    expect(classifyPullRequest(base({ isDraft: true, mergedAt: "2026-08-20T10:00:00Z" }))).toBe("MERGED");
  });
  it("part-approves when one reviewer has approved and another is still requested", () => {
    const input = base({ reviews: [review("octocat", "APPROVED")], requestedReviewers: ["hubot"] });
    expect(classifyPullRequest(input)).toBe("PART_APPROVED");
    expect(summarizePullRequest(input, "PART_APPROVED")).toBe("Approved by octocat · still waiting for hubot");
  });
  it("approves without a review decision, as on repositories that require no review", () => {
    const input = base({ reviewDecision: "", reviews: [review("octocat", "APPROVED")], requestedReviewers: [] });
    expect(classifyPullRequest(input)).toBe("APPROVED");
    expect(summarizePullRequest(input, "APPROVED")).toBe("Approved by octocat; all requested reviews are complete");
  });
  it("approves on the review decision alone, for an approval older than the reviews we fetch", () => {
    const input = base({ reviewDecision: "APPROVED", requestedReviewers: [] });
    expect(classifyPullRequest(input)).toBe("APPROVED");
    expect(summarizePullRequest(input, "APPROVED")).toBe("Approved; all requested reviews are complete");
  });
  it("prefers unaddressed feedback over another reviewer's approval", () => {
    const input = base({
      reviewDecision: "", requestedReviewers: [],
      reviews: [review("octocat", "APPROVED"), review("hubot", "CHANGES_REQUESTED")],
    });
    expect(classifyPullRequest(input)).toBe("FEEDBACK");
    expect(summarizePullRequest(input, "FEEDBACK")).toBe("Feedback from hubot needs a response");
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

describe("approvedBy", () => {
  it("keeps only each reviewer's most recent verdict", () => {
    expect(approvedBy(base({ reviews: [
      review("octocat", "APPROVED", "2026-08-19T10:00:00Z"),
      review("octocat", "CHANGES_REQUESTED", "2026-08-19T11:00:00Z"),
    ] }))).toEqual([]);
    expect(approvedBy(base({ reviews: [
      review("octocat", "CHANGES_REQUESTED", "2026-08-19T10:00:00Z"),
      review("octocat", "APPROVED", "2026-08-19T11:00:00Z"),
    ] }))).toEqual(["octocat"]);
  });
  it("does not let a later plain comment retract an approval", () => {
    // Commenting after approving leaves the approval standing on GitHub, so only
    // approvals and changes-requested reviews count as a reviewer's verdict.
    expect(approvedBy(base({ reviews: [
      review("octocat", "APPROVED", "2026-08-19T10:00:00Z"),
      review("octocat", "COMMENTED", "2026-08-19T11:00:00Z"),
    ] }))).toEqual(["octocat"]);
  });
  it("ignores bots and the author's own approval", () => {
    expect(approvedBy(base({ reviews: [
      { ...review("dependabot", "APPROVED"), isBot: true },
      review("robennals", "APPROVED"),
    ] }))).toEqual([]);
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
  it("reports merged and failing states", () => {
    expect(summarizePullRequest(base({ mergedAt: "2026-08-20T10:00:00Z" }), "MERGED")).toBe("Merged 2026-08-20");
    expect(summarizePullRequest(base({ mergedAt: null }), "MERGED")).toBe("Merged");
    expect(summarizePullRequest(base({ checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }), "FAILING")).toBe("1 check is failing");
    expect(summarizePullRequest(base({ checks: [{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "COMPLETED", conclusion: "TIMED_OUT" }] }), "FAILING"))
      .toBe("2 checks are failing");
  });
});
