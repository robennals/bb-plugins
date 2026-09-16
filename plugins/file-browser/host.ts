import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type BranchChanges, type ChangedPath } from "./contract.js";
import {
  baseRefCandidates,
  mergeChanges,
  parseNameStatus,
  parseUntracked,
  shortenRemoteHead,
} from "./lib/git-changes.js";

const execFileAsync = promisify(execFile);

/** A patch past this is more than the viewer can usefully draw. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
/** Full-file context is an optimisation; skip it rather than ship megabytes. */
const MAX_SIDE_BYTES = 1024 * 1024;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git and hand back its exit code instead of throwing on it. Git uses
 * non-zero for ordinary answers — 1 from `diff --no-index` means "they differ",
 * 1 from `rev-parse --verify` means "no such ref" — so a throwing wrapper would
 * turn half the questions we ask into errors.
 */
async function git(
  root: string,
  args: string[],
  signal: AbortSignal,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      signal,
      // Never let a repository's own config open an editor, a pager or a
      // credential prompt: this process has no terminal to answer with.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr, code: 0 };
  } catch (cause) {
    // `execFile` rejects with the Error it would have passed to its callback:
    // numeric `code` plus captured `stdout`/`stderr` when the child ran and
    // exited, and a string `code` (ENOENT, ETIMEDOUT) when it never did.
    const error = cause as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (typeof error.code === "number") {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.code,
      };
    }
    // ENOENT (no git), ETIMEDOUT, or an abort: no exit code, so there is no
    // answer to interpret.
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function firstExistingRef(
  root: string,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  for (const candidate of candidates) {
    const result = await git(
      root,
      ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      signal,
    );
    if (result.code === 0 && result.stdout.trim() !== "") return candidate;
  }
  return null;
}

/**
 * Reject anything that is not a plain workspace-relative path before it reaches
 * a git argument. `--` already stops a leading dash being read as an option,
 * but `..` segments would still let a caller address files outside the
 * workspace they asked about.
 */
