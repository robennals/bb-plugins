import { describe, expect, it } from "vitest";
import type { HostPullRequest } from "./contract.js";
import {
  changeMarker, DETAILS_BATCH_SIZE, fetchPullRequests, LIST_PAGE_SIZE, listPullRequests, mergedPullRequestSearch,
  openPullRequestSearch, pullRequestCheckCountsQuery, pullRequestDetailsQuery, pullRequestListArgs,
} from "./pr-search.js";

// A pull request as GitHub holds it, with how many of its check runs are in each state.
interface GitHubPullRequest { number: number; updatedAt: string; checkRuns: Record<string, number>; mergedAt: string | null }
const pullRequest = (number: number, overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest =>
  ({ number, updatedAt: "2026-09-01T00:00:00Z", checkRuns: {}, mergedAt: null, ...overrides });
const id = (pr: GitHubPullRequest) => `id-${pr.number}`;
const listed = (pr: GitHubPullRequest) => ({ id: id(pr), number: pr.number, updatedAt: pr.updatedAt });
const checkCounts = (pr: GitHubPullRequest) => ({
  checkRunCountsByState: Object.entries(pr.checkRuns).map(([state, count]) => ({ state, count })), statusContextCountsByState: [],
});
const checkRuns = (pr: GitHubPullRequest) => Object.entries(pr.checkRuns).flatMap(([state, count]) =>
  Array.from({ length: count }, (_, index) => ({
    __typename: "CheckRun", name: `${state}-${index}`, startedAt: "2026-09-01T00:00:00Z",
    ...(state === "IN_PROGRESS" ? { status: state } : { status: "COMPLETED", conclusion: state }),
  })));
const details = (pr: GitHubPullRequest) => ({
  id: id(pr), number: pr.number, title: `PR ${pr.number}`, url: `https://github.com/octo/widgets/pull/${pr.number}`,
  state: pr.mergedAt === null ? "OPEN" : "MERGED", isDraft: false, headRefName: `branch-${pr.number}`, baseRefName: "main",
  reviewDecision: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: pr.updatedAt, mergedAt: pr.mergedAt,
  repository: { nameWithOwner: "octo/widgets" }, author: { __typename: "User", login: "me" },
  reviewRequests: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { ...checkCounts(pr), nodes: checkRuns(pr) } } } }] },
});
const searchPage = (nodes: object[], endCursor: string | null = null) => JSON.stringify({
  data: { search: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
});
// Answers each `gh` call with the next response, recording the arguments it was called with.
function scriptedGh(responses: string[]) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => { calls.push(args); return responses[calls.length - 1]!; };
  return { calls, gh };
}
// GitHub holding the given pull requests, recording the queries that asked for
// pull requests by id.
function gitHub(pullRequests: GitHubPullRequest[]) {
  const checkCountRequests: string[] = [];
  const detailRequests: string[] = [];
  const gh = async (args: string[]) => {
    const query = args.find((arg) => arg.startsWith("query="))!.slice("query=".length);
    const search = args.find((arg) => arg.startsWith("search="));
    if (search !== undefined) return searchPage(pullRequests.filter((pr) => (pr.mergedAt !== null) === search.includes("is:merged")).map(listed));
    const asked = pullRequests.filter((pr) => query.includes(`"${id(pr)}"`));
    if (query.includes("reviewDecision")) { detailRequests.push(query); return JSON.stringify({ data: { nodes: asked.map(details) } }); }
    checkCountRequests.push(query);
    return JSON.stringify({ data: { nodes: asked.map((pr) => ({ id: id(pr), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: checkCounts(pr) } } }] } })) } });
  };
  const fetch = (savedPullRequests: HostPullRequest[]) =>
    fetchPullRequests({ repository: "octo/widgets", since: "2026-08-18", maximumMergedPullRequests: 50, savedPullRequests }, gh);
  return { checkCountRequests, detailRequests, fetch };
}

