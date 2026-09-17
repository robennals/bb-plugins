// The sentence each outcome gets, in one place so the header button's toast
// and the panel's message never drift apart.
import type { OpenResult } from "./server.js";

export type MessageTone = "success" | "info" | "error";

export interface ResultMessage {
  tone: MessageTone;
  text: string;
}

export function describeResult(result: OpenResult): ResultMessage {
  switch (result.outcome) {
    case "opened":
      return { tone: "success", text: `Opened PR #${result.number} — ${result.title}` };
    case "already-open":
      return {
        tone: "info",
        text: `PR #${result.number} is already open in this panel.`,
      };
    case "absent":
      return {
        tone: "info",
        text:
          result.branchName === null
            ? "This thread's branch has no pull request."
            : `No pull request for ${result.branchName}.`,
      };
    case "no-branch":
      return {
        tone: "info",
        text: "This thread has no workspace, so it has no branch to look up.",
      };
    // Deliberately not phrased as "no pull request": the lookup never ran, so
    // whether one exists is unknown.
    case "unavailable":
      return { tone: "error", text: `Could not check for a pull request: ${result.message}` };
  }
}
