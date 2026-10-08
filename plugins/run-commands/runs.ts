// A thread's runs and the output each one printed, kept free of the SDK so the
// rules can be tested on their own.
import { z } from "zod";

export const runStatusSchema = z.enum([
  /** The command is still going. */
  "running",
  /** It ended on its own; `exitCode` says how. */
  "exited",
  /** Someone pressed Stop, or ran the same command again. */
  "stopped",
  /** BB no longer has its terminal, so how it ended is unknown. */
  "lost",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  /** The preset as it was when run, so editing it later does not rewrite history. */
  name: z.string(),
  command: z.string(),
  url: z.string(),
  terminalId: z.string(),
  startedAt: z.number(),
  status: runStatusSchema,
  exitCode: z.number().nullable(),
  /** The next terminal output sequence number to read. */
  nextSeq: z.number(),
  /** True until the run's address has been opened, or will not be. */
  addressPending: z.boolean(),
});
export type Run = z.infer<typeof runSchema>;

export const runsSchema = z.array(runSchema);

/** What the output tab needs to draw a run's box; the rest is server bookkeeping. */
export const runSummarySchema = runSchema.pick({
  id: true,
  name: true,
  command: true,
  startedAt: true,
  status: true,
  exitCode: true,
});
export type RunSummary = z.infer<typeof runSummarySchema>;

/** Runs kept per thread; starting one more forgets the oldest finished one. */
export const MAX_RUNS = 20;

/**
 * Which runs to keep once `MAX_RUNS` is passed: the newest, but never one that
 * is still running — forgetting it would leave its terminal unwatched.
 */
export function pruneRuns(runs: readonly Run[]): { kept: Run[]; dropped: Run[] } {
  const excess = runs.length - MAX_RUNS;
  if (excess <= 0) return { kept: [...runs], dropped: [] };
  const dropped = runs.filter((run) => run.status !== "running").slice(0, excess);
  return { kept: runs.filter((run) => !dropped.includes(run)), dropped };
}

/**
 * A run's output so far. Only the newest `MAX_OUTPUT_CHARS` are kept; `dropped`
 * counts what fell off the front, so positions stay stable as text is
 * appended and trimmed, and a reader can ask for "everything after position N".
 */
export const outputSchema = z.object({
  text: z.string(),
  dropped: z.number(),
  /** The start of an escape sequence the next read will finish. */
  pendingEscape: z.string(),
});
export type Output = z.infer<typeof outputSchema>;

export const emptyOutput: Output = { text: "", dropped: 0, pendingEscape: "" };

// Well inside the 256KB a kv value may hold, even when every character is
// escaped in the JSON.
export const MAX_OUTPUT_CHARS = 40_000;

export function appendOutput(output: Output, plain: string, pendingEscape: string): Output {
  const text = output.text + plain;
  const excess = Math.max(0, text.length - MAX_OUTPUT_CHARS);
  return { text: text.slice(excess), dropped: output.dropped + excess, pendingEscape };
}

/**
 * The output after position `from`. `start` is where the returned text begins:
 * later than `from` when that part has already been trimmed away.
 */
export function outputAfter(
  output: Output,
  from: number,
): { text: string; start: number; end: number } {
  const end = output.dropped + output.text.length;
  const start = Math.min(Math.max(from, output.dropped), end);
  return { text: output.text.slice(start - output.dropped), start, end };
}
