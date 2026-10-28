import type { PullRequestStatus } from "./pr-status.js";

export const SORT_ORDERS = ["STATUS", "CREATED", "UPDATED"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const SORT_ORDER_LABELS: Record<SortOrder, string> = {
  STATUS: "Status", CREATED: "Created", UPDATED: "Last updated",
};

// How often an open panel refreshes its list by itself. A refresh in which nothing has
// changed costs GitHub a handful of small requests, so this stays far inside its limits.
export const AUTO_REFRESH_INTERVAL_SECONDS = 120;

interface OrderablePullRequest { status: PullRequestStatus; createdAt: string; updatedAt: string }
// Your move first — broken, then awaiting your reply, then a review to request, then one
// you can merge — before the ones still in someone else's court. A part-approved PR sits
// between the two: closer to mergeable than an unreviewed one, but not yours to act on
// yet. Drafts sink to the bottom above only merged ones: they are work in progress that
// nobody is waiting on, so they should not crowd out what needs watching.
const STATUS_PRIORITY: Record<PullRequestStatus, number> = { FAILING: 0, FEEDBACK: 1, OPEN: 2, APPROVED: 3, PART_APPROVED: 4, WAITING: 5, DRAFT: 6, MERGED: 7 };
export function sortPullRequests<T extends OrderablePullRequest>(prs: readonly T[], order: SortOrder): T[] {
  const recentlyUpdatedFirst = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);
  return [...prs].sort((a, b) => {
    switch (order) {
      case "STATUS": return STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || recentlyUpdatedFirst(a, b);
      case "CREATED": return b.createdAt.localeCompare(a.createdAt);
      case "UPDATED": return recentlyUpdatedFirst(a, b);
    }
  });
}

interface SearchablePullRequest { repository: string; number: number; title: string; headRefName: string; baseRefName: string; status: PullRequestStatus }
// Every whitespace-separated term has to match, so each extra word narrows the list
// rather than widening it.
export function searchPullRequests<T extends SearchablePullRequest>(prs: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [...prs];
  return prs.filter((pr) => {
    const haystack = `${pr.repository}#${pr.number} ${pr.title} ${pr.headRefName} ${pr.baseRefName} ${pr.status}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

interface StackablePullRequest {
  key: string; repository: string; headRefName: string; baseRefName: string; status: PullRequestStatus;
  stack: { number: number; position: number } | null;
}
// Pull requests that build on each other, listed from the top of the stack down to the
// one based on a branch outside it, so each sits above the one it is based on.
export interface PullRequestStack<T> { key: string; prs: T[] }
// A stack GitHub knows about is taken as GitHub has it. Otherwise, a pull request is
// stacked on another when its base branch is the other's head branch, which is how stacks
// made by other tools show. A lone pull request is a stack of one. When a merged and an
// unmerged pull request share a head branch, the unmerged one is the branch's current
// pull request, so stacks follow it.
export function groupIntoStacks<T extends StackablePullRequest>(prs: readonly T[]): PullRequestStack<T>[] {
  const gitHubStacks = new Map<string, { pr: T; position: number }[]>();
  for (const pr of prs) {
    if (pr.stack === null) continue;
    const key = `${pr.repository}#${pr.stack.number}`;
    gitHubStacks.set(key, [...(gitHubStacks.get(key) ?? []), { pr, position: pr.stack.position }]);
  }
  const stacks = [...gitHubStacks.values()].map((members): PullRequestStack<T> => {
    const topFirst = [...members].sort((a, b) => b.position - a.position).map(({ pr }) => pr);
    return { key: topFirst[topFirst.length - 1]!.key, prs: topFirst };
  });
  return [...stacks, ...groupByBranches(prs.filter((pr) => pr.stack === null))];
}
function groupByBranches<T extends StackablePullRequest>(prs: readonly T[]): PullRequestStack<T>[] {
  const branchKey = (repository: string, branch: string) => `${repository}\0${branch}`;
  const byHead = new Map<string, T>();
  for (const pr of prs) {
    const key = branchKey(pr.repository, pr.headRefName);
    const existing = byHead.get(key);
    if (existing === undefined || (existing.status === "MERGED" && pr.status !== "MERGED")) byHead.set(key, pr);
  }
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const pr of prs) {
    const parent = byHead.get(branchKey(pr.repository, pr.baseRefName));
    if (parent === undefined || parent === pr) roots.push(pr);
    else children.set(parent.key, [...(children.get(parent.key) ?? []), pr]);
  }
  const placed = new Set<string>();
  const stacks: PullRequestStack<T>[] = [];
  const collect = (pr: T, into: T[]) => {
    if (placed.has(pr.key)) return;
    placed.add(pr.key); into.push(pr);
    for (const child of children.get(pr.key) ?? []) collect(child, into);
  };
  // Branches based on each other in a loop have no root, so whatever is left after the
  // roots starts a stack of its own rather than going missing.
  for (const start of [...roots, ...prs]) {
    if (placed.has(start.key)) continue;
    const basedFirst: T[] = [];
    collect(start, basedFirst);
    stacks.push({ key: start.key, prs: basedFirst.reverse() });
  }
  return stacks;
}

// The stacks with a pull request in `shownPrs`, in the order their first one appears
// there, so a stack sorts by its most pressing pull request and moves as a unit. `shown`
// is the keys of the stack's pull requests that are in `shownPrs`.
export function arrangeStacks<T extends { key: string }>(stacks: readonly PullRequestStack<T>[], shownPrs: readonly T[]): { stack: PullRequestStack<T>; shown: Set<string> }[] {
  const stackOf = new Map<string, PullRequestStack<T>>();
  for (const stack of stacks) for (const pr of stack.prs) stackOf.set(pr.key, stack);
  const arranged = new Map<PullRequestStack<T>, Set<string>>();
  for (const pr of shownPrs) {
    const stack = stackOf.get(pr.key);
    if (stack === undefined) continue;
    const shown = arranged.get(stack) ?? new Set<string>();
    shown.add(pr.key);
    arranged.set(stack, shown);
  }
  return [...arranged].map(([stack, shown]) => ({ stack, shown }));
}
