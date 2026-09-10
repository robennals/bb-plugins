import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { pullRequestSourceRef } from "./git-ref.js";
import { classifyPullRequest, latestCheckRuns, normalizeCheck, summarizePullRequest, type RollupEntry } from "./pr-status.js";
import { sortPullRequests } from "./pr-list.js";

const execFileAsync = promisify(execFile);
interface SearchResult { number: number; title: string; url: string; isDraft: boolean; createdAt: string; updatedAt: string; repository: { nameWithOwner: string } }
interface Actor { __typename: string; login?: string; slug?: string }
interface RollupContext extends RollupEntry { __typename: string; checkSuite?: { workflowRun?: { workflow?: { name?: string } } } }
interface PrView {
  number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string;
  reviewDecision: string | null; createdAt: string; updatedAt: string; mergedAt: string | null;
  author: { login: string } | null;
  reviewRequests: { nodes: Array<{ requestedReviewer: Actor | null }> };
  reviews: { nodes: Array<{ state: string; submittedAt: string; author: Actor | null }> };
  comments: { nodes: Array<{ createdAt: string; author: Actor | null }> };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: RollupContext[] } } | null } }> };
}
// One query per pull request, covering everything the classifier needs. `gh pr view
// --json` cannot report an actor's __typename, so it cannot tell a bot's comment from a
// reviewer's, which decides whether a PR counts as having unaddressed feedback.
const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url state isDraft headRefName baseRefName reviewDecision createdAt updatedAt mergedAt
      author{login}
      reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login}}}}
      reviews(last:50){nodes{state submittedAt author{__typename login}}}
      comments(last:50){nodes{createdAt author{__typename login}}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        __typename
        ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state createdAt}
      }}}}}}
    }
  }
}`;
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
async function mapConcurrent<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length); let cursor = 0;
  async function worker() { while (cursor < values.length) { const index = cursor++; results[index] = await mapper(values[index]!); } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}
async function search(args: string[], signal: AbortSignal): Promise<SearchResult[]> {
  return JSON.parse(await run("gh", ["search", "prs", "--author=@me", ...args, "--json", "number,title,url,repository,createdAt,updatedAt,isDraft"], signal)) as SearchResult[];
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
        search(["--state=open", "--sort=updated", "--order=desc", `--limit=${maximumPullRequests}`], context.signal),
        search(["--merged", `--merged-at=>=${since}`, "--sort=updated", "--order=desc", `--limit=${maximumPullRequests}`], context.signal),
      ]);
      const unique = [...new Map([...open, ...merged].map((pr) => [pr.url, pr])).values()];
      const pullRequests = await mapConcurrent(unique, 6, async (result) => {
        const repository = result.repository.nameWithOwner;
        const [owner, name] = repository.split("/");
        const response = JSON.parse(await run("gh", ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`,
          "-F", `number=${result.number}`, "-f", `query=${PR_QUERY}`], context.signal)) as { data: { repository: { pullRequest: PrView } } };
        const view = response.data.repository.pullRequest;
        const requestedReviewers = view.reviewRequests.nodes
          .map((request) => actorName(request.requestedReviewer)).filter((reviewer) => reviewer !== "");
        const rollup = view.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
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
