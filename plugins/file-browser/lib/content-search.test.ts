import { describe, expect, it } from "vitest";
import {
  clipPreview,
  createGrepCollector,
  isSearchablePath,
  matchingLines,
  matchRanges,
} from "./content-search.js";

describe("matchRanges", () => {
  it("finds every occurrence, ignoring case", () => {
    expect(matchRanges("Foo foo FOO", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("treats the query as plain text, not a pattern", () => {
    expect(matchRanges("a.b axb", "a.b")).toEqual([{ start: 0, end: 3 }]);
    expect(matchRanges("call(x)", "(x)")).toEqual([{ start: 4, end: 7 }]);
  });

  it("matches nothing for an empty query", () => {
    expect(matchRanges("anything", "")).toEqual([]);
  });
});

describe("matchingLines", () => {
  it("returns the 1-based number of every line containing the query", () => {
    expect(matchingLines("one\ntwo\nanother one\n", "one")).toEqual([1, 3]);
  });

  it("counts a Windows line ending as one line break", () => {
    expect(matchingLines("a\r\nfind me\r\nb", "find")).toEqual([2]);
  });
});

describe("clipPreview", () => {
  it("leaves a short line alone, without its indentation", () => {
    expect(clipPreview("    const answer = 42;", "answer")).toBe("const answer = 42;");
  });

  it("keeps the match on screen when it is deep inside a long line", () => {
    const line = `${"x".repeat(500)}needle${"y".repeat(500)}`;
    const preview = clipPreview(line, "needle");
    expect(preview.length).toBeLessThan(200);
    expect(preview).toContain("needle");
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("isSearchablePath", () => {
  const excluded = new Set(["node_modules"]);

  it("skips anything under an excluded directory", () => {
    expect(isSearchablePath("web/node_modules/x/index.js", excluded, true)).toBe(false);
    expect(isSearchablePath("src/index.js", excluded, true)).toBe(true);
  });

  it("skips dotfiles only when hidden files are off", () => {
    expect(isSearchablePath(".github/ci.yml", excluded, false)).toBe(false);
    expect(isSearchablePath(".github/ci.yml", excluded, true)).toBe(true);
  });
});

describe("createGrepCollector", () => {
  const options = {
    query: "todo",
    excludedNames: new Set<string>(),
    includeHidden: true,
    maxFiles: 2,
    maxLinesPerFile: 2,
  };

  it("groups git grep's -z output by file, across chunk boundaries", () => {
    const collector = createGrepCollector(options);
    collector.push("src/a.ts\x003\x00// TODO one\nsrc/a.ts\x00");
    collector.push("9\x00// todo two\nsrc/b.ts\x001\x00todo\n");
    expect(collector.finish()).toEqual({
      files: [
        {
          path: "src/a.ts",
          matchCount: 2,
          lines: [
            { line: 3, text: "// TODO one" },
            { line: 9, text: "// todo two" },
          ],
        },
        { path: "src/b.ts", matchCount: 1, lines: [{ line: 1, text: "todo" }] },
      ],
      truncated: false,
    });
  });

  it("counts every matching line but keeps only the first few", () => {
    const collector = createGrepCollector(options);
    collector.push("a\x001\x00todo\na\x002\x00todo\na\x003\x00todo\n");
    const [file] = collector.finish().files;
    expect(file?.matchCount).toBe(3);
    expect(file?.lines.map((entry) => entry.line)).toEqual([1, 2]);
  });

  it("says when it is full, so the caller can stop git early", () => {
    const collector = createGrepCollector(options);
    expect(collector.push("a\x001\x00todo\nb\x001\x00todo\n")).toBe(true);
    expect(collector.push("c\x001\x00todo\n")).toBe(false);
    const result = collector.finish();
    expect(result.files.map((file) => file.path)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
  });

  it("drops files the explorer would not list", () => {
    const collector = createGrepCollector({
      ...options,
      excludedNames: new Set(["vendor"]),
      includeHidden: false,
    });
    collector.push("vendor/x\x001\x00todo\n.env\x001\x00todo\nok\x001\x00todo\n");
    expect(collector.finish().files.map((file) => file.path)).toEqual(["ok"]);
  });
});
