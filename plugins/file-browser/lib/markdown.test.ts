import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "./markdown.js";
import { isMarkdownPath } from "./file-kind.js";

describe("splitFrontmatter", () => {
  it("takes YAML frontmatter off the top", () => {
    expect(splitFrontmatter("---\nname: thing\n---\n# Title\n\nBody.\n")).toEqual({
      frontmatter: "name: thing",
      body: "# Title\n\nBody.\n",
    });
  });

  it("accepts YAML's other closing fence", () => {
    expect(splitFrontmatter("---\nname: thing\n...\nBody.")).toEqual({
      frontmatter: "name: thing",
      body: "Body.",
    });
  });

  it("keeps blank lines and nesting inside the frontmatter", () => {
    expect(
      splitFrontmatter("---\nname: thing\n\nmeta:\n  type: skill\n---\nBody."),
    ).toEqual({
      frontmatter: "name: thing\n\nmeta:\n  type: skill",
      body: "Body.",
    });
  });

  it("tolerates CRLF line endings", () => {
    expect(splitFrontmatter("---\r\nname: thing\r\n---\r\nBody.")).toEqual({
      frontmatter: "name: thing",
      body: "Body.",
    });
  });

  it("leaves a document that merely opens with a rule alone", () => {
    expect(splitFrontmatter("---\nJust a rule and then prose.")).toEqual({
      frontmatter: null,
      body: "---\nJust a rule and then prose.",
    });
  });

  it("does not treat a rule further down the file as frontmatter", () => {
    const content = "# Title\n\n---\n\nAfter the rule.";
    expect(splitFrontmatter(content)).toEqual({ frontmatter: null, body: content });
  });

  it("reports empty frontmatter as empty, not as missing", () => {
    expect(splitFrontmatter("---\n---\nBody.")).toEqual({
      frontmatter: "",
      body: "Body.",
    });
  });

  it("handles an empty file", () => {
    expect(splitFrontmatter("")).toEqual({ frontmatter: null, body: "" });
  });
});

describe("isMarkdownPath", () => {
  it("recognises the markdown extensions", () => {
    for (const path of [
      "README.md",
      "docs/guide.markdown",
      "a/b/NOTES.MD",
      "page.mdx",
      "old.mkd",
    ]) {
      expect(isMarkdownPath(path), path).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const path of [
      "index.ts",
      "notes.txt",
      "Makefile",
      "md",
      "a.md.bak",
      "dir.md/file.ts",
    ]) {
      expect(isMarkdownPath(path), path).toBe(false);
    }
  });
});
