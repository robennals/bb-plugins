import { describe, expect, it } from "vitest";
import { knownMtime, nextView, type DocView } from "./view";

const content: DocView = { kind: "content", content: "# Hi", mtimeMs: 10 };

describe("nextView", () => {
  it("keeps the last content when the file is unchanged", () => {
    expect(nextView(content, { kind: "unchanged" })).toBe(content);
  });

  it("stays loading when told unchanged before any content arrived", () => {
    expect(nextView({ kind: "loading" }, { kind: "unchanged" })).toEqual({ kind: "loading" });
  });

  it("replaces the content with new content", () => {
    const next = { kind: "content", content: "# Bye", mtimeMs: 11 } as const;
    expect(nextView(content, next)).toEqual(next);
  });

  it("shows the file as missing once it is deleted", () => {
    expect(nextView(content, { kind: "missing" })).toEqual({ kind: "missing" });
  });
});

describe("knownMtime", () => {
  it("is the content's mtime, or null when there is no content", () => {
    expect(knownMtime(content)).toBe(10);
    expect(knownMtime({ kind: "missing" })).toBeNull();
  });
});
