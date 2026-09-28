import { describe, expect, it } from "vitest";
import { docFileName } from "./naming";

describe("docFileName", () => {
  it("slugs the thread title and appends the thread id", () => {
    expect(docFileName("Create progress docs plugin", "thr_abc")).toBe(
      "create-progress-docs-plugin-thr_abc.md",
    );
  });

  it("falls back to 'thread' when the title has nothing usable", () => {
    expect(docFileName(null, "thr_abc")).toBe("thread-thr_abc.md");
    expect(docFileName("🚀🚀", "thr_abc")).toBe("thread-thr_abc.md");
  });

  it("caps a long title without leaving a trailing dash", () => {
    const name = docFileName(`${"word ".repeat(40)}end`, "thr_abc");
    const slug = name.slice(0, -"-thr_abc.md".length);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});
