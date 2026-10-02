import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DOC_BYTES } from "./doc-read";
import { listMarkdown, readDoc, resolvePath } from "./host-files";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "progress-doc-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeAt(relative: string, content: string, mtimeSeconds?: number) {
  const full = path.join(home, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  if (mtimeSeconds !== undefined) await utimes(full, mtimeSeconds, mtimeSeconds);
  return full;
}

describe("resolvePath", () => {
  it("expands ~ to the home directory", () => {
    expect(resolvePath({ path: "~/agent-progress/a.md" }, home)).toEqual({
      path: path.join(home, "agent-progress/a.md"),
    });
  });
});

describe("listMarkdown", () => {
  it("lists only markdown files, newest first, with absolute paths", async () => {
    await writeAt("agent-progress/old.md", "old", 1_000);
    await writeAt("agent-progress/new.markdown", "new", 2_000);
    await writeAt("agent-progress/notes.txt", "skip", 3_000);
    await mkdir(path.join(home, "agent-progress/folder.md"));

    const result = await listMarkdown({ dir: "~/agent-progress" }, home);

    expect(result).toEqual({
      kind: "ok",
      dir: path.join(home, "agent-progress"),
      files: [
        { name: "new.markdown", path: path.join(home, "agent-progress/new.markdown"), mtimeMs: 2_000_000 },
        { name: "old.md", path: path.join(home, "agent-progress/old.md"), mtimeMs: 1_000_000 },
      ],
    });
  });

  it("reports a folder that does not exist yet", async () => {
    await expect(listMarkdown({ dir: "~/agent-progress" }, home)).resolves.toEqual({
      kind: "missing",
      dir: path.join(home, "agent-progress"),
    });
  });
});

describe("readDoc", () => {
  it("returns the content and modification time", async () => {
    const file = await writeAt("doc.md", "# Progress", 5_000);
    await expect(readDoc({ path: file, knownMtimeMs: null }, home)).resolves.toEqual({
      kind: "content",
      content: "# Progress",
      mtimeMs: 5_000_000,
    });
  });

  it("expands ~ in the path", async () => {
    await writeAt("doc.md", "# Home", 5_000);
    await expect(readDoc({ path: "~/doc.md", knownMtimeMs: null }, home)).resolves.toMatchObject({
      kind: "content",
      content: "# Home",
    });
  });

  it("skips the content when the caller already has this version", async () => {
    const file = await writeAt("doc.md", "# Progress", 5_000);
    const { mtimeMs } = await stat(file);
    await expect(readDoc({ path: file, knownMtimeMs: mtimeMs }, home)).resolves.toEqual({
      kind: "unchanged",
    });
  });

  it("reports a missing file", async () => {
    await expect(
      readDoc({ path: path.join(home, "nope.md"), knownMtimeMs: null }, home),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("refuses a file over the size cap", async () => {
    const file = await writeAt("big.md", "x".repeat(MAX_DOC_BYTES + 1));
    await expect(readDoc({ path: file, knownMtimeMs: null }, home)).resolves.toEqual({
      kind: "too-large",
      bytes: MAX_DOC_BYTES + 1,
    });
  });

  it("refuses a directory", async () => {
    await mkdir(path.join(home, "dir.md"));
    await expect(
      readDoc({ path: path.join(home, "dir.md"), knownMtimeMs: null }, home),
    ).resolves.toEqual({ kind: "not-a-file" });
  });
});
