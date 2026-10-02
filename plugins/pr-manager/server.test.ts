import { createFakePluginHost, makeThreadResponse, type ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { hostContract, type HostPullRequest } from "./contract.js";
import plugin, { rpcContract } from "./server.js";

const hostPr = (repository: string, number: number, overrides: Partial<HostPullRequest> = {}): HostPullRequest => ({
  id: `id-${number}`, repository, number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`,
  status: "OPEN", summary: "No review requested yet", isDraft: false, headRefName: `branch-${number}`,
  baseRefName: "main", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", mergedAt: null,
  changeMarker: "2026-09-01T00:00:00Z", ...overrides,
});
const project = (id: string, name: string, gitRemoteUrl: string | null) => ({
  id, name, gitRemoteUrl, sources: [{ hostId: "host-1", path: `/work/${name}`, isDefault: true }],
});
const webProject = project("project-web", "web", "git@github.com:acme/web.git");
const apiProject = project("project-api", "API", "https://github.com/Acme/Api.git");
const spawnedThread = makeThreadResponse({ id: "thread-new", projectId: webProject.id, title: "PR #1: PR 1" });

// BB's projects and GitHub's PRs as the plugin sees them; tests change both between calls.
async function loadPlugin(pullRequests: HostPullRequest[]) {
  const world = { projects: [webProject, apiProject], pullRequests };
  const listCalls: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { list: () => world.projects },
      threads: { list: () => [], spawn: () => spawnedThread, get: () => spawnedThread },
      hosts: { list: () => [{ id: "host-1", status: "connected" }] },
    },
    experimental_callHostRpc: ({ method, input }: ExperimentalFakeHostRpcCall) => {
      if (method === "preparePullRequestBranch") return { ref: "refs/bb/pull/1" };
      if (method !== "listPullRequests") throw new Error(`unexpected host call ${method}`);
      listCalls.push(input);
      const { repository } = hostContract.listPullRequests.input.parse(input);
      return { pullRequests: world.pullRequests.filter((pr) => pr.repository.toLowerCase() === repository.toLowerCase()) };
    },
  });
  await plugin(bb);
  const call = async (method: "prs_list" | "prs_refresh" | "prs_set_view", input: unknown) =>
    rpcContract[method].output.parse(await harness.callRpc(method, input));
  return { world, harness, listCalls, call };
}

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
    await harness.callRpc("prs_create_thread", {
      repository: "acme/web", number: 1, title: "PR 1", url: "https://github.com/acme/web/pull/1",
      headRefName: "branch-1", baseRefName: "main", projectId: webProject.id, instructions: "Fix it.",
    });
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
