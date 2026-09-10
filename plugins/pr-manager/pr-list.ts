import type { PullRequestStatus } from "./pr-status.js";

export const SORT_ORDERS = ["STATUS", "CREATED", "UPDATED"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const SORT_ORDER_LABELS: Record<SortOrder, string> = {
  STATUS: "Status", CREATED: "Created", UPDATED: "Last updated",
};

interface OrderablePullRequest { status: PullRequestStatus; createdAt: string; updatedAt: string }
// Your move first — broken, then awaiting your reply, then a draft to promote, then a
// review to request, then one you can merge — before the ones still in someone else's
// court. A part-approved PR sits between the two: closer to mergeable than an unreviewed
// one, but not yours to act on yet.
const STATUS_PRIORITY: Record<PullRequestStatus, number> = { FAILING: 0, FEEDBACK: 1, DRAFT: 2, OPEN: 3, APPROVED: 4, PART_APPROVED: 5, WAITING: 6, MERGED: 7 };
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
