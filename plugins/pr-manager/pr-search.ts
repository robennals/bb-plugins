// One GraphQL search returns every field the classifier needs, so a refresh is two
// requests rather than two searches plus one query per pull request. The per-PR
// fan-out grows with the number of open pull requests; this does not.
const PULL_REQUEST_FIELDS = `number title url state isDraft headRefName baseRefName reviewDecision createdAt updatedAt mergedAt
      repository{nameWithOwner}
      author{__typename login}
      reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login}}}}
      reviews(last:50){nodes{state submittedAt author{__typename login}}}
      comments(last:50){nodes{createdAt author{__typename login}}}
      commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){
        totalCount
        nodes{
          __typename
          ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{workflow{name}}}}
          ... on StatusContext{context state createdAt}
        }
      }}}}}`;
export const PULL_REQUEST_SEARCH_DOCUMENT = `query($q:String!,$limit:Int!){
  search(query:$q,type:ISSUE,first:$limit){
    nodes{
      ... on PullRequest{
      ${PULL_REQUEST_FIELDS}
      }
    }
  }
}`;

// `archived:false` keeps out pull requests in archived repositories: they cannot be
// reviewed, updated or merged, so listing one is only noise.
function searchQuery(filters: string[]): string {
  return ["author:@me", "is:pr", "archived:false", ...filters, "sort:updated-desc"].join(" ");
}
export function openPullRequestQuery(): string {
  return searchQuery(["state:open"]);
}
export function mergedPullRequestQuery(since: string): string {
  return searchQuery(["is:merged", `merged:>=${since}`]);
}
export function pullRequestSearchArgs(query: string, limit: number): string[] {
  return ["api", "graphql", "-f", `query=${PULL_REQUEST_SEARCH_DOCUMENT}`, "-f", `q=${query}`, "-F", `limit=${limit}`];
}
