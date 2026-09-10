import { describe, expect, it } from "vitest";
import {
  mergedPullRequestQuery, openPullRequestQuery, PULL_REQUEST_SEARCH_DOCUMENT, pullRequestSearchArgs,
} from "./pr-search.js";

describe("pull request search", () => {
  it("excludes archived repositories from both searches", () => {
    // A PR in an archived repository cannot be acted on, so it must not be listed.
    expect(openPullRequestQuery()).toContain("archived:false");
    expect(mergedPullRequestQuery("2026-08-01")).toContain("archived:false");
  });

  it("keeps the state and date filters each search needs", () => {
    expect(openPullRequestQuery()).toBe("author:@me is:pr archived:false state:open sort:updated-desc");
    expect(mergedPullRequestQuery("2026-08-01")).toBe(
      "author:@me is:pr archived:false is:merged merged:>=2026-08-01 sort:updated-desc",
    );
  });

  it("sends one request carrying the query and the limit", () => {
    const args = pullRequestSearchArgs(openPullRequestQuery(), 50);
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toContain("q=author:@me is:pr archived:false state:open sort:updated-desc");
    expect(args).toContain("limit=50");
  });

  it("selects every field the classifier reads", () => {
    // Losing any of these silently degrades a status rather than failing: the classifier
    // reads them all, and the search is now the only place they come from.
    for (const field of [
      "reviewDecision", "reviewRequests", "reviews", "comments", "statusCheckRollup",
      "mergedAt", "isDraft", "author", "submittedAt", "startedAt", "workflow",
    ]) {
      expect(PULL_REQUEST_SEARCH_DOCUMENT).toContain(field);
    }
  });

  it("distinguishes bots from people, and every kind of requested reviewer", () => {
    // A bot's review or comment must not count as a human verdict, and a pending Bot
    // review request keeps a pull request out of APPROVED.
    expect(PULL_REQUEST_SEARCH_DOCUMENT.match(/__typename/g)?.length).toBeGreaterThanOrEqual(4);
    for (const fragment of ["on User{login}", "on Team{slug}", "on Bot{login}"]) {
      expect(PULL_REQUEST_SEARCH_DOCUMENT).toContain(fragment);
    }
  });

  it("can tell a truncated check rollup from a complete one", () => {
    // Without totalCount and the rollup state, a commit with more than one page of
    // contexts is classified from its first page alone.
    expect(PULL_REQUEST_SEARCH_DOCUMENT).toContain("totalCount");
    expect(PULL_REQUEST_SEARCH_DOCUMENT).toMatch(/statusCheckRollup\{state/);
  });
});
