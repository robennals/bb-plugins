import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  defineRpcContract,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  branchChangesSchema,
  changeStatusSchema,
  hostContract,
} from "./contract.js";
import type { FlatEntry } from "./lib/tree.js";
import { resolveWithinRoot } from "./lib/paths.js";
import {
  parseExcludedNames,
  shouldFallBackToBbListing,
  walkDirectory,
} from "./lib/walk.js";

/** BB's own recursive listing is capped at 10k; the local walk gets more room. */
const LOCAL_ENTRY_LIMIT = 40_000;
const REMOTE_ENTRY_LIMIT = 10_000;

/** Inline images round-trip as base64 through RPC, so keep them modest. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

// The three dependency directories big enough to truncate a listing on their
// own, across the JS, PHP and Go worlds. Editable in settings.
const DEFAULT_EXCLUDED_DIRECTORIES = ".git\nnode_modules\nvendor";

const scopeSchema = z
  .object({
    kind: z.enum(["thread", "environment", "project"]),
    id: z.string().min(1),
  })
  .strict();

type Scope = z.infer<typeof scopeSchema>;

const workspaceSchema = z.object({
  ref: scopeSchema,
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  kind: z.enum(["project", "environment"]),
});

const entrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});

const resolvedScopeSchema = z.object({
  root: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  isLocal: z.boolean(),
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  ref: scopeSchema,
});

export const rpcContract = defineRpcContract({
  workspaces: {
    input: z.null(),
    output: z.object({
      workspaces: z.array(workspaceSchema),
      defaultRef: scopeSchema.nullable(),
    }),
  },
  tree: {
    input: z.object({ scope: scopeSchema, includeHidden: z.boolean() }).strict(),
    output: z.object({
      scope: resolvedScopeSchema,
      entries: z.array(entrySchema),
      truncated: z.boolean(),
      /** `remote` listings cannot include dotfiles — BB's API drops them. */
      listing: z.enum(["local", "remote"]),
      excluded: z.array(z.string()),
      /** What this branch changed, or why that could not be worked out. */
      changes: branchChangesSchema,
    }),
  },
  read: {
    input: z.object({ scope: scopeSchema, path: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sizeBytes: z.number(),
        absolutePath: z.string(),
      }),
      z.object({
        kind: z.literal("image"),
        dataUrl: z.string(),
        sizeBytes: z.number(),
        absolutePath: z.string(),
      }),
      z.object({
        kind: z.literal("binary"),
        sizeBytes: z.number(),
        absolutePath: z.string(),
        reason: z.string(),
      }),
    ]),
  },
  diff: {
    input: z
      .object({
        scope: scopeSchema,
        path: z.string().min(1),
        baseCommit: z.string().min(1),
        status: changeStatusSchema,
        from: z.string().nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("patch"),
        patch: z.string(),
        oldContent: z.string().nullable(),
        newContent: z.string().nullable(),
        oldPath: z.string(),
        newPath: z.string(),
      }),
      z.object({ kind: z.literal("unchanged") }),
      z.object({ kind: z.literal("binary") }),
      z.object({ kind: z.literal("error"), reason: z.string() }),
    ]),
  },
});

