import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "./host.js";

type SearchContext = Parameters<typeof hostEntry.handlers.searchContent>[1];

// The search reads nothing from its context but the abort signal.
const context = { signal: new AbortController().signal } as SearchContext;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A throwaway workspace holding `files`, made a git repository if asked. */
async function workspace(
  files: Record<string, string | Buffer>,
  { isRepository }: { isRepository: boolean },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "file-browser-search-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  if (isRepository) execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

const FILES = {
  "src/auth.ts": "export function login() {\n  // TODO check the token\n}\n",
  "src/theme.ts": "export const colour = 'blue';\n",
  "README.md": "Nothing to do here.\nStill a todo list.\n",
  "node_modules/dep/index.js": "// todo in a dependency\n",
  ".github/ci.yml": "# todo: cache\n",
  "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x74, 0x6f, 0x64, 0x6f]),
};

const search = (root: string, query: string, includeHidden = true) =>
  hostEntry.handlers.searchContent(
    { root, query, excludedNames: ["node_modules"], includeHidden },
    context,
  );

describe.each([
  { kind: "a git repository", isRepository: true },
  { kind: "a plain folder", isRepository: false },
])("searching $kind", ({ isRepository }) => {
  it("returns only the files whose text contains the query, with the lines", async () => {
    const root = await workspace(FILES, { isRepository });
    const result = await search(root, "todo");

    expect(result.truncated).toBe(false);
    expect(
      [...result.files].sort((left, right) => left.path.localeCompare(right.path)),
    ).toEqual([
      { path: ".github/ci.yml", matchCount: 1, lines: [{ line: 1, text: "# todo: cache" }] },
      { path: "README.md", matchCount: 1, lines: [{ line: 2, text: "Still a todo list." }] },
      {
        path: "src/auth.ts",
        matchCount: 1,
        lines: [{ line: 2, text: "// TODO check the token" }],
      },
    ]);
  });

  it("leaves out dotfiles when the explorer is hiding them", async () => {
    const root = await workspace(FILES, { isRepository });
    const result = await search(root, "todo", false);
    expect(result.files.map((file) => file.path)).not.toContain(".github/ci.yml");
  });

  it("finds nothing when nothing matches", async () => {
    const root = await workspace(FILES, { isRepository });
    await expect(search(root, "no such text")).resolves.toEqual({ files: [], truncated: false });
  });
});

it("skips what .gitignore hides in a repository", async () => {
  const root = await workspace(
    { ".gitignore": "dist/\n", "dist/out.js": "todo\n", "src/in.ts": "todo\n" },
    { isRepository: true },
  );
  const result = await search(root, "todo");
  expect(result.files.map((file) => file.path)).toEqual(["src/in.ts"]);
});

it("stops at the first 200 matching files and says so", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 250 }, (_, index) => [`f${index}.txt`, "todo\n"]),
  );
  const root = await workspace(files, { isRepository: true });
  const result = await search(root, "todo");
  expect(result.files).toHaveLength(200);
  expect(result.truncated).toBe(true);
});
