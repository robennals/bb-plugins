import { describe, expect, it } from "vitest";
import type { ChangeStatus } from "../contract.js";
import {
  indexChanges,
  statusForRow,
  statusLabel,
  statusLetter,
  statusTextClass,
} from "./changes.js";

const EVERY_STATUS: readonly ChangeStatus[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
];

const CHANGES = {
  kind: "changes" as const,
  baseRef: "origin/main",
  baseCommit: "abc123",
  branch: "my-branch",
  changes: [
    { path: "src/app.ts", status: "modified" as const, from: null },
    { path: "src/deep/new.ts", status: "added" as const, from: null },
    { path: "gone.ts", status: "deleted" as const, from: null },
  ],
};

describe("indexChanges", () => {
  it("indexes each changed file by path", () => {
    const index = indexChanges(CHANGES);
    expect(index.byPath.get("src/app.ts")?.status).toBe("modified");
    expect(index.baseCommit).toBe("abc123");
    expect(index.unavailable).toBeNull();
  });

  it("marks every directory above a change, at any depth", () => {
    const index = indexChanges(CHANGES);
    expect([...index.changedDirectories].sort()).toEqual(["src", "src/deep"]);
  });

  it("collects deletions separately, since they are not on disk to list", () => {
    expect(indexChanges(CHANGES).deletedPaths.map((change) => change.path)).toEqual([
      "gone.ts",
    ]);
  });

  it("carries the reason forward when git could not answer", () => {
    const index = indexChanges({ kind: "unavailable", reason: "Not a git repository." });
    expect(index.unavailable).toBe("Not a git repository.");
    expect(index.byPath.size).toBe(0);
    expect(index.baseCommit).toBeNull();
  });
});

describe("statusForRow", () => {
  const index = indexChanges(CHANGES);

  it("gives a file its own status", () => {
    expect(statusForRow(index, "src/app.ts", "file")).toBe("modified");
  });

  it("gives a directory containing a change a rolled-up status", () => {
    expect(statusForRow(index, "src/deep", "directory")).toBe("modified");
  });

  it("gives an untouched file and an untouched directory nothing", () => {
    expect(statusForRow(index, "src/other.ts", "file")).toBeNull();
    expect(statusForRow(index, "docs", "directory")).toBeNull();
  });
});

describe("presentation", () => {
  it("uses git's own letters", () => {
    expect(EVERY_STATUS.map(statusLetter)).toEqual(["A", "M", "D", "R", "U"]);
  });

  it("colours additions and deletions with the host's diff tokens", () => {
    expect(EVERY_STATUS.map(statusTextClass)).toEqual([
      "text-diff-added",
      "text-attention",
      "text-diff-removed",
      "text-attention",
      "text-diff-added",
    ]);
  });

  it("labels every status distinctly, since the badge is one letter", () => {
    const labels = EVERY_STATUS.map(statusLabel);
    expect(labels.every((label) => label !== "")).toBe(true);
    expect(new Set(labels).size).toBe(EVERY_STATUS.length);
  });
});