/** A browsable directory: what a scope reference turns into. */
export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;
export type WorkspaceOption = z.infer<typeof workspaceSchema>;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    excludedDirectories: {
      type: "string",
      label: "Excluded directories (one name per line)",
      experimental_multiline: true,
      default: DEFAULT_EXCLUDED_DIRECTORIES,
    },
    baseBranch: {
      type: "string",
      label: "Branch to diff against (blank = detect the default branch)",
      default: "",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function excludedNames(): Promise<Set<string>> {
    const { excludedDirectories } = await settings.get();
    return parseExcludedNames(excludedDirectories);
  }

  let cachedLocalHostId: string | null = null;

  /**
   * The daemon running on THIS machine, read from the id file BB's own
   * primary-host resolution trusts first.
   *
   * `system.config().primaryHostId` is deliberately not used as a locality
   * test: when the data directory has no id file BB falls back to "the only
   * connected host", which on a headless server is somebody else's laptop.
   * Walking that host's paths with node:fs would read the server's disk and
   * quietly serve the wrong machine's files.
   */
  async function localHostId(): Promise<string | null> {
    if (cachedLocalHostId !== null) return cachedLocalHostId;
    const { dataDir } = await bb.sdk.system.config();
    try {
      const value = (await readFile(path.join(dataDir, "host-id"), "utf8")).trim();
      // Only a successful read is cached, so a daemon that initialises after
      // this plugin loaded is picked up on the next call.
      if (value !== "") cachedLocalHostId = value;
      return cachedLocalHostId;
    } catch {
      return null;
    }
  }

  async function hostName(hostId: string): Promise<string> {
    try {
      const found = await bb.sdk.hosts.get({ hostId });
      return found.name;
    } catch {
      return "this machine";
    }
  }

  /**
   * `projects.get` serves standard projects only — asking it for the singleton
   * personal project is a 404 — so fall back to the list that can include it.
   */
  async function project(projectId: string) {
    try {
      return await bb.sdk.projects.get({ projectId });
    } catch {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.find((entry) => entry.id === projectId) ?? null;
    }
  }

  async function projectRoot(
    projectId: string,
  ): Promise<{ root: string; hostId: string; name: string } | string> {
    const found = await project(projectId);
    if (found === null) return "That project no longer exists.";

    const source = found.sources.find((entry) => entry.isDefault) ?? found.sources[0];
    if (source === undefined) {
      return `${found.name} has no checkout on any machine yet.`;
    }
    return { root: source.path, hostId: source.hostId, name: found.name };
  }

  /** Turn whatever the caller pointed at into one browsable directory. */
  async function resolveScope(
    scope: Scope,
  ): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; reason: string }> {
    let environmentId: string | null = null;
    let projectId: string | null = null;

    if (scope.kind === "thread") {
      const thread = await bb.sdk.threads.get({ threadId: scope.id });
      environmentId = thread.environmentId;
      projectId = thread.projectId;
    } else if (scope.kind === "environment") {
      environmentId = scope.id;
    } else {
      projectId = scope.id;
    }

    if (environmentId !== null) {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.path !== null) {
        const owner = await project(environment.projectId);
        const local = await localHostId();
        return {
          ok: true,
          scope: {
            root: environment.path,
            hostId: environment.hostId,
            hostName: await hostName(environment.hostId),
            isLocal: environment.hostId === local,
            label: owner?.name ?? "Workspace",
            sublabel:
              environment.branchName ??
              environment.name ??
              (environment.workspaceProvisionType === "personal"
                ? "personal workspace"
                : "workspace"),
            projectId: environment.projectId,
            environmentId,
            ref: scope,
          },
        };
      }
      // A provisioning or torn-down environment has no directory yet. Fall
      // through to the project checkout so the panel still shows something.
      if (projectId === null) projectId = environment.projectId;
    }

    if (projectId === null) {
      return { ok: false, reason: "This thread has no workspace yet." };
    }

    const resolved = await projectRoot(projectId);
    if (typeof resolved === "string") return { ok: false, reason: resolved };

    const local = await localHostId();
    return {
      ok: true,
      scope: {
        root: resolved.root,
        hostId: resolved.hostId,
        hostName: await hostName(resolved.hostId),
        isLocal: resolved.hostId === local,
        label: resolved.name,
        sublabel: "project checkout",
        projectId,
        environmentId: null,
        ref: scope,
      },
    };
  }

  async function listEntries(
    scope: ResolvedScope,
    includeHidden: boolean,
  ): Promise<{
    entries: FlatEntry[];
    truncated: boolean;
    listing: "local" | "remote";
  }> {
    const excluded = await excludedNames();

    if (scope.isLocal) {
      try {
        const result = await walkDirectory({
          root: scope.root,
          excludedNames: excluded,
          includeHidden,
          limit: LOCAL_ENTRY_LIMIT,
        });
        return { ...result, listing: "local" };
      } catch (error) {
        if (!shouldFallBackToBbListing(error)) throw error;
        // The id file said this machine but the directory is not readable here
        // (EACCES, EPERM, EMFILE). Let BB try — it knows how to reach the host
        // even when node:fs cannot.
        bb.log.warn(
          `local walk of ${scope.root} failed (${describe(error)}); falling back to BB's listing`,
        );
      }
    }

    // Remote workspaces go through BB, which walks the host daemon. It applies
    // its own dotfile and node_modules filtering that a plugin cannot turn off.
    const result = await bb.sdk.files.listPaths({
      hostId: scope.hostId,
      path: scope.root,
      includeFiles: true,
      includeDirectories: true,
      limit: REMOTE_ENTRY_LIMIT,
    });
    const entries = result.paths
      .map((entry) => ({ path: entry.path, kind: entry.kind }))
      .filter((entry) => !isExcluded(entry.path, excluded));
    return { entries, truncated: result.truncated, listing: "remote" };
  }

  /**
   * Git failing is never fatal here: a workspace that is not a repository, or a
   * host that is offline, is still a workspace worth browsing. The reason
   * travels to the UI so the explorer can say why nothing is highlighted.
   */
  async function branchChanges(scope: ResolvedScope) {
    const { baseBranch } = await settings.get();
    try {
      return await host.call(
        "branchChanges",
        { root: scope.root, baseBranch: baseBranch.trim() === "" ? null : baseBranch.trim() },
        { hostId: scope.hostId },
      );
    } catch (error) {
      bb.log.warn(`branch changes for ${scope.root} failed: ${describe(error)}`);
      return {
        kind: "unavailable" as const,
        reason: "Could not reach git on the machine holding this workspace.",
      };
    }
  }

  async function readWorkspaceFile(scope: ResolvedScope, relativePath: string) {
    const absolutePath = resolveWithinRoot(scope.root, relativePath);
    const file = await bb.sdk.files.read({
      hostId: scope.hostId,
      path: absolutePath,
      rootPath: scope.root,
    });

    if (file.contentEncoding === "utf8") {
      return {
        kind: "text" as const,
        content: file.content,
        sizeBytes: file.sizeBytes,
        absolutePath,
      };
    }

    const mimeType = file.mimeType;
    if (mimeType !== undefined && mimeType.startsWith("image/")) {
      if (file.sizeBytes > MAX_INLINE_IMAGE_BYTES) {
        return {
          kind: "binary" as const,
          sizeBytes: file.sizeBytes,
          absolutePath,
          reason: "This image is too large to preview here.",
        };
      }
      return {
        kind: "image" as const,
        dataUrl: `data:${mimeType};base64,${file.content}`,
        sizeBytes: file.sizeBytes,
        absolutePath,
      };
    }

    return {
      kind: "binary" as const,
      sizeBytes: file.sizeBytes,
      absolutePath,
      reason: "This file is not text.",
    };
  }

  bb.rpc.register(rpcContract, {
    async workspaces() {
      // One request gives every project, its checkouts, and the environments
      // its threads run in — which is where a worktree's branch name lives.
      const projects = await bb.sdk.projects.list({
        include: "threads",
        includePersonal: true,
      });

      const workspaces: z.infer<typeof workspaceSchema>[] = [];
      for (const found of projects) {
        if (found.sources.length > 0) {
          workspaces.push({
            ref: { kind: "project", id: found.id },
            label: found.name,
            sublabel: found.kind === "personal" ? "personal files" : "project checkout",
            projectId: found.id,
            kind: "project",
          });
        }

        const threads = "threads" in found ? found.threads : [];
        const seen = new Set<string>();
        for (const thread of threads) {
          const environmentId = thread.environmentId;
          if (environmentId === null || seen.has(environmentId)) continue;
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          if (thread.environmentWorkspaceDisplayKind === "other") continue;
          seen.add(environmentId);
          workspaces.push({
            ref: { kind: "environment", id: environmentId },
            label: found.name,
            sublabel:
              thread.environmentBranchName ?? thread.environmentName ?? "worktree",
            projectId: found.id,
            kind: "environment",
          });
        }
      }

      return { workspaces, defaultRef: workspaces[0]?.ref ?? null };
    },

    async tree({ scope, includeHidden }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);
      // The listing and the git status are independent questions about the same
      // directory; asking them together halves the wait on a remote workspace.
      const [listed, changes, excluded] = await Promise.all([
        listEntries(resolved.scope, includeHidden),
        branchChanges(resolved.scope),
        excludedNames(),
      ]);
      return {
        scope: resolved.scope,
        entries: listed.entries,
        truncated: listed.truncated,
        listing: listed.listing,
        excluded: [...excluded].sort(),
        changes,
      };
    },

    async read({ scope, path: relativePath }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);
      return readWorkspaceFile(resolved.scope, relativePath);
    },

    async diff({ scope, path: relativePath, baseCommit, status, from }) {
      const resolved = await resolveScope(scope);
      if (!resolved.ok) throw new Error(resolved.reason);
      try {
        return await host.call(
          "fileDiff",
          { root: resolved.scope.root, baseCommit, path: relativePath, status, from },
          { hostId: resolved.scope.hostId },
        );
      } catch (error) {
        return { kind: "error" as const, reason: describe(error) };
      }
    },
  });

  /**
   * The same two questions the panel asks, for an agent that wants them in a
   * terminal. Everything resolves against the thread the command runs in — its
   * worktree when it has one, otherwise the project's default checkout — so it
   * reads the right disk even when that workspace is on another machine.
   */
  bb.cli.register({
    name: "file-browser",
    summary: "What this branch changed, and the diff for one file",
    commands: [
      {
        name: "changes",
        summary: "List the files this branch changed since it forked",
        usage: "bb file-browser changes",
      },
      {
        name: "diff",
        summary: "Print one file's diff against the commit the branch forked from",
        usage: "bb file-browser diff <path>",
      },
    ],
    async run(argv, ctx) {
      const scope: Scope | null =
        ctx.threadId !== undefined && ctx.threadId !== null
          ? { kind: "thread", id: ctx.threadId }
          : ctx.projectId !== undefined && ctx.projectId !== null
            ? { kind: "project", id: ctx.projectId }
            : null;
      if (scope === null) {
        return { exitCode: 1, stderr: "Run this inside a thread or a project.\n" };
      }

      const resolved = await resolveScope(scope);
      if (!resolved.ok) return { exitCode: 1, stderr: `${resolved.reason}\n` };

      const command = argv[0] ?? "changes";
      const changes = await branchChanges(resolved.scope);

      if (command === "changes") {
        if (changes.kind === "unavailable") {
          return { exitCode: 1, stderr: `${changes.reason}\n` };
        }
        const header = `${resolved.scope.root}\n${changes.branch ?? "(detached)"} vs ${changes.baseRef} (fork point ${changes.baseCommit.slice(0, 12)})\n`;
        const body = changes.changes
          .map((change) => `${change.status.padEnd(9)} ${change.path}${change.from === null ? "" : ` (was ${change.from})`}`)
          .join("\n");
        return { exitCode: 0, stdout: clip(`${header}${body}${body === "" ? "no changes" : ""}\n`) };
      }

      if (command === "diff") {
        const target = argv[1];
        if (target === undefined) {
          return { exitCode: 1, stderr: "Usage: bb file-browser diff <path>\n" };
        }
        if (changes.kind === "unavailable") {
          return { exitCode: 1, stderr: `${changes.reason}\n` };
        }
        const change = changes.changes.find((entry) => entry.path === target);
        if (change === undefined) {
          return { exitCode: 0, stdout: `${target} is unchanged on this branch.\n` };
        }
        const result = await host.call(
          "fileDiff",
          {
            root: resolved.scope.root,
            baseCommit: changes.baseCommit,
            path: target,
            status: change.status,
            from: change.from,
          },
          { hostId: resolved.scope.hostId },
        );
        if (result.kind === "error") return { exitCode: 1, stderr: `${result.reason}\n` };
        if (result.kind === "patch") return { exitCode: 0, stdout: clip(result.patch) };
        return { exitCode: 0, stdout: `${target}: ${result.kind}\n` };
      }

      return { exitCode: 1, stderr: `Unknown command "${command}".\n` };
    },
  });
}

/** The host rejects an oversized result outright, so clip before returning. */
function clip(text: string): string {
  const limit = PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${Buffer.from(text, "utf8").subarray(0, limit).toString("utf8")}\n… clipped\n`;
}

function isExcluded(entryPath: string, excluded: ReadonlySet<string>): boolean {
  return entryPath.split("/").some((segment) => excluded.has(segment));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
