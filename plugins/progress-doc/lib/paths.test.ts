import { describe, expect, it } from "vitest";
import { expandHome, parsePathInput, sortNewestFirst } from "./paths";

describe("parsePathInput", () => {
  it("accepts an absolute path", () => {
    expect(parsePathInput("/Users/me/notes.md")).toEqual({ ok: true, path: "/Users/me/notes.md" });
  });

  it("accepts a home-relative path", () => {
    expect(parsePathInput("~/agent-progress/x.md")).toEqual({ ok: true, path: "~/agent-progress/x.md" });
  });

  it("trims whitespace and matching quotes", () => {
    expect(parsePathInput("  '/tmp/a b.md'\n")).toEqual({ ok: true, path: "/tmp/a b.md" });
    expect(parsePathInput('"~/x.md"')).toEqual({ ok: true, path: "~/x.md" });
  });

  it("rejects an empty path", () => {
    expect(parsePathInput("   ")).toMatchObject({ ok: false });
  });

  it("rejects relative paths", () => {
    expect(parsePathInput("notes.md")).toMatchObject({ ok: false });
    expect(parsePathInput("~other/notes.md")).toMatchObject({ ok: false });
  });
});

describe("expandHome", () => {
  it("expands a bare tilde and a tilde prefix", () => {
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
    expect(expandHome("~/agent-progress/x.md", "/Users/me")).toBe("/Users/me/agent-progress/x.md");
  });

  it("leaves absolute paths alone, normalised", () => {
    expect(expandHome("/a/./b/../c.md", "/Users/me")).toBe("/a/c.md");
  });
});

describe("sortNewestFirst", () => {
  it("orders by modification time, newest first, then by name", () => {
    const files = [
      { name: "b.md", mtimeMs: 1 },
      { name: "c.md", mtimeMs: 5 },
      { name: "a.md", mtimeMs: 1 },
    ];
    expect(sortNewestFirst(files).map((file) => file.name)).toEqual(["c.md", "a.md", "b.md"]);
  });
});
