// The file work the host entry does, on the machine that holds the workspace.
// Takes the home directory as an argument so tests can point it at a temp dir.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ListMarkdownResult } from "../contract";
import { MAX_DOC_BYTES, type HostDocRead } from "./doc-read";
import { expandHome, sortNewestFirst } from "./paths";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

function isMissing(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  return cause.code === "ENOENT" || cause.code === "ENOTDIR";
}

export function resolvePath(input: { path: string }, home: string): { path: string } {
  return { path: expandHome(input.path, home) };
}

export async function listMarkdown(input: { dir: string }, home: string): Promise<ListMarkdownResult> {
  const dir = expandHome(input.dir, home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if (isMissing(cause)) return { kind: "missing", dir };
    throw cause;
  }
  const files: { name: string; path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!MARKDOWN_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    try {
      // `stat`, not the dirent type, so a symlink to a doc still counts.
      const info = await stat(full);
      if (info.isFile()) files.push({ name, path: full, mtimeMs: info.mtimeMs });
    } catch {
      // Deleted between listing and stat, or a dangling link: not a doc.
    }
  }
  return { kind: "ok", dir, files: sortNewestFirst(files) };
}

export async function readDoc(
  input: { path: string; knownMtimeMs: number | null },
  home: string,
): Promise<HostDocRead> {
  const file = expandHome(input.path, home);
  let info;
  try {
    info = await stat(file);
  } catch (cause) {
    if (isMissing(cause)) return { kind: "missing" };
    throw cause;
  }
  if (!info.isFile()) return { kind: "not-a-file" };
  if (info.size > MAX_DOC_BYTES) return { kind: "too-large", bytes: info.size };
  if (input.knownMtimeMs === info.mtimeMs) return { kind: "unchanged" };
  return { kind: "content", content: await readFile(file, "utf8"), mtimeMs: info.mtimeMs };
}
