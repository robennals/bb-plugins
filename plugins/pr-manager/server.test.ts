import { createFakePluginHost, makeThreadResponse, type ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostContract, type HostPullRequest } from "./contract.js";
import plugin, { rpcContract } from "./server.js";

const hostPr = (repository: string, number: number, overrides: Partial<HostPullRequest> = {}): HostPullRequest => ({
  id: `id-${number}`, repository, number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`,
  status: "OPEN", summary: "No review requested yet", isDraft: false, headRefName: `branch-${number}`,
  baseRefName: "main", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", mergedAt: null, stack: null,
  changeMarker: "2026-09-01T00:00:00Z", unaddressedFeedback: null, ...overrides,
});
const withFeedback = (number: number, latestAt: string) => hostPr("acme/web", number, {
  status: "FEEDBACK", summary: "Feedback from octocat needs a response",
  unaddressedFeedback: { latestAt, statusWhenMuted: "WAITING", summaryWhenMuted: "Muted feedback from octocat · Waiting for hubot" },
});
const project = (id: string, name: string, gitRemoteUrl: string | null) => ({
  id, name, gitRemoteUrl, sources: [{ hostId: "host-1", path: `/work/${name}`, isDefault: true }],
});
const webProject = project("project-web", "web", "git@github.com:acme/web.git");
const apiProject = project("project-api", "API", "https://github.com/Acme/Api.git");
const spawnedThread = makeThreadResponse({ id: "thread-new", projectId: webProject.id, title: "PR #1: PR 1", environmentId: null });
const spawnedEnvironment = { path: "/worktrees/thread-new/web", branchName: "bb/pr-1-pr-1-thread-new", hostId: "host-1" };

// BB's projects and GitHub's PRs as the plugin sees them; tests change both between calls.
async function loadPlugin(pullRequests: HostPullRequest[]) {
  const world = { projects: [webProject, apiProject], pullRequests, prepared: { ref: "origin/branch-1", tracksHeadBranch: true },
    // What the new thread's worktree reports each time it is asked, the last one from then on.
    // null is a thread that has no environment yet.
    environmentStatuses: ["ready"] as (string | null)[],
  };
  const listCalls: unknown[] = [];
  const spawnCalls: unknown[] = [];
  const renameCalls: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { list: () => world.projects },
      threads: {
        list: () => [], spawn: (args: unknown) => { spawnCalls.push(args); return spawnedThread; },
        get: () => ({ ...spawnedThread, environmentId: world.environmentStatuses[0] === null ? null : "env-new" }),
      },
      environments: { get: () => ({ ...spawnedEnvironment, status: world.environmentStatuses[0] }) },
      hosts: { list: () => [{ id: "host-1", status: "connected" }] },
    },
    experimental_callHostRpc: ({ method, input }: ExperimentalFakeHostRpcCall) => {
      if (method === "preparePullRequestBranch") return world.prepared;
      if (method === "renameBranchToPullRequestHead") { renameCalls.push(input); return null; }
      if (method !== "listPullRequests") throw new Error(`unexpected host call ${method}`);
      listCalls.push(input);
      const { repository } = hostContract.listPullRequests.input.parse(input);
      return { pullRequests: world.pullRequests.filter((pr) => pr.repository.toLowerCase() === repository.toLowerCase()) };
    },
  });
  await plugin(bb);
  const call = async (method: "prs_list" | "prs_refresh" | "prs_set_view" | "prs_set_feedback_muted", input: unknown) =>
    rpcContract[method].output.parse(await harness.callRpc(method, input));
  return { world, harness, listCalls, spawnCalls, renameCalls, call };
}
const createThreadForPr1 = {
  repository: "acme/web", number: 1, title: "PR 1", url: "https://github.com/acme/web/pull/1",
  headRefName: "branch-1", baseRefName: "main", projectId: webProject.id, instructions: "Fix it.",
};

afterEach(() => { vi.useRealTimers(); });

describe("per-project pull request lists", () => {
  it("offers each project's GitHub repository once, by project name, before anything is refreshed", async () => {
    const { world, call, listCalls } = await loadPlugin([]);
    world.projects.push(project("project-docs", "docs", "git@gitlab.com:acme/docs.git"), project("project-web-2", "web copy", "git@github.com:acme/web.git"));
    expect(await call("prs_list", null)).toEqual({
      repositories: [{ repository: "Acme/Api", projectName: "API" }, { repository: "acme/web", projectName: "web" }],
      selectedRepository: "Acme/Api", sortOrder: "STATUS", list: null,
    });
    expect(listCalls).toEqual([]);
  });

  it("refreshes only the selected repository and leaves the other's saved list alone", async () => {
    const { world, call, listCalls } = await loadPlugin([hostPr("acme/web", 1), hostPr("Acme/Api", 2)]);
    await call("prs_refresh", { repository: "acme/web" });
    const webBefore = (await call("prs_set_view", { repository: "acme/web", sortOrder: "UPDATED" })).list;
    world.pullRequests = [hostPr("acme/web", 1, { status: "MERGED" }), hostPr("Acme/Api", 2), hostPr("Acme/Api", 3)];
    const api = await call("prs_refresh", { repository: "acme/api" });
    expect(listCalls.map((input) => hostContract.listPullRequests.input.parse(input).repository)).toEqual(["acme/web", "Acme/Api"]);
    expect(api.selectedRepository).toBe("Acme/Api");
    expect(api.list?.prs.map((pr) => pr.number)).toEqual([2, 3]);
    const web = await call("prs_set_view", { repository: "acme/web", sortOrder: "UPDATED" });
    expect(web.list).toEqual(webBefore);
    expect(web.list?.prs[0]?.status).toBe("OPEN");
    expect(await call("prs_list", null)).toMatchObject({ selectedRepository: "acme/web", sortOrder: "UPDATED" });
  });

  it("hands the host that repository's saved pull requests, so it can reuse the unchanged ones", async () => {
    const { call, listCalls } = await loadPlugin([hostPr("acme/web", 1), hostPr("Acme/Api", 2)]);
    await call("prs_refresh", { repository: "Acme/Api" });
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_refresh", { repository: "acme/web" });
    expect(listCalls.map((input) => hostContract.listPullRequests.input.parse(input).savedPullRequests))
      .toEqual([[], [], [hostPr("acme/web", 1)]]);
  });

  it("leaves a recently refreshed list alone when asked to refresh only a stale one", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-01T12:00:00Z"), toFake: ["Date"] });
    const { call, listCalls } = await loadPlugin([hostPr("acme/web", 1)]);
    const first = await call("prs_refresh", { repository: "acme/web", unlessRefreshedWithinSeconds: 60 });
    expect(listCalls).toHaveLength(1);
    vi.setSystemTime(new Date("2026-09-01T12:00:59Z"));
    expect(await call("prs_refresh", { repository: "acme/web", unlessRefreshedWithinSeconds: 60 })).toEqual(first);
    expect(listCalls).toHaveLength(1);
    vi.setSystemTime(new Date("2026-09-01T12:01:00Z"));
    await call("prs_refresh", { repository: "acme/web", unlessRefreshedWithinSeconds: 60 });
    expect(listCalls).toHaveLength(2);
    await call("prs_refresh", { repository: "acme/web" });
    expect(listCalls).toHaveLength(3);
  });

  it("asks GitHub once when the same repository is refreshed twice at the same moment", async () => {
    const { call, listCalls } = await loadPlugin([hostPr("acme/web", 1)]);
    const [one, other] = await Promise.all([call("prs_refresh", { repository: "acme/web" }), call("prs_refresh", { repository: "acme/web" })]);
    expect(listCalls).toHaveLength(1);
    expect(other).toEqual(one);
  });

  it("refuses repositories that are no project's", async () => {
    const { call } = await loadPlugin([]);
    await expect(call("prs_refresh", { repository: "acme/other" })).rejects.toThrow("not the GitHub repository of any BB project");
    await expect(call("prs_set_view", { repository: "acme/other", sortOrder: "STATUS" })).rejects.toThrow("not the GitHub repository");
  });

  it("falls back to the first project, and forgets the list, once a project is removed", async () => {
    const { world, call } = await loadPlugin([hostPr("acme/web", 1)]);
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_set_view", { repository: "acme/web", sortOrder: "STATUS" });
    world.projects = [apiProject];
    expect(await call("prs_list", null)).toMatchObject({ selectedRepository: "Acme/Api", list: null });
    await call("prs_refresh", { repository: "Acme/Api" });
    world.projects = [webProject, apiProject];
    expect((await call("prs_set_view", { repository: "acme/web", sortOrder: "STATUS" })).list).toBeNull();
  });

  it("records a new thread in its repository's saved list and finds it again", async () => {
    const { harness, call } = await loadPlugin([hostPr("acme/web", 1), hostPr("Acme/Api", 1)]);
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_refresh", { repository: "Acme/Api" });
    await harness.callRpc("prs_create_thread", createThreadForPr1);
    expect((await call("prs_set_view", { repository: "acme/web", sortOrder: "STATUS" })).list?.prs[0]?.threadId).toBe("thread-new");
    expect((await call("prs_set_view", { repository: "Acme/Api", sortOrder: "STATUS" })).list?.prs[0]?.threadId).toBeNull();
    expect(await harness.callRpc("prs_resolve_thread", { repository: "acme/web", number: 1 }))
      .toEqual({ threadId: "thread-new", archived: false });
    expect(await harness.callRpc("prs_resolve_thread", { repository: "Acme/Api", number: 1 }))
      .toEqual({ threadId: null, archived: false });
  });

  it("acts on the selected repository from the CLI unless --repo names another", async () => {
    const { harness, call, listCalls } = await loadPlugin([hostPr("acme/web", 1), hostPr("Acme/Api", 2)]);
    expect((await harness.runCli(["list"])).stdout).toContain("No saved pull requests for Acme/Api");
    await harness.runCli(["refresh"]);
    expect(listCalls).toHaveLength(1);
    expect((await harness.runCli(["list"])).stdout).toContain("Acme/Api#2");
    const refreshed = await harness.runCli(["refresh", "--repo", "acme/web", "--json"]);
    expect(rpcContract.prs_list.output.parse(JSON.parse(refreshed.stdout)).list?.prs.map((pr) => pr.number)).toEqual([1]);
    expect((await call("prs_list", null)).selectedRepository).toBe("Acme/Api");
    expect((await harness.runCli(["refresh", "--repo"])).exitCode).toBe(1);
  });
});

describe("muting feedback", () => {
  const shown = (state: Awaited<ReturnType<Awaited<ReturnType<typeof loadPlugin>>["call"]>>) =>
    state.list?.prs.map((pr) => [pr.number, pr.status, pr.summary, pr.feedbackMuted]);

  it("shows a muted pull request as waiting, in the panel and the CLI, until it is unmuted", async () => {
    const { harness, call } = await loadPlugin([withFeedback(1, "2026-09-01T10:00:00Z"), withFeedback(2, "2026-09-01T10:00:00Z")]);
    await call("prs_refresh", { repository: "acme/web" });
    const muted = await call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: true });
    expect(shown(muted)).toEqual([
      [1, "WAITING", "Muted feedback from octocat · Waiting for hubot", true],
      [2, "FEEDBACK", "Feedback from octocat needs a response", false],
    ]);
    expect(shown(await call("prs_refresh", { repository: "acme/web" }))).toEqual(shown(muted));
    expect((await harness.runCli(["list", "--repo", "acme/web"])).stdout).toContain("WAITING       acme/web#1");
    const unmuted = await call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: false });
    expect(shown(unmuted)?.[0]).toEqual([1, "FEEDBACK", "Feedback from octocat needs a response", false]);
  });

  it("shows the feedback again once there is more of it", async () => {
    const { world, call } = await loadPlugin([withFeedback(1, "2026-09-01T10:00:00Z")]);
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: true });
    world.pullRequests = [withFeedback(1, "2026-09-02T09:00:00Z")];
    expect(shown(await call("prs_refresh", { repository: "acme/web" }))).toEqual([[1, "FEEDBACK", "Feedback from octocat needs a response", false]]);
  });

  it("stays muted while the feedback is answered and comes back unchanged", async () => {
    const { world, call } = await loadPlugin([withFeedback(1, "2026-09-01T10:00:00Z")]);
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: true });
    world.pullRequests = [hostPr("acme/web", 1, { status: "FAILING", summary: "1 check is failing" })];
    expect(shown(await call("prs_refresh", { repository: "acme/web" }))).toEqual([[1, "FAILING", "1 check is failing", false]]);
    world.pullRequests = [withFeedback(1, "2026-09-01T10:00:00Z")];
    expect(shown(await call("prs_refresh", { repository: "acme/web" }))?.[0]?.[1]).toBe("WAITING");
  });

  it("hands the host the status GitHub's data gives, not the muted one", async () => {
    const { call, listCalls } = await loadPlugin([withFeedback(1, "2026-09-01T10:00:00Z")]);
    await call("prs_refresh", { repository: "acme/web" });
    await call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: true });
    await call("prs_refresh", { repository: "acme/web" });
    expect(hostContract.listPullRequests.input.parse(listCalls[1]).savedPullRequests).toEqual([withFeedback(1, "2026-09-01T10:00:00Z")]);
  });

  it("refuses to mute a pull request with no feedback", async () => {
    const { call } = await loadPlugin([hostPr("acme/web", 1)]);
    await call("prs_refresh", { repository: "acme/web" });
    await expect(call("prs_set_feedback_muted", { repository: "acme/web", number: 1, muted: true })).rejects.toThrow("acme/web#1 has no feedback to mute");
  });
});

describe("the branch of a new pull request thread", () => {
  const spawnedFrom = (ref: string) => [{ environment: { workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: ref } } } }];

  it("starts from origin's branch and takes its name once the worktree is ready", async () => {
    vi.useFakeTimers();
    const { world, harness, spawnCalls, renameCalls } = await loadPlugin([hostPr("acme/web", 1)]);
    world.environmentStatuses = [null];
    await harness.callRpc("prs_create_thread", createThreadForPr1);
    expect(spawnCalls).toMatchObject(spawnedFrom("origin/branch-1"));
    world.environmentStatuses = ["provisioning"];
    await vi.advanceTimersByTimeAsync(1000);
    expect(renameCalls).toEqual([]);
    world.environmentStatuses = ["ready"];
    await vi.advanceTimersByTimeAsync(1000);
    expect(renameCalls).toEqual([
      { worktreePath: "/worktrees/thread-new/web", createdBranch: "bb/pr-1-pr-1-thread-new", headRefName: "branch-1" },
    ]);
  });

  it("leaves the branch alone, and says so in the log, when the worktree fails to set up", async () => {
    const { world, harness, renameCalls } = await loadPlugin([hostPr("acme/web", 1)]);
    world.environmentStatuses = ["error"];
    await harness.callRpc("prs_create_thread", createThreadForPr1);
    await vi.waitFor(() => expect(harness.logEntries.map((entry) => entry.message))
      .toContain("Left the branch of acme/web#1's thread as BB named it: its worktree is error"));
    expect(renameCalls).toEqual([]);
  });

  it("keeps the name BB gave it when the pull request's branch is not on origin", async () => {
    const { world, harness, spawnCalls, renameCalls } = await loadPlugin([hostPr("acme/web", 1)]);
    world.prepared = { ref: "refs/bb/pr-manager/pull/1", tracksHeadBranch: false };
    await harness.callRpc("prs_create_thread", createThreadForPr1);
    expect(spawnCalls).toMatchObject(spawnedFrom("refs/bb/pr-manager/pull/1"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(renameCalls).toEqual([]);
  });
});