describe("pull request search terms", () => {
  it("finds your own open pull requests in one repository", () => {
    expect(openPullRequestSearch("octo/widgets")).toBe("repo:octo/widgets is:pr author:@me state:open sort:updated-desc");
  });

  it("finds your own pull requests merged since a date", () => {
    expect(mergedPullRequestSearch("octo/widgets", "2026-08-01"))
      .toBe("repo:octo/widgets is:pr author:@me is:merged merged:>=2026-08-01 sort:updated-desc");
  });
});

describe("pull request details query", () => {
  const query = pullRequestDetailsQuery(["id-1", "id-2"]);

  it("asks for all the given pull requests at once", () => {
    expect(query).toContain(`nodes(ids:["id-1","id-2"])`);
  });

  it("selects every field the classifier and the change marker read", () => {
    // Losing any of these silently degrades a status rather than failing: the classifier
    // reads them all, and this query is the only place they come from.
    for (const field of [
      "reviewDecision", "reviewRequests", "reviews", "comments", "statusCheckRollup", "mergedAt", "isDraft",
      "author", "submittedAt", "startedAt", "workflow", "headRefName", "baseRefName", "nameWithOwner",
      "checkRunCountsByState", "statusContextCountsByState",
    ]) {
      expect(query).toContain(field);
    }
  });

  it("distinguishes bots from people, and every kind of requested reviewer", () => {
    for (const selection of ["author{__typename login}", "on User{login}", "on Team{slug}", "on Bot{login}"]) {
      expect(query).toContain(selection);
    }
  });
});

describe("listPullRequests", () => {
  const [four, three, two, one] = [4, 3, 2, 1].map((number) => listed(pullRequest(number)));

  it("fetches a short list in a single request", async () => {
    const { calls, gh } = scriptedGh([searchPage([three, two])]);
    expect((await listPullRequests("repo:octo/widgets", 1000, gh)).map((pr) => pr.number)).toEqual([3, 2]);
    expect(calls).toEqual([pullRequestListArgs("repo:octo/widgets", LIST_PAGE_SIZE, null)]);
  });

  it("follows the cursor until the results run out", async () => {
    const { calls, gh } = scriptedGh([searchPage([four, three], "cursor-1"), searchPage([two, one])]);
    expect((await listPullRequests("repo:octo/widgets", 1000, gh)).map((pr) => pr.number)).toEqual([4, 3, 2, 1]);
    expect(calls[1]).toEqual(pullRequestListArgs("repo:octo/widgets", LIST_PAGE_SIZE, "cursor-1"));
  });

  it("asks for no more than the limit, and stops once it has that many", async () => {
    const { calls, gh } = scriptedGh([searchPage([three, two], "cursor-1")]);
    expect((await listPullRequests("repo:octo/widgets", 2, gh)).map((pr) => pr.number)).toEqual([3, 2]);
    expect(calls).toEqual([pullRequestListArgs("repo:octo/widgets", 2, null)]);
  });

  it("skips results that are not pull requests", async () => {
    const { gh } = scriptedGh([searchPage([two, {}])]);
    expect((await listPullRequests("repo:octo/widgets", 1000, gh)).map((pr) => pr.number)).toEqual([2]);
  });
});

describe("changeMarker", () => {
  const counts = (checkRuns: Record<string, number>) => checkCounts(pullRequest(1, { checkRuns }));

  it("changes when the pull request is updated or its checks change state", () => {
    const marker = changeMarker("2026-09-01T00:00:00Z", counts({ IN_PROGRESS: 2 }));
    expect(changeMarker("2026-09-01T00:00:00Z", counts({ IN_PROGRESS: 2 }))).toBe(marker);
    expect(changeMarker("2026-09-02T00:00:00Z", counts({ IN_PROGRESS: 2 }))).not.toBe(marker);
    expect(changeMarker("2026-09-01T00:00:00Z", counts({ IN_PROGRESS: 1, FAILURE: 1 }))).not.toBe(marker);
  });

  it("does not depend on the order GitHub lists the states in", () => {
    expect(changeMarker("2026-09-01T00:00:00Z", counts({ SUCCESS: 3, FAILURE: 1 })))
      .toBe(changeMarker("2026-09-01T00:00:00Z", counts({ FAILURE: 1, SUCCESS: 3 })));
  });

  it("is the update time alone for a pull request with no checks", () => {
    expect(changeMarker("2026-09-01T00:00:00Z", null)).toBe("2026-09-01T00:00:00Z");
    expect(changeMarker("2026-09-01T00:00:00Z", { checkRunCountsByState: null, statusContextCountsByState: null })).toBe("2026-09-01T00:00:00Z");
  });
});

