import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { pullRequestSourceRef } from "./git-ref.js";
import { mergedPullRequestQuery, openPullRequestQuery, pullRequestSearchArgs } from "./pr-search.js";
import { classifyPullRequest, latestCheckRuns, normalizeCheck, summarizePullRequest, type RollupEntry } from "./pr-status.js";
import { sortPullRequests } from "./pr-list.js";

const execFileAsync = promisify(execFile);
interface Actor { __typename: string; login?: string; slug?: string }
interface RollupContext extends RollupEntry { __typename: string; checkSuite?: { workflowRun?: { workflow?: { name?: string } } } }
interface StatusCheckRollup { state?: string; contexts: { totalCount: number; nodes: RollupContext[] } }
interface PrView {
  number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string;
  reviewDecision: string | null; createdAt: string; updatedAt: string; mergedAt: string | null;
  repository: { nameWithOwner: string };
  author: Actor | null;
  reviewRequests: { nodes: Array<{ requestedReviewer: Actor | null }> };
  reviews: { nodes: Array<{ state: string; submittedAt: string; author: Actor | null }> };
  comments: { nodes: Array<{ createdAt: string; author: Actor | null }> };
  commits: { nodes: Array<{ commit: { statusCheckRollup: StatusCheckRollup | null } }> };
}
const actorName = (actor: Actor | null): string => actor?.login ?? actor?.slug ?? "";
const isBot = (actor: Actor | null): boolean => actor?.__typename === "Bot";
async function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000, signal });
    return stdout;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    throw new Error(`${command} failed: ${error.stderr?.trim() || error.message}`);
  }
}
async function search(query: string, limit: number, signal: AbortSignal): Promise<PrView[]> {
  const parsed = JSON.parse(await run("gh", pullRequestSearchArgs(query, limit), signal)) as
    { data: { search: { nodes: Array<Partial<PrView>> } } };
  // `type: ISSUE` is the only search type that returns pull requests, so a node that is
  // a plain issue comes back as the empty half of the inline fragment.
  return parsed.data.search.nodes.filter((node): node is PrView => typeof node.number === "number");
}
function rollupEntries(rollup: StatusCheckRollup | null | undefined): RollupContext[] {
  if (!rollup) return [];
  // A head commit with more than one page of contexts would otherwise be classified from
  // the first page alone, hiding a failure further down. The rollup's own state covers
  // every context, so when the page is short one synthetic entry stands in for the rest —
  // cheaper, and less fragile, than paginating a connection per pull request.
  const truncated = rollup.contexts.totalCount > rollup.contexts.nodes.length;
  return truncated
    ? [...rollup.contexts.nodes, { __typename: "StatusContext", context: "(checks beyond the first page)", state: rollup.state }]
    : rollup.contexts.nodes;
}
function normalizeRemote(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "");
  return cleaned.match(/(?:git@|https?:\/\/)?github\.com[:/]([^/]+\/[^/]+)$/i)?.[1]?.toLowerCase() ?? null;
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async listPullRequests({ mergedWithinDays, maximumPullRequests }, context) {
      await run("gh", ["auth", "status"], context.signal);
      const since = new Date(Date.now() - mergedWithinDays * 86_400_000).toISOString().slice(0, 10);
      const [open, merged] = await Promise.all([
        search(openPullRequestQuery(), maximumPullRequests, context.signal),
        search(mergedPullRequestQuery(since), maximumPullRequests, context.signal),
      ]);
      const unique = [...new Map([...open, ...merged].map((pr) => [pr.url, pr])).values()];
      const pullRequests = unique.map((view) => {
        const repository = view.repository.nameWithOwner;
        const requestedReviewers = view.reviewRequests.nodes
          .map((request) => actorName(request.requestedReviewer)).filter((reviewer) => reviewer !== "");
        const rollup = rollupEntries(view.commits.nodes[0]?.commit.statusCheckRollup);
        const input = { state: view.state, mergedAt: view.mergedAt, isDraft: view.isDraft, reviewDecision: view.reviewDecision ?? "",
          author: actorName(view.author), requestedReviewers,
          reviews: view.reviews.nodes.map((review) => ({ author: actorName(review.author), isBot: isBot(review.author), state: review.state, submittedAt: review.submittedAt })),
          comments: view.comments.nodes.map((comment) => ({ author: actorName(comment.author), isBot: isBot(comment.author), createdAt: comment.createdAt })),
          checks: latestCheckRuns(rollup.map((entry) => normalizeCheck({ ...entry, workflowName: entry.checkSuite?.workflowRun?.workflow?.name }))) };
        const status = classifyPullRequest(input);
        return { repository, number: view.number, title: view.title, url: view.url, status,
          summary: summarizePullRequest(input, status), isDraft: view.isDraft, headRefName: view.headRefName,
          baseRefName: view.baseRefName, createdAt: view.createdAt, updatedAt: view.updatedAt, mergedAt: view.mergedAt };
      });
      return { pullRequests: sortPullRequests(pullRequests, "STATUS") };
    },
    async preparePullRequestBranch({ projectPath, repository, number }, context) {
      const remote = await run("git", ["-C", projectPath, "remote", "get-url", "origin"], context.signal);
      if (normalizeRemote(remote) !== repository.toLowerCase()) throw new Error(`Project origin does not match ${repository}.`);
      // Keep the PR head outside refs/remotes. BB refreshes and prunes the
      // project's remote-tracking refs before provisioning a worktree.
      const ref = pullRequestSourceRef(number);
      await run("git", ["-C", projectPath, "fetch", "--force", "origin", `+refs/pull/${number}/head:${ref}`], context.signal);
      return { ref };
    },
  },
});