function assertRelativePath(path: string): void {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error("Path must be relative to the workspace.");
  }
  if (path.split("/").some((segment) => segment === "..")) {
    throw new Error("Path must stay inside the workspace.");
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async branchChanges({ root, baseBranch }, context): Promise<BranchChanges> {
      const signal = context.signal;

      const insideRepo = await git(
        root,
        ["rev-parse", "--is-inside-work-tree"],
        signal,
      ).catch((error: Error) => ({ stdout: "", stderr: error.message, code: 1 }));
      if (insideRepo.code !== 0 || insideRepo.stdout.trim() !== "true") {
        return { kind: "unavailable", reason: "This workspace is not a git repository." };
      }

      // An explicit setting is a statement about this repository, so take it at
      // its word and report the failure rather than silently falling back to a
      // branch the user did not name.
      let baseRef: string | null = null;
      if (baseBranch !== null && baseBranch !== "") {
        baseRef = await firstExistingRef(
          root,
          [baseBranch, `origin/${baseBranch}`],
          signal,
        );
        if (baseRef === null) {
          return {
            kind: "unavailable",
            reason: `No branch named "${baseBranch}" in this repository.`,
          };
        }
      } else {
        const originHead = await git(
          root,
          ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
          signal,
        );
        baseRef = await firstExistingRef(
          root,
          baseRefCandidates(
            originHead.code === 0 ? shortenRemoteHead(originHead.stdout) : null,
          ),
          signal,
        );
        if (baseRef === null) {
          return {
            kind: "unavailable",
            reason: "Could not find a default branch to compare against.",
          };
        }
      }

      const branchResult = await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"], signal);
      const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;

      // The fork point, not the branch tip: comparing against the tip would
      // report every commit that landed on main since as a change to this
      // branch.
      const mergeBase = await git(root, ["merge-base", "HEAD", baseRef], signal);
      if (mergeBase.code !== 0) {
        return {
          kind: "unavailable",
          reason: `HEAD and ${baseRef} have no common ancestor.`,
        };
      }
      const baseCommit = mergeBase.stdout.trim();

      // No `--cached`: this compares the WORKING TREE with the fork point, so
      // uncommitted edits count as changed too.
      const [tracked, untracked] = await Promise.all([
        git(root, ["diff", "--name-status", "--find-renames", "-z", baseCommit], signal),
        git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
      ]);

      const changes: ChangedPath[] = mergeChanges(
        tracked.code === 0 ? parseNameStatus(tracked.stdout) : [],
        untracked.code === 0 ? parseUntracked(untracked.stdout) : [],
      );

      return { kind: "changes", baseRef, baseCommit, branch, changes };
    },

    async fileDiff({ root, baseCommit, path, status, from }, context) {
      const signal = context.signal;
      assertRelativePath(path);
      if (from !== null) assertRelativePath(from);

      try {
        const patch =
          status === "untracked"
            ? // An untracked file is in no index, so `git diff <commit>` cannot
              // see it. `--no-index` against /dev/null renders it as an
              // all-additions patch, which is what it is.
              await git(
                root,
                ["diff", "--no-index", "--no-color", "--", "/dev/null", path],
                signal,
              )
            : await git(
                root,
                [
                  "diff",
                  "--no-color",
                  "--find-renames",
                  baseCommit,
                  "--",
                  // A rename only reads as one when BOTH paths are in the
                  // pathspec: given the new path alone, git sees a file that
                  // did not exist at the base and prints the whole thing as an
                  // addition.
                  ...(from === null ? [path] : [from, path]),
                ],
                signal,
              );

        // 0 = identical, 1 = differs; anything else is a real failure.
        if (patch.code > 1) {
          return {
            kind: "error" as const,
            reason: patch.stderr.trim() || "git diff failed.",
          };
        }
        if (patch.stdout.trim() === "") return { kind: "unchanged" as const };
        if (Buffer.byteLength(patch.stdout, "utf8") > MAX_PATCH_BYTES) {
          return { kind: "error" as const, reason: "This diff is too large to display." };
        }
        if (/^Binary files .* differ$/m.test(patch.stdout)) {
          return { kind: "binary" as const };
        }

        const oldPath = from ?? path;
        const [oldContent, newContent] = await Promise.all([
          status === "added" || status === "untracked"
            ? Promise.resolve("")
            : readBlob(root, `${baseCommit}:${oldPath}`, signal),
          status === "deleted"
            ? Promise.resolve("")
            : readWorktreeFile(root, path),
        ]);

        return {
          kind: "patch" as const,
          patch: rewriteNoIndexHeader(patch.stdout, path, status),
          oldContent,
          newContent,
          oldPath,
          newPath: path,
        };
      } catch (cause) {
        return {
          kind: "error" as const,
          reason: cause instanceof Error ? cause.message : "git diff failed.",
        };
      }
    },
  },
});

/** The base side of the diff, or null when it is not usable as text. */
async function readBlob(
  root: string,
  spec: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await git(root, ["show", spec], signal);
  if (result.code !== 0) return null;
  return result.stdout.length > MAX_SIDE_BYTES ? null : result.stdout;
}

/**
 * The working-tree side: the bytes on disk, not the index, so an unstaged edit
 * shows the text actually in the file. This entry runs on the machine that
 * holds the workspace, so `node:fs` is reading the right disk.
 */
async function readWorktreeFile(
  root: string,
  relativePath: string,
): Promise<string | null> {
  const absolutePath = join(root, relativePath);
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile() || stats.size > MAX_SIDE_BYTES) return null;
    const bytes = await readFile(absolutePath);
    // A NUL byte means git would have called this binary; the viewer is better
    // off with the patch alone than with mojibake as "full context".
    if (bytes.includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * `--no-index` writes `a/dev/null` and `b/<path>` into the header. The viewer
 * completes a headerless patch from `path` on its own, so drop the header
 * rather than hand it one naming a file that does not exist.
 */
function rewriteNoIndexHeader(
  patch: string,
  path: string,
  status: string,
): string {
  if (status !== "untracked") return patch;
  const hunkStart = patch.indexOf("\n@@");
  if (hunkStart === -1) return patch;
  return `--- /dev/null\n+++ b/${path}${patch.slice(hunkStart)}`;
}
