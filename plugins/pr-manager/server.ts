import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, repositoryNameSchema, type HostPullRequest } from "./contract.js";
import { PULL_REQUEST_STATUSES } from "./pr-status.js";
import { SORT_ORDERS, sortPullRequests } from "./pr-list.js";
import { buildThreadPrompt } from "./thread-prompt.js";

const statusSchema = z.enum(PULL_REQUEST_STATUSES);
// Width of the status column in `bb pr-manager list`, derived so that adding a longer
// status keeps the summary lines underneath it aligned.
const statusColumn = Math.max(...PULL_REQUEST_STATUSES.map((status) => status.length));
const sortOrderSchema = z.enum(SORT_ORDERS);
const pullRequestSchema = z.object({
  key: z.string(), repository: z.string(), number: z.number().int().positive(),
  title: z.string(), url: z.string().url(), status: statusSchema, summary: z.string(),
  isDraft: z.boolean(), headRefName: z.string(), baseRefName: z.string(),
  createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(), projectId: z.string().nullable(),
  projectName: z.string().nullable(), threadId: z.string().nullable(), threadTitle: z.string().nullable(),
  // Unarchiving is broken in BB, so an archived thread cannot be worked in. It is
  // still worth linking to, but the PR needs a fresh thread.
  threadArchived: z.boolean().default(false),
  // Both missing from lists saved before refreshes reused unchanged entries.
  id: z.string().optional(), changeMarker: z.string().optional(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

// Each repository's pull requests are saved and refreshed on their own, so refreshing
// one repository leaves every other repository's list as it was.
const repositoryListSchema = z.object({
  repository: z.string(), prs: z.array(pullRequestSchema), refreshedAt: z.string(),
});
type RepositoryList = z.infer<typeof repositoryListSchema>;
const viewSchema = z.object({
  selectedRepository: repositoryNameSchema.nullable().default(null),
  sortOrder: sortOrderSchema.default("STATUS"),
});
type View = z.infer<typeof viewSchema>;
// The repositories are those of the BB projects, so there is always one selected unless
// no project has a GitHub remote. `list` is null until that repository is first refreshed.
const savedStateSchema = z.object({
  repositories: z.array(z.object({ repository: z.string(), projectName: z.string() })),
  selectedRepository: z.string().nullable(), sortOrder: sortOrderSchema,
  list: repositoryListSchema.nullable(),
});
export type SavedState = z.infer<typeof savedStateSchema>;

export const rpcContract = defineRpcContract({
  prs_list: { input: z.null(), output: savedStateSchema },
  prs_refresh: { input: z.object({ repository: repositoryNameSchema }), output: savedStateSchema },
  // The whole persisted view is sent at once, so there is no partial-update merge.
  prs_set_view: {
    input: z.object({ repository: repositoryNameSchema, sortOrder: sortOrderSchema }),
    output: savedStateSchema,
  },
  // Returns null when the PR has no live thread, so the caller knows to ask for
  // instructions and create one instead of navigating to a dead thread. An archived
  // thread is reported with `archived: true`, which also means a new one is needed.
  prs_resolve_thread: {
    input: z.object({ repository: z.string(), number: z.number().int().positive() }),
    output: z.object({ threadId: z.string().nullable(), archived: z.boolean() }),
  },
  prs_create_thread: {
    input: z.object({
      repository: z.string(), number: z.number().int().positive(), title: z.string(),
      url: z.string().url(), headRefName: z.string(), baseRefName: z.string(), projectId: z.string(),
      instructions: z.string().trim().min(1),
    }),
    output: z.object({ threadId: z.string() }),
  },
});

// `owner/name` as the remote spells it, which is how the repository is shown.
function gitHubRepository(remote: string | null): string | null {
  if (remote === null) return null;
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "");
  return cleaned.match(/(?:git@|https?:\/\/)?github\.com[:/]([^/]+\/[^/]+)$/i)?.[1] ?? null;
}
const normalizeGitHubRepository = (remote: string | null) => gitHubRepository(remote)?.toLowerCase() ?? null;

const linkKey = (repository: string, number: number) => `thread:${repository.toLowerCase()}#${number}`;
const LIST_KEY_PREFIX = "pull-requests:";
const listKey = (repository: string) => `${LIST_KEY_PREFIX}${repository.toLowerCase()}`;
const VIEW_KEY = "pull-request-view";
// The single list every repository shared before lists were saved per repository.
const LEGACY_LIST_KEY = "pull-request-list-v2";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mergedWithinDays: {
      type: "select", label: "Keep merged PRs visible", options: ["7", "14", "30"], default: "14",
    },
    maximumMergedPullRequests: {
      type: "select", label: "Maximum merged PRs per project", options: ["25", "50", "100"], default: "50",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function projectAndThreadContext() {
    const projects = await bb.sdk.projects.list();
    const allThreads = (await Promise.all(projects.flatMap((project) => [
      bb.sdk.threads.list({ projectId: project.id, archived: false, limit: 500 }),
      bb.sdk.threads.list({ projectId: project.id, archived: true, limit: 500 }),
    ]))).flat();
    return { projects, allThreads };
  }

  async function readRepositoryList(repository: string): Promise<RepositoryList | null> {
    const parsed = repositoryListSchema.safeParse(await bb.storage.kv.get<unknown>(listKey(repository)));
    return parsed.success ? parsed.data : null;
  }

  // One entry per GitHub repository, named after the first project that uses it.
  async function projectRepositories(): Promise<SavedState["repositories"]> {
    const byKey = new Map<string, SavedState["repositories"][number]>();
    for (const project of await bb.sdk.projects.list()) {
      const repository = gitHubRepository(project.gitRemoteUrl);
      if (repository !== null && !byKey.has(listKey(repository))) byKey.set(listKey(repository), { repository, projectName: project.name });
    }
    return [...byKey.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, undefined, { sensitivity: "base" }));
  }

  async function readView(): Promise<View> {
    const parsed = viewSchema.safeParse(await bb.storage.kv.get<unknown>(VIEW_KEY));
    return parsed.success ? parsed.data : { selectedRepository: null, sortOrder: "STATUS" };
  }

  function findRepository(repositories: SavedState["repositories"], repository: string) {
    const found = repositories.find((candidate) => listKey(candidate.repository) === listKey(repository));
    if (found === undefined) throw new Error(`${repository} is not the GitHub repository of any BB project.`);
    return found.repository;
  }

  // The saved selection, or the first project's repository once that selection is gone.
  // `repository` shows another repository without changing the saved selection.
  async function readSavedState(repository?: string): Promise<SavedState> {
    const [repositories, view] = await Promise.all([projectRepositories(), readView()]);
    const { selectedRepository: savedRepository } = view;
    const saved = savedRepository === null ? undefined
      : repositories.find((candidate) => listKey(candidate.repository) === listKey(savedRepository));
    const selectedRepository = repository !== undefined ? findRepository(repositories, repository)
      : saved?.repository ?? repositories[0]?.repository ?? null;
    const list = selectedRepository === null ? null : await readRepositoryList(selectedRepository);
    return { repositories, selectedRepository, sortOrder: view.sortOrder, list };
  }

  async function saveView(view: View) {
    await bb.storage.kv.set(VIEW_KEY, view);
  }

  async function linkProjectsAndThreads(
    pullRequests: HostPullRequest[], context: Awaited<ReturnType<typeof projectAndThreadContext>>,
  ): Promise<PullRequest[]> {
    const projectByRepository = new Map<string, (typeof context.projects)[number]>();
    const usableThreads = context.allThreads.filter((thread) => thread.status !== "error");
    for (const project of context.projects) {
      const repository = normalizeGitHubRepository(project.gitRemoteUrl);
      if (repository !== null && !projectByRepository.has(repository)) projectByRepository.set(repository, project);
    }
    const prs: PullRequest[] = [];
    for (const pr of pullRequests) {
      const project = projectByRepository.get(pr.repository.toLowerCase()) ?? null;
      let thread = null;
      const storedThreadId = await bb.storage.kv.get<string>(linkKey(pr.repository, pr.number));
      if (storedThreadId !== undefined) thread = usableThreads.find((candidate) => candidate.id === storedThreadId) ?? null;
      if (thread === null && project !== null) {
        thread = usableThreads.find((candidate) =>
          candidate.projectId === project.id && candidate.environmentBranchName === pr.headRefName) ?? null;
      }
      if (thread === null && project !== null) {
        const repositoryNumber = `${pr.repository.toLowerCase()}#${pr.number}`;
        const numberPattern = new RegExp(`#${pr.number}(?:\\b|:)`);
        thread = usableThreads.find((candidate) => {
          if (candidate.projectId !== project.id) return false;
          const title = (candidate.title ?? candidate.titleFallback ?? "").toLowerCase();
          return title.includes(repositoryNumber) || numberPattern.test(title);
        }) ?? null;
      }
      prs.push({
        ...pr, key: `${pr.repository}#${pr.number}`, projectId: project?.id ?? null,
        projectName: project?.name ?? null, threadId: thread?.id ?? null,
        threadTitle: thread?.title ?? thread?.titleFallback ?? null,
        threadArchived: thread !== null && thread.archivedAt !== null,
      });
    }
    return prs;
  }

  async function refreshPullRequests(requested: string): Promise<SavedState> {
    const [{ mergedWithinDays, maximumMergedPullRequests }, hosts, context, repositories] = await Promise.all([
      settings.get(), bb.sdk.hosts.list(), projectAndThreadContext(), projectRepositories(),
    ]);
    const repository = findRepository(repositories, requested);
    const connected = hosts.filter((candidate) => candidate.status === "connected");
    if (connected.length === 0) throw new Error("No connected BB machine is available.");
    const projectHostIds = new Set(context.projects.flatMap((project) => project.sources.map((source) => source.hostId)));
    const queryHost = connected.find((candidate) => projectHostIds.has(candidate.id)) ?? connected[0]!;
    const savedPullRequests = ((await readRepositoryList(repository))?.prs ?? [])
      .flatMap(({ id, changeMarker, ...pr }) => id === undefined || changeMarker === undefined ? [] : [{ ...pr, id, changeMarker }]);
    const raw = await host.call("listPullRequests", {
      repository, mergedWithinDays: Number(mergedWithinDays), maximumMergedPullRequests: Number(maximumMergedPullRequests),
      savedPullRequests,
    }, { hostId: queryHost.id });
    const list: RepositoryList = {
      repository, prs: await linkProjectsAndThreads(raw.pullRequests, context), refreshedAt: new Date().toISOString(),
    };
    await bb.storage.kv.set(listKey(repository), list);
    // Lists of repositories that no project uses any more would never be shown again.
    const kept = new Set(repositories.map((candidate) => listKey(candidate.repository)));
    const stale = (await bb.storage.kv.list(LIST_KEY_PREFIX)).filter((key) => !kept.has(key));
    await Promise.all(stale.map((key) => bb.storage.kv.delete(key)));
    return readSavedState(repository);
  }

  async function resolveLinkedThread(repository: string, number: number): Promise<{ threadId: string; archived: boolean } | null> {
    const existing = (await readRepositoryList(repository))?.prs.find((candidate) => candidate.number === number);
    if (existing?.threadId === null || existing?.threadId === undefined) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId: existing.threadId });
      return thread.status === "error" ? null : { threadId: existing.threadId, archived: thread.archivedAt !== null };
    } catch {
      // A missing thread is stale linkage. Report it as absent so a replacement is provisioned.
      return null;
    }
  }

  bb.rpc.register(rpcContract, {
    prs_list: () => readSavedState(),
    prs_refresh: ({ repository }) => refreshPullRequests(repository),
    prs_set_view: async ({ repository, sortOrder }) => {
      const selectedRepository = findRepository(await projectRepositories(), repository);
      await saveView({ selectedRepository, sortOrder });
      return readSavedState();
    },
    prs_resolve_thread: async ({ repository, number }) => {
      const linked = await resolveLinkedThread(repository, number);
      return { threadId: linked?.threadId ?? null, archived: linked?.archived ?? false };
    },
    prs_create_thread: async (input) => {
      const projects = await bb.sdk.projects.list();
      const project = projects.find((candidate) => candidate.id === input.projectId);
      if (project === undefined) throw new Error("The matching BB project no longer exists.");
      if (normalizeGitHubRepository(project.gitRemoteUrl) !== input.repository.toLowerCase()) {
        throw new Error("The selected project does not match this pull request repository.");
      }
      // An archived link is not reusable, so it does not block creating a replacement.
      const alreadyLinked = await resolveLinkedThread(input.repository, input.number);
      if (alreadyLinked !== null && !alreadyLinked.archived) return { threadId: alreadyLinked.threadId };

      const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
      if (source === undefined) throw new Error("The matching BB project has no workspace source.");
      const prepared = await host.call("preparePullRequestBranch", {
        projectPath: source.path, repository: input.repository, number: input.number,
      }, { hostId: source.hostId });
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: {
          type: "host", hostId: source.hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: prepared.ref } },
        },
        prompt: buildThreadPrompt(input),
        title: `PR #${input.number}: ${input.title}`,
        origin: "plugin",
      });
      await bb.storage.kv.set(linkKey(input.repository, input.number), thread.id);
      const list = await readRepositoryList(input.repository);
      if (list !== null) {
        await bb.storage.kv.set(listKey(input.repository), {
          ...list,
          prs: list.prs.map((pr) => pr.number === input.number
            ? { ...pr, threadId: thread.id, threadTitle: thread.title ?? thread.titleFallback ?? null, threadArchived: false }
            : pr),
        });
      }
      bb.realtime.publish("prs-changed", { key: `${input.repository}#${input.number}` });
      return { threadId: thread.id };
    },
  });

  bb.cli.register({
    name: "pr-manager", summary: "List pull requests tracked by PR Manager",
    commands: [
      { name: "list", summary: "List cached PR statuses", usage: "bb pr-manager list [--repo owner/name] [--json]" },
      { name: "refresh", summary: "Refresh PR statuses from GitHub", usage: "bb pr-manager refresh [--repo owner/name] [--json]" },
    ],
    // Without --repo, both commands act on the repository selected in the panel.
    async run(argv) {
      const usage = "Usage: bb pr-manager <list|refresh> [--repo owner/name] [--json]";
      if (argv[0] !== "list" && argv[0] !== "refresh") return { exitCode: 1, stderr: usage };
      const repoFlag = argv.indexOf("--repo");
      const requested = repoFlag === -1 ? null : repositoryNameSchema.safeParse(argv[repoFlag + 1]);
      if (requested !== null && !requested.success) return { exitCode: 1, stderr: usage };
      const selected = await readSavedState(requested?.data);
      if (selected.selectedRepository === null) return { exitCode: 1, stderr: "No BB project has a GitHub remote." };
      const state = argv[0] === "refresh" ? await refreshPullRequests(selected.selectedRepository) : selected;
      if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(state) };
      if (state.list === null) return { exitCode: 0, stdout: `No saved pull requests for ${state.selectedRepository}. Run \`bb pr-manager refresh\`.` };
      if (state.list.prs.length === 0) return { exitCode: 0, stdout: `No current pull requests in ${state.selectedRepository}.` };
      return { exitCode: 0, stdout: sortPullRequests(state.list.prs, state.sortOrder)
        .map((pr) => `${pr.status.padEnd(statusColumn)} ${pr.repository}#${pr.number}  ${pr.title}\n${" ".repeat(statusColumn + 1)}${pr.summary}`).join("\n") };
    },
  });
  await bb.storage.kv.delete(LEGACY_LIST_KEY);
  bb.log.info("loaded");
}
