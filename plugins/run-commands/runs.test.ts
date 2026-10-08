import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  MAX_RUNS,
  appendOutput,
  emptyOutput,
  outputAfter,
  pruneRuns,
  type Run,
} from "./runs.js";

function runNumber(index: number, status: Run["status"] = "exited"): Run {
  return {
    id: `run_${index}`,
    presetId: "dev",
    name: "Dev server",
    command: "npm run dev",
    url: "",
    terminalId: `term_${index}`,
    startedAt: index,
    status,
    exitCode: status === "exited" ? 0 : null,
    nextSeq: 0,
    addressPending: false,
  };
}

describe("pruneRuns", () => {
  it("keeps everything up to the limit", () => {
    const runs = Array.from({ length: MAX_RUNS }, (_, index) => runNumber(index));
    expect(pruneRuns(runs)).toEqual({ kept: runs, dropped: [] });
  });

  it("forgets the oldest finished run past the limit", () => {
    const runs = Array.from({ length: MAX_RUNS + 1 }, (_, index) => runNumber(index));
    const { kept, dropped } = pruneRuns(runs);
    expect(dropped.map((run) => run.id)).toEqual(["run_0"]);
    expect(kept).toHaveLength(MAX_RUNS);
  });

  it("never forgets one that is still running", () => {
    const runs = [runNumber(0, "running"), ...Array.from({ length: MAX_RUNS }, (_, index) => runNumber(index + 1))];
    expect(pruneRuns(runs).dropped.map((run) => run.id)).toEqual(["run_1"]);
  });
});

describe("output", () => {
  it("hands a reader only what came after the position it has", () => {
    const output = appendOutput(appendOutput(emptyOutput, "hello ", ""), "world", "");
    expect(outputAfter(output, 6)).toEqual({ text: "world", start: 6, end: 11 });
    expect(outputAfter(output, 11)).toEqual({ text: "", start: 11, end: 11 });
  });

  it("trims the oldest text past the cap, keeping positions stable", () => {
    const output = appendOutput(appendOutput(emptyOutput, "x".repeat(MAX_OUTPUT_CHARS), ""), "tail", "");
    expect(output.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(output.dropped).toBe(4);
    expect(outputAfter(output, MAX_OUTPUT_CHARS)).toEqual({
      text: "tail",
      start: MAX_OUTPUT_CHARS,
      end: MAX_OUTPUT_CHARS + 4,
    });
  });

  it("starts a reader that fell behind the trim at what is left, and says so", () => {
    const output = appendOutput(emptyOutput, "y".repeat(MAX_OUTPUT_CHARS + 10), "");
    expect(outputAfter(output, 0).start).toBe(10);
  });
});
