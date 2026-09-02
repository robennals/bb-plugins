import { describe, expect, it } from "vitest";
import { searchPullRequests, sortPullRequests } from "./pr-list.js";
import type { PullRequestStatus } from "./pr-status.js";

interface TestPr {
  repository: string; number: number; title: string; headRefName: string; baseRefName: string;
  status: PullRequestStatus; createdAt: string; updatedAt: string;
}
const pr = (overrides: Partial<TestPr> = {}): TestPr => ({
  repository: "wearenewpublic/psi-product", number: 5898, title: "Support translated comment text",
  headRefName: "orpc-translations", baseRefName: "main", status: "WAITING",
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", ...overrides,
});

describe("sortPullRequests", () => {
  const failingOld = pr({ status: "FAILING", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const draftNew = pr({ status: "DRAFT", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });
  const mergedMid = pr({ status: "MERGED", createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" });
  const all = [mergedMid, draftNew, failingOld];
  it("puts what needs your attention first, newest first within a status", () => {
    expect(sortPullRequests(all, "STATUS")).toEqual([failingOld, draftNew, mergedMid]);
    const twoFailing = [
      pr({ status: "FAILING", updatedAt: "2026-01-01T00:00:00Z" }),
      pr({ status: "FAILING", updatedAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(sortPullRequests(twoFailing, "STATUS")[0]!.updatedAt).toBe("2026-03-01T00:00:00Z");
  });
  it("orders by creation and by last update, newest first, ignoring status", () => {
    expect(sortPullRequests(all, "CREATED")).toEqual([draftNew, mergedMid, failingOld]);
    expect(sortPullRequests(all, "UPDATED")).toEqual([draftNew, mergedMid, failingOld]);
  });
  it("does not mutate the input", () => {
    const input = [...all];
    sortPullRequests(input, "CREATED");
    expect(input).toEqual(all);
  });
});

describe("searchPullRequests", () => {
  const prs = [
    pr({ number: 5898, title: "Support translated comment text", headRefName: "orpc-translations" }),
    pr({ number: 5622, title: "Unify voting onto a generic vote resource", headRefName: "vote-resource", status: "FEEDBACK" }),
    pr({ repository: "Broomy-AI/broomy", number: 108, title: "Deduplicate code", headRefName: "dedupe" }),
  ];
  it("returns everything for a blank query", () => {
    expect(searchPullRequests(prs, "   ")).toHaveLength(3);
  });
  it("matches title, repository, number, branch and status, case-insensitively", () => {
    expect(searchPullRequests(prs, "VOTING").map((match) => match.number)).toEqual([5622]);
    expect(searchPullRequests(prs, "broomy").map((match) => match.number)).toEqual([108]);
    expect(searchPullRequests(prs, "#5898").map((match) => match.number)).toEqual([5898]);
    expect(searchPullRequests(prs, "orpc-trans").map((match) => match.number)).toEqual([5898]);
    expect(searchPullRequests(prs, "feedback").map((match) => match.number)).toEqual([5622]);
  });
  it("narrows as terms are added, rather than widening", () => {
    expect(searchPullRequests(prs, "psi").map((match) => match.number)).toEqual([5898, 5622]);
    expect(searchPullRequests(prs, "psi vote").map((match) => match.number)).toEqual([5622]);
    expect(searchPullRequests(prs, "psi vote nonsense")).toEqual([]);
  });
});