describe("fetchPullRequests", () => {
  it("fetches the details of every pull request in one request when nothing is saved", async () => {
    const { checkCountRequests, detailRequests, fetch } = gitHub([pullRequest(2), pullRequest(1, { checkRuns: { FAILURE: 1 } })]);
    const fetched = await fetch([]);
    expect(fetched.map((pr) => [pr.number, pr.status, pr.summary])).toEqual([
      [2, "OPEN", "No review requested yet"], [1, "FAILING", "1 check is failing"],
    ]);
    expect(fetched[0]).toMatchObject({ id: "id-2", repository: "octo/widgets", title: "PR 2", headRefName: "branch-2" });
    expect(checkCountRequests).toEqual([]);
    expect(detailRequests).toEqual([pullRequestDetailsQuery(["id-2", "id-1"])]);
  });

  it("asks for no details when every saved pull request is unchanged", async () => {
    const pullRequests = [pullRequest(3, { checkRuns: { SUCCESS: 2 } }), pullRequest(2), pullRequest(1, { mergedAt: "2026-08-30T00:00:00Z" })];
    const saved = await gitHub(pullRequests).fetch([]);
    const { checkCountRequests, detailRequests, fetch } = gitHub(pullRequests);
    expect(await fetch(saved)).toEqual(saved);
    expect(detailRequests).toEqual([]);
    // Merged pull requests are left out: no check can change their status.
    expect(checkCountRequests).toEqual([pullRequestCheckCountsQuery(["id-3", "id-2"])]);
  });

  it("fetches details only for pull requests that are new, updated, or whose checks changed", async () => {
    const saved = await gitHub([pullRequest(3), pullRequest(2, { checkRuns: { IN_PROGRESS: 1 } }), pullRequest(1)]).fetch([]);
    const { detailRequests, fetch } = gitHub([
      pullRequest(4), pullRequest(3, { updatedAt: "2026-09-05T00:00:00Z" }), pullRequest(2, { checkRuns: { FAILURE: 1 } }), pullRequest(1),
    ]);
    const fetched = await fetch(saved);
    expect(detailRequests).toEqual([pullRequestDetailsQuery(["id-4", "id-3", "id-2"])]);
    expect(fetched.map((pr) => [pr.number, pr.status])).toEqual([[4, "OPEN"], [3, "OPEN"], [2, "FAILING"], [1, "OPEN"]]);
    expect(fetched[3]).toBe(saved[2]);
  });

  it("fetches a saved pull request again once it has been merged", async () => {
    const saved = await gitHub([pullRequest(1)]).fetch([]);
    const fetched = await gitHub([pullRequest(1, { updatedAt: "2026-09-05T00:00:00Z", mergedAt: "2026-09-05T00:00:00Z" })]).fetch(saved);
    expect(fetched.map((pr) => [pr.number, pr.status, pr.changeMarker])).toEqual([[1, "MERGED", "2026-09-05T00:00:00Z"]]);
  });

  it("drops saved pull requests that the searches no longer find", async () => {
    const saved = await gitHub([pullRequest(2), pullRequest(1)]).fetch([]);
    expect((await gitHub([pullRequest(2)]).fetch(saved)).map((pr) => pr.number)).toEqual([2]);
  });

  it("splits a long list of changed pull requests across requests", async () => {
    const { detailRequests, fetch } = gitHub(Array.from({ length: DETAILS_BATCH_SIZE + 1 }, (_, index) => pullRequest(index + 1)));
    expect(await fetch([])).toHaveLength(DETAILS_BATCH_SIZE + 1);
    expect(detailRequests).toHaveLength(2);
  });
});
