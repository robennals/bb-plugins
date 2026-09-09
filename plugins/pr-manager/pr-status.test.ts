import { describe, expect, it } from "vitest";
import { classifyPullRequest, summarizePullRequest, type PullRequestStatusInput } from "./pr-status.js";
const base = (overrides: Partial<PullRequestStatusInput> = {}): PullRequestStatusInput => ({
  state: "OPEN", mergedAt: null, isDraft: false, reviewDecision: "REVIEW_REQUIRED",
  requestedReviewers: ["octocat"], approvedBy: [], changesRequestedBy: [], checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }], ...overrides,
});
describe("classifyPullRequest", () => {
  it("uses the intended status priority", () => {
    expect(classifyPullRequest(base({ mergedAt: "2026-08-20T10:00:00Z", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("MERGED");
    expect(classifyPullRequest(base({ reviewDecision: "CHANGES_REQUESTED", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("FAILING");
    expect(classifyPullRequest(base({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("FEEDBACK");
    expect(classifyPullRequest(base({ reviewDecision: "APPROVED", requestedReviewers: [] }))).toBe("APPROVED");
    expect(classifyPullRequest(base())).toBe("WAITING");
  });
  it("approves on a single review even when another reviewer is still requested", () => {
    const input = base({ approvedBy: ["octocat"], requestedReviewers: ["hubot"] });
    expect(classifyPullRequest(input)).toBe("APPROVED");
    expect(summarizePullRequest(input, "APPROVED")).toBe("Approved by octocat · still waiting for hubot");
  });
  it("approves without a review decision, as on repositories that require no review", () => {
    expect(classifyPullRequest(base({ reviewDecision: "", approvedBy: ["octocat"], requestedReviewers: [] }))).toBe("APPROVED");
  });
  it("prefers requested changes over another reviewer's approval", () => {
    const input = base({ reviewDecision: "", approvedBy: ["octocat"], changesRequestedBy: ["hubot"] });
    expect(classifyPullRequest(input)).toBe("FEEDBACK");
    expect(summarizePullRequest(input, "FEEDBACK")).toBe("Changes requested by hubot; feedback needs a response");
  });
  it("summarizes pending checks and requested reviewers", () => {
    const input = base({ checks: [{ status: "IN_PROGRESS", conclusion: "" }] });
    expect(summarizePullRequest(input, "WAITING")).toBe("Waiting for octocat · 1 check running");
    expect(summarizePullRequest(base({ isDraft: true }), "WAITING")).toBe("Draft · Waiting for octocat");
  });
  it("summarizes reviews GitHub reports without naming a reviewer", () => {
    const approved = base({ reviewDecision: "APPROVED", requestedReviewers: [] });
    expect(summarizePullRequest(approved, "APPROVED")).toBe("Approved; all requested reviews are complete");
    expect(summarizePullRequest({ ...approved, isDraft: true }, "APPROVED")).toBe("Draft · Approved; all requested reviews are complete");
    expect(summarizePullRequest(base({ reviewDecision: "CHANGES_REQUESTED" }), "FEEDBACK")).toBe("Changes requested; feedback needs a response");
  });
});
