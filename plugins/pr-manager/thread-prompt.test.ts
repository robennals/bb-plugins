import { describe, expect, it } from "vitest";
import { buildThreadPrompt } from "./thread-prompt.js";

describe("buildThreadPrompt", () => {
  const base = { url: "https://github.com/acme/app/pull/7", headRefName: "fix-types", baseRefName: "main" };
  it("ends with the user's instructions, verbatim and unsummarized", () => {
    const instructions = "Fix the failing type check.\n\nThen push, but do NOT merge.";
    expect(buildThreadPrompt({ ...base, instructions })).toBe(
      "This worktree is checked out from the head of pull request https://github.com/acme/app/pull/7 (fix-types, targeting main). No checkout is needed."
      + `\n\n${instructions}`);
  });
  it("does not tell the agent to do anything the user did not ask for", () => {
    const prompt = buildThreadPrompt({ ...base, instructions: "Rebase onto main." });
    expect(prompt.slice(prompt.indexOf("\n\n"))).toBe("\n\nRebase onto main.");
  });
});
