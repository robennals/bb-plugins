import type { HostPullRequest } from "./contract.js";
import { classifyPullRequest, latestCheckRuns, normalizeCheck, summarizePullRequest, type RollupEntry } from "./pr-status.js";

// Runs the `gh` command with the given arguments and resolves to what it printed.
export type Gh = (args: string[]) => Promise<string>;

interface Actor { __typename: string; login?: string; slug?: string }
interface RollupContext extends RollupEntry { __typename: string; checkSuite?: { workflowRun?: { workflow?: { name?: string } } } }
interface CountByState { state: string; count: number }
interface CheckCounts { checkRunCountsByState: CountByState[] | null; statusContextCountsByState: CountByState[] | null }
interface HeadCommit<Contexts> { nodes: Array<{ commit: { statusCheckRollup: { contexts: Contexts } | null } }> }
export interface ListedPullRequest { id: string; number: number; updatedAt: string }
// Everything the classifier reads, fetched only for pull requests that have changed.
export interface PullRequestDetails {
  id: string; number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string;
  reviewDecision: string | null; createdAt: string; updatedAt: string; mergedAt: string | null;
  repository: { nameWithOwner: string };
  author: Actor | null;
  reviewRequests: { nodes: Array<{ requestedReviewer: Actor | null }> };
  reviews: { nodes: Array<{ state: string; submittedAt: string; author: Actor | null }> };
  comments: { nodes: Array<{ createdAt: string; author: Actor | null }> };
  commits: HeadCommit<CheckCounts & { nodes: RollupContext[] }>;
}
interface SearchPage {
  data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<Partial<ListedPullRequest>> } };
}
interface NodesResponse<Node> { data: { nodes: Array<Partial<Node> | null> } }

export const PULL_REQUEST_LIST_QUERY = `query($search:String!,$first:Int!,$after:String){
  search(query:$search,type:ISSUE,first:$first,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{... on PullRequest{id number updatedAt}}
  }
}`;
const CHECK_COUNTS = "checkRunCountsByState{state count} statusContextCountsByState{state count}";
// The ids are written into these queries because older versions of `gh` cannot pass a
// list variable.
export function pullRequestCheckCountsQuery(ids: string[]): string {
  return `query{
  nodes(ids:${JSON.stringify(ids)}){
    ... on PullRequest{id commits(last:1){nodes{commit{statusCheckRollup{contexts{${CHECK_COUNTS}}}}}}}
  }
}`;
}
// Actors carry their __typename because that is what tells a bot's comment from a
// reviewer's, which decides whether a PR counts as having unaddressed feedback.
export function pullRequestDetailsQuery(ids: string[]): string {
  return `query{
  nodes(ids:${JSON.stringify(ids)}){
    ... on PullRequest{
      id number title url state isDraft headRefName baseRefName reviewDecision createdAt updatedAt mergedAt
      repository{nameWithOwner}
      author{__typename login}
      reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login}}}}
      reviews(last:50){nodes{state submittedAt author{__typename login}}}
      comments(last:50){nodes{createdAt author{__typename login}}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){${CHECK_COUNTS} nodes{
        __typename
        ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state createdAt}
      }}}}}}
    }
  }
}`;
}
// The most GitHub returns in one page of search results.
export const LIST_PAGE_SIZE = 100;
// Counting checks takes GitHub about as long per pull request as a whole search does to
// list it, so the counting is spread over requests small enough to finish with the search.
export const CHECK_COUNTS_BATCH_SIZE = 20;
// GitHub gives up on a request after ten seconds, and details take roughly a second per
// ten pull requests when they carry many checks, so a request asks for at most this many.
export const DETAILS_BATCH_SIZE = 50;

function searchTerms(repository: string, filters: string[]): string {
  return [`repo:${repository}`, "is:pr", "author:@me", ...filters, "sort:updated-desc"].join(" ");
}
export function openPullRequestSearch(repository: string): string {
  return searchTerms(repository, ["state:open"]);
}
export function mergedPullRequestSearch(repository: string, since: string): string {
  return searchTerms(repository, ["is:merged", `merged:>=${since}`]);
}

export function pullRequestListArgs(search: string, first: number, after: string | null): string[] {
  const args = ["api", "graphql", "-f", `query=${PULL_REQUEST_LIST_QUERY}`, "-f", `search=${search}`, "-F", `first=${first}`];
  return after === null ? args : [...args, "-f", `after=${after}`];
}

// Pages through a search until it has `limit` pull requests or the results run out.
export async function listPullRequests(search: string, limit: number, gh: Gh): Promise<ListedPullRequest[]> {
  const pullRequests: ListedPullRequest[] = [];
  let after: string | null = null;
  while (pullRequests.length < limit) {
    const first = Math.min(LIST_PAGE_SIZE, limit - pullRequests.length);
    const response: SearchPage = JSON.parse(await gh(pullRequestListArgs(search, first, after)));
    const page = response.data.search;
    // `type:ISSUE` is the only search type that finds pull requests, and it types its
    // results as issues too, so anything that is not a pull request comes back empty.
    pullRequests.push(...page.nodes.filter((node): node is ListedPullRequest => typeof node.number === "number"));
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) break;
    after = page.pageInfo.endCursor;
  }
  return pullRequests;
}

// A pull request's `updatedAt` moves when it is commented on, reviewed, pushed to or
// edited, but not when its checks start or finish, so the marker also carries how many
// checks are in each state. Two equal markers mean the same status and summary. The
// checks are left out for a merged pull request, whose status no check can change.
export function changeMarker(updatedAt: string, checks: CheckCounts | null): string {
  const counts = [...checks?.checkRunCountsByState ?? [], ...checks?.statusContextCountsByState ?? []]
    .map(({ state, count }) => `${state}:${count}`).sort();
  return [updatedAt, ...counts].join(" ");
}

