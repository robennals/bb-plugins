import { describe, expect, it } from "vitest";
import {
  baseRefCandidates,
  mergeChanges,
  parseNameStatus,
  parseUntracked,
  shortenRemoteHead,
} from "./git-changes.js";

/** Build the NUL-separated shape `git diff --name-status -z` actually emits. */
function nameStatusOutput(...fields: string[]): string {
  return fields.length === 0 ? "" : `${fields.join("\0")}\0`;
}

describe("parseNameStatus", () => {
  it("reads one record per changed file", () => {
    const output = nameStatusOutput("M", "src/app.ts", "A", "src/new.ts", "D", "old.ts");
    expect(parseNameStatus(output)).toEqual([
      { path: "src/app.ts", status: "modified", from: null },
      { path: "src/new.ts", status: "added", from: null },
      { path: "old.ts", status: "deleted", from: null },
    ]);
  });

  it("reads a rename's two paths and keeps the old one", () => {
    const output = nameStatusOutput("R096", "lib/old.ts", "lib/new.ts");
    expect(parseNameStatus(output)).toEqual([
      { path: "lib/new.ts", status: "renamed", from: "lib/old.ts" },
    ]);
  });

  it("treats a copy as an addition, since the source is still there", () => {
    const output = nameStatusOutput("C075", "lib/source.ts", "lib/copy.ts");
    expect(parseNameStatus(output)).toEqual([
      { path: "lib/copy.ts", status: "added", from: null },
    ]);
  });

  it("does not get out of step when a paired record sits between plain ones", () => {
    const output = nameStatusOutput(
      "M", "a.ts",
      "R100", "b.ts", "c.ts",
      "A", "d.ts",
    );
    expect(parseNameStatus(output).map((change) => change.path)).toEqual([
      "a.ts",
      "c.ts",
      "d.ts",
    ]);
  });

  it("keeps a path containing a newline intact", () => {
    // Exactly why the -z form is used: C-quoting would have mangled this.
    const output = nameStatusOutput("M", "weird\nname.ts");
    expect(parseNameStatus(output)).toEqual([
      { path: "weird\nname.ts", status: "modified", from: null },
    ]);
  });

  it("reports a typechange as modified", () => {
    expect(parseNameStatus(nameStatusOutput("T", "link.ts"))).toEqual([
      { path: "link.ts", status: "modified", from: null },
    ]);
  });

  it("skips statuses with no useful branch meaning", () => {
    expect(parseNameStatus(nameStatusOutput("U", "conflicted.ts"))).toEqual([]);
  });

  it("is empty for an empty diff", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  it("drops a trailing record whose path never arrived", () => {
    expect(parseNameStatus("M\0a.ts\0R100\0b.ts\0")).toEqual([
      { path: "a.ts", status: "modified", from: null },
    ]);
  });
});

describe("parseUntracked", () => {
  it("marks every listed path untracked", () => {
    expect(parseUntracked("notes.md\0src/scratch.ts\0")).toEqual([
      { path: "notes.md", status: "untracked", from: null },
      { path: "src/scratch.ts", status: "untracked", from: null },
    ]);
  });

  it("is empty for no output", () => {
    expect(parseUntracked("")).toEqual([]);
  });
});

describe("mergeChanges", () => {
  it("lets the tracked listing win an overlap", () => {
    const merged = mergeChanges(
      [{ path: "a.ts", status: "modified", from: null }],
      [{ path: "a.ts", status: "untracked", from: null }],
    );
    expect(merged).toEqual([{ path: "a.ts", status: "modified", from: null }]);
  });

  it("keeps both listings and sorts by path", () => {
    const merged = mergeChanges(
      [{ path: "z.ts", status: "added", from: null }],
      [{ path: "a.ts", status: "untracked", from: null }],
    );
    expect(merged.map((change) => change.path)).toEqual(["a.ts", "z.ts"]);
  });
});

describe("baseRefCandidates", () => {
  it("puts origin/HEAD first when the clone has one", () => {
    expect(baseRefCandidates("origin/trunk")[0]).toBe("origin/trunk");
  });

  it("falls back to the conventional names in order", () => {
    expect(baseRefCandidates(null)).toEqual([
      "origin/main",
      "origin/master",
      "origin/develop",
      "main",
      "master",
    ]);
  });
});

describe("shortenRemoteHead", () => {
  it("strips the refs/remotes/ prefix", () => {
    expect(shortenRemoteHead("refs/remotes/origin/main\n")).toBe("origin/main");
  });

  it("leaves an already-short ref alone", () => {
    expect(shortenRemoteHead("origin/main")).toBe("origin/main");
  });

  it("is null for the empty output of a repo with no origin/HEAD", () => {
    expect(shortenRemoteHead("\n")).toBeNull();
  });
});
