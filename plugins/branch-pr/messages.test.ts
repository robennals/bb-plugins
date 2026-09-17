import { describe, expect, it } from "vitest";
import { describeResult } from "./messages.js";

describe("describeResult", () => {
  it("celebrates a pull request it opened", () => {
    expect(
      describeResult({ outcome: "opened", number: 7, title: "Ship it", url: "u" }),
    ).toEqual({ tone: "success", text: "Opened PR #7 — Ship it" });
  });

  it("says a tab was already there rather than claiming a new one", () => {
    expect(
      describeResult({ outcome: "already-open", number: 7, title: "Ship it", url: "u" }),
    ).toEqual({ tone: "info", text: "PR #7 is already open in this panel." });
  });

  it("names the branch that has none", () => {
    expect(describeResult({ outcome: "absent", branchName: "my-feature" })).toEqual({
      tone: "info",
      text: "No pull request for my-feature.",
    });
  });

  it("still answers when the branch name is unknown", () => {
    expect(describeResult({ outcome: "absent", branchName: null })).toEqual({
      tone: "info",
      text: "This thread's branch has no pull request.",
    });
  });

  it("explains a thread with no workspace", () => {
    expect(describeResult({ outcome: "no-branch" })).toEqual({
      tone: "info",
      text: "This thread has no workspace, so it has no branch to look up.",
    });
  });

  // The distinction that matters most: a lookup that could not run must never
  // read as "this branch has no pull request".
  it("reports a failed lookup as a failure", () => {
    const message = describeResult({ outcome: "unavailable", message: "gh is not authenticated" });
    expect(message.tone).toBe("error");
    expect(message.text).toBe("Could not check for a pull request: gh is not authenticated");
    expect(message.text).not.toMatch(/no pull request/i);
  });
});
