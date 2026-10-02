import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT, PATH_PLACEHOLDER, fillPrompt } from "./prompt";

describe("fillPrompt", () => {
  it("replaces every placeholder with the path", () => {
    expect(fillPrompt("Write {{path}}. Again: {{path}}", "/p.md")).toBe("Write /p.md. Again: /p.md");
  });
});

describe("DEFAULT_PROMPT", () => {
  it("names the path and every suggested section", () => {
    expect(DEFAULT_PROMPT).toContain(PATH_PLACEHOLDER);
    for (const section of [
      "Active PRs",
      "Things that are hard",
      "Progress",
      "Spec links",
      "Open Questions",
      "Notable Decisions",
      "Archive",
    ]) {
      expect(DEFAULT_PROMPT).toContain(section);
    }
  });
});
