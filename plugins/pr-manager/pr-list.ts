import type { PullRequestStatus } from "./pr-status.js";

export const SORT_ORDERS = ["STATUS", "CREATED", "UPDATED"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const SORT_ORDER_LABELS: Record<SortOrder, string> = {
  STATUS: "Status", CREATED: "Created", UPDATED: "Last updated",
};

interface OrderablePullRequest { status: PullRequestStatus; createdAt: string; updatedAt: string }
// Your move first — broken, then awaiting your reply, then a draft to promote, then a
// review to request — before the ones you are waiting on someone else for.
const STATUS_PRIORITY: Record<PullRequestStatus, number> = { FAILING: 0, FEEDBACK: 1, DRAFT: 2, OPEN: 3, WAITING: 4, APPROVED: 5, MERGED: 6 };
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