// Asks for each of `ids` in as few requests as GitHub allows, `batchSize` to a request.
async function pullRequestNodes<Node extends { id: string }>(ids: string[], batchSize: number, query: (ids: string[]) => string, gh: Gh): Promise<Node[]> {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += batchSize) batches.push(ids.slice(start, start + batchSize));
  const responses = await Promise.all(batches.map(async (batch): Promise<NodesResponse<Node>> =>
    JSON.parse(await gh(["api", "graphql", "-f", `query=${query(batch)}`]))));
  // An id that is no longer a pull request we can see comes back as null or empty.
  return responses.flatMap((response) => response.data.nodes).filter((node): node is Node => typeof node?.id === "string");
}
const headCommitChecks = <Contexts>(commits: HeadCommit<Contexts>): Contexts | null =>
  commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? null;

const actorName = (actor: Actor | null): string => actor?.login ?? actor?.slug ?? "";
const isBot = (actor: Actor | null): boolean => actor?.__typename === "Bot";
function describePullRequest(details: PullRequestDetails): HostPullRequest {
  const requestedReviewers = details.reviewRequests.nodes
    .map((request) => actorName(request.requestedReviewer)).filter((reviewer) => reviewer !== "");
  const checks = headCommitChecks(details.commits);
  const rollup = checks?.nodes ?? [];
  const input = { state: details.state, mergedAt: details.mergedAt, isDraft: details.isDraft, reviewDecision: details.reviewDecision ?? "",
    author: actorName(details.author), requestedReviewers,
    reviews: details.reviews.nodes.map((review) => ({ author: actorName(review.author), isBot: isBot(review.author), state: review.state, submittedAt: review.submittedAt })),
    comments: details.comments.nodes.map((comment) => ({ author: actorName(comment.author), isBot: isBot(comment.author), createdAt: comment.createdAt })),
    checks: latestCheckRuns(rollup.map((entry) => normalizeCheck({ ...entry, workflowName: entry.checkSuite?.workflowRun?.workflow?.name }))) };
  const status = classifyPullRequest(input);
  return { id: details.id, repository: details.repository.nameWithOwner, number: details.number, title: details.title, url: details.url, status,
    summary: summarizePullRequest(input, status), isDraft: details.isDraft, headRefName: details.headRefName,
    baseRefName: details.baseRefName, createdAt: details.createdAt, updatedAt: details.updatedAt, mergedAt: details.mergedAt,
    changeMarker: changeMarker(details.updatedAt, status === "MERGED" ? null : checks) };
}

// Your open pull requests in `repository` and those merged since `since`. The searches
// say only which pull requests there are and when each was last updated. Alongside
// them, one request counts the checks of the open pull requests saved last time, and
// those two together give each one's change marker. The details behind a status are
// then fetched, in one further request, only for pull requests that are new or whose
// marker differs from the saved one.
export async function fetchPullRequests(
  { repository, since, maximumMergedPullRequests, savedPullRequests }:
    { repository: string; since: string; maximumMergedPullRequests: number; savedPullRequests: HostPullRequest[] },
  gh: Gh,
): Promise<HostPullRequest[]> {
  const savedOpenIds = savedPullRequests.filter((pr) => pr.status !== "MERGED").map((pr) => pr.id);
  const [open, merged, savedOpenChecks] = await Promise.all([
    // Every open PR, up to GitHub search's own ceiling of 1000.
    listPullRequests(openPullRequestSearch(repository), 1000, gh),
    listPullRequests(mergedPullRequestSearch(repository, since), maximumMergedPullRequests, gh),
    pullRequestNodes<{ id: string; commits: HeadCommit<CheckCounts> }>(savedOpenIds, CHECK_COUNTS_BATCH_SIZE, pullRequestCheckCountsQuery, gh),
  ]);
  const checksById = new Map(savedOpenChecks.map((pr) => [pr.id, headCommitChecks(pr.commits)]));
  const savedById = new Map(savedPullRequests.map((pr) => [pr.id, pr]));
  // The saved entry, when it is still right. An open pull request whose checks were not
  // counted is new since the last refresh, so it has no saved entry to reuse.
  const unchanged = (pr: ListedPullRequest, isMerged: boolean) => {
    const saved = savedById.get(pr.id);
    if (saved === undefined || (!isMerged && !checksById.has(pr.id))) return undefined;
    return saved.changeMarker === changeMarker(pr.updatedAt, isMerged ? null : checksById.get(pr.id) ?? null) ? saved : undefined;
  };
  const listed = new Map<string, HostPullRequest | undefined>([
    ...open.map((pr): [string, HostPullRequest | undefined] => [pr.id, unchanged(pr, false)]),
    ...merged.map((pr): [string, HostPullRequest | undefined] => [pr.id, unchanged(pr, true)]),
  ]);
  const changedIds = [...listed].filter(([, saved]) => saved === undefined).map(([id]) => id);
  const details = await pullRequestNodes<PullRequestDetails>(changedIds, DETAILS_BATCH_SIZE, pullRequestDetailsQuery, gh);
  const detailsById = new Map(details.map((pr) => [pr.id, pr]));
  return [...listed].flatMap(([id, saved]) => {
    if (saved !== undefined) return [saved];
    const changed = detailsById.get(id);
    return changed === undefined ? [] : [describePullRequest(changed)];
  });
}
