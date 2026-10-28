import { describe, expect, it } from "vitest";
import { arrangeStacks, groupIntoStacks, searchPullRequests, sortPullRequests } from "./pr-list.js";
import type { PullRequestStatus } from "./pr-status.js";

interface TestPr {
  key: string; repository: string; number: number; title: string; headRefName: string; baseRefName: string;
  status: PullRequestStatus; createdAt: string; updatedAt: string; stack: { number: number; position: number } | null;
}
const pr = (overrides: Partial<TestPr> = {}): TestPr => ({
  key: `${overrides.repository ?? "wearenewpublic/psi-product"}#${overrides.number ?? 5898}`, repository: "wearenewpublic/psi-product", number: 5898, title: "Support translated comment text",
  headRefName: "orpc-translations", baseRefName: "main", status: "WAITING",
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", stack: null, ...overrides,
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
  it("sinks a draft below every pull request you are actually watching", () => {
    const draft = pr({ status: "DRAFT" });
    const waiting = pr({ status: "WAITING" });
    const merged = pr({ status: "MERGED" });
    expect(sortPullRequests([merged, draft, waiting], "STATUS")).toEqual([waiting, draft, merged]);
  });
  it("puts a PR you can merge above one still in someone else's court", () => {
    const approved = pr({ status: "APPROVED" });
    const partApproved = pr({ status: "PART_APPROVED" });
    const waiting = pr({ status: "WAITING" });
    expect(sortPullRequests([waiting, partApproved, approved], "STATUS")).toEqual([approved, partApproved, waiting]);
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

describe("groupIntoStacks", () => {
  const numbers = (stacks: { prs: TestPr[] }[]) => stacks.map((stack) => stack.prs.map((entry) => entry.number));
  it("puts a pull request based on another's branch in a stack with it, top first", () => {
    const bottom = pr({ number: 1, headRefName: "a", baseRefName: "main" });
    const middle = pr({ number: 2, headRefName: "b", baseRefName: "a" });
    const top = pr({ number: 3, headRefName: "c", baseRefName: "b" });
    const alone = pr({ number: 4, headRefName: "d", baseRefName: "main" });
    expect(numbers(groupIntoStacks([middle, alone, top, bottom]))).toEqual([[4], [3, 2, 1]]);
  });
  it("keeps each pull request above the one it is based on when a stack branches", () => {
    const base = pr({ number: 1, headRefName: "a", baseRefName: "main" });
    const left = pr({ number: 2, headRefName: "b", baseRefName: "a" });
    const right = pr({ number: 3, headRefName: "c", baseRefName: "a" });
    const [stack] = numbers(groupIntoStacks([base, left, right]));
    expect(stack).toHaveLength(3);
    expect(stack!.at(-1)).toBe(1);
  });
  it("takes a GitHub stack as GitHub has it, whatever the branches say", () => {
    // Once the bottom of a GitHub stack merges, the next one is based on main.
    const merged = pr({ number: 1, headRefName: "a", status: "MERGED", stack: { number: 4, position: 1 } });
    const second = pr({ number: 2, headRefName: "b", baseRefName: "main", stack: { number: 4, position: 2 } });
    const third = pr({ number: 3, headRefName: "c", baseRefName: "b", stack: { number: 4, position: 3 } });
    const otherStack = pr({ number: 5, headRefName: "d", baseRefName: "c", stack: { number: 9, position: 1 } });
    const onBranchesOnly = pr({ number: 6, headRefName: "e", baseRefName: "f" });
    const below = pr({ number: 8, headRefName: "f", baseRefName: "main" });
    const stacks = groupIntoStacks([third, onBranchesOnly, merged, otherStack, below, second]);
    expect(numbers(stacks)).toEqual([[3, 2, 1], [5], [6, 8]]);
    expect(stacks[0]!.key).toBe(merged.key);
  });
  it("only stacks pull requests in the same repository", () => {
    const here = pr({ number: 1, headRefName: "a" });
    const elsewhere = pr({ repository: "Broomy-AI/broomy", number: 2, headRefName: "b", baseRefName: "a" });
    expect(numbers(groupIntoStacks([here, elsewhere]))).toEqual([[1], [2]]);
  });
  it("follows a branch's unmerged pull request over a merged one from the same branch", () => {
    const merged = pr({ number: 1, headRefName: "a", status: "MERGED" });
    const reopened = pr({ number: 2, headRefName: "a" });
    const onTop = pr({ number: 3, headRefName: "b", baseRefName: "a" });
    expect(numbers(groupIntoStacks([merged, reopened, onTop]))).toEqual([[1], [3, 2]]);
  });
  it("still lists every pull request when branches are based on each other in a loop", () => {
    const one = pr({ number: 1, headRefName: "a", baseRefName: "b" });
    const two = pr({ number: 2, headRefName: "b", baseRefName: "a" });
    expect(numbers(groupIntoStacks([one, two])).flat().sort()).toEqual([1, 2]);
  });
});

describe("arrangeStacks", () => {
  const bottom = pr({ number: 1, headRefName: "a", baseRefName: "main" });
  const top = pr({ number: 2, headRefName: "b", baseRefName: "a" });
  const alone = pr({ number: 3, headRefName: "c", baseRefName: "main" });
  const stacks = groupIntoStacks([bottom, top, alone]);
  it("orders stacks by where their first shown pull request comes, and drops the rest", () => {
    const arranged = arrangeStacks(stacks, [alone, bottom, top]);
    expect(arranged.map(({ stack }) => stack.key)).toEqual([alone.key, bottom.key]);
    expect(arrangeStacks(stacks, [top]).map(({ stack }) => stack.key)).toEqual([bottom.key]);
  });
  it("records which of a stack's pull requests are shown", () => {
    const [arranged] = arrangeStacks(stacks, [top]);
    expect([...arranged!.shown]).toEqual([top.key]);
    expect(arranged!.stack.prs).toEqual([top, bottom]);
  });
});
