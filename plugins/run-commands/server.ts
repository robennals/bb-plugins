// bb-plugin-run-commands — backend.
//
// Keeps the list of preset commands, and runs one for a thread by starting a
// BB terminal with the command already in it — the terminal is what puts the
// process on the machine that holds the thread's workspace. Nobody looks at
// that terminal directly: a background loop copies what it prints into this
// plugin's storage, where the thread's "Command output" tab reads it, so the
// output outlives the process and the terminal can be closed once it exits.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { OUTPUT_ADDED, PRESETS_CHANGED, RUNS_CHANGED } from "./channels.js";
import { messageOf } from "./errors.js";
import { parseStoredPresets, presetsSchema, type Preset } from "./presets.js";
import {
  appendOutput,
  emptyOutput,
  outputAfter,
  outputSchema,
  pruneRuns,
  runSummarySchema,
  runsSchema,
  type Output,
  type Run,
  type RunSummary,
} from "./runs.js";
import { outputMentions, stripAnsiStreaming } from "./terminal-text.js";
import { browserTabFor, panelTabsSchema, withTab, type PanelTab } from "./tabs.js";


// One list per project: the command that starts one repo's dev server means
// nothing in another.
const presetsKeyFor = (projectId: string) => `presets:${projectId}`;
const RUNS_PREFIX = "runs:";
const runsKeyFor = (threadId: string) => `${RUNS_PREFIX}${threadId}`;
const outputKeyFor = (runId: string) => `output:${runId}`;

/** How often running commands' output is copied over. */
export const POLL_MS = 1_000;
/** How long to wait for a command to print its address before opening it anyway. */
export const ADDRESS_WAIT_MS = 30_000;
/** Enough of the earlier output to catch an address split across two reads. */
const ADDRESS_OVERLAP_CHARS = 256;
/** Reads per poll when draining a finished command's last output. */
const MAX_DRAIN_READS = 20;

// Nobody sees these terminals, but they still need a size. Wide enough that a
// dev server's banner does not wrap.
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;

const projectInput = z.object({ projectId: z.string() });
const threadInput = z.object({ threadId: z.string() });
const runOutput = z.object({ run: runSummarySchema });
const runsOutput = z.object({ runs: z.array(runSummarySchema) });

export const rpcContract = defineRpcContract({
  presets_get: { input: projectInput, output: z.object({ presets: presetsSchema }) },
  presets_save: {
    input: projectInput.extend({ presets: presetsSchema }),
    output: z.object({ presets: presetsSchema }),
  },
  /** Every project, for the Settings page, which BB does not tell which one is in view. */
  projects: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  /**
   * Run a preset in the thread. If the same preset is still running there it
   * is stopped first, so clicking a dev server again restarts it rather than
   * starting a second one on a port that is taken.
   */
  run: { input: threadInput.extend({ presetId: z.string() }), output: runOutput },
  stop: { input: threadInput.extend({ runId: z.string() }), output: runOutput },
  /** The thread's runs, newest first. */
  runs: { input: threadInput, output: runsOutput },
  /** Forget every run that has finished. */
  clear: { input: threadInput, output: runsOutput },
  /** A run's output after position `from`; see `outputAfter`. */
  output: {
    input: threadInput.extend({ runId: z.string(), from: z.number().int().min(0) }),
    output: z.object({ text: z.string(), start: z.number(), end: z.number() }),
  },
});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function summarize(run: Run): RunSummary {
  return runSummarySchema.parse(run);
}

export default function plugin(bb: BbPluginApi) {
  // ── storage ────────────────────────────────────────────────────────────

  async function readPresets(projectId: string): Promise<Preset[]> {
    return parseStoredPresets(await bb.storage.kv.get(presetsKeyFor(projectId)));
  }

  /** Stored JSON this plugin wrote; anything unreadable counts as no runs. */
  async function readRuns(threadId: string): Promise<Run[]> {
    const parsed = runsSchema.safeParse(await bb.storage.kv.get(runsKeyFor(threadId)));
    return parsed.success ? parsed.data : [];
  }

  async function writeRuns(threadId: string, runs: Run[]): Promise<void> {
    if (runs.length === 0) await bb.storage.kv.delete(runsKeyFor(threadId));
    else await bb.storage.kv.set(runsKeyFor(threadId), runs);
  }

  async function readOutput(runId: string): Promise<Output> {
    const parsed = outputSchema.safeParse(await bb.storage.kv.get(outputKeyFor(runId)));
    return parsed.success ? parsed.data : emptyOutput;
  }

  async function forget(runs: readonly Run[]): Promise<void> {
    await Promise.all(runs.map((run) => bb.storage.kv.delete(outputKeyFor(run.id))));
  }

  /**
   * Run `work` after every earlier piece of work for the same thread. The
   * background loop and the RPC handlers both read-modify-write a thread's
   * runs; without this, one would overwrite the other's change.
   */
  const threadQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const result = (threadQueues.get(threadId) ?? Promise.resolve()).then(work);
    const settled = result.catch(() => undefined);
    threadQueues.set(threadId, settled);
    void settled.then(() => {
      if (threadQueues.get(threadId) === settled) threadQueues.delete(threadId);
    });
    return result;
  }

  // ── the thread's side panel ────────────────────────────────────────────

  /**
   * Add a tab to the thread's right-hand panel. The tab list is BB's and
   * another client may be writing it, so this is a compare-and-swap: re-read
   * and retry once on rejection, then give up loudly.
   */
  async function addTab(threadId: string, tab: PanelTab): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = panelTabsSchema.parse(await bb.sdk.threads.tabs.get({ threadId }));
      const tabs = withTab(current.tabs, tab);
      if (tabs === null) return;
      try {
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          // The one place these deliberately-opaque tab objects meet BB's
          // strict tab union. Every entry is either one BB gave us or the
          // browser tab built in tabs.ts, so the values are exactly what the
          // SDK type demands even though `looseObject` cannot prove it.
          // Derived from the SDK signature so this breaks loudly if the shape
          // moves.
          tabs: tabs as Parameters<typeof bb.sdk.threads.tabs.update>[0]["tabs"],
        });
        return;
      } catch (cause) {
        lastError = cause;
        bb.log.warn(`tab update rejected for ${threadId}: ${messageOf(cause)}`);
      }
    }
    throw new Error(`Could not update the side panel's tabs: ${messageOf(lastError)}`);
  }

  async function openAddress(threadId: string, run: Run): Promise<void> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      await addTab(
        threadId,
        browserTabFor({
          pluginId: bb.pluginId,
          environmentId: thread.environmentId,
          url: run.url,
          title: run.name,
        }),
      );
    } catch (cause) {
      bb.log.warn(`could not open ${run.url} for "${run.name}": ${messageOf(cause)}`);
    }
  }

  // ── following a running command ───────────────────────────────────────

  /**
   * Copy what the run's terminal has printed since last time into storage.
   * `drain` keeps reading until nothing is left, for a command that has
   * finished and is about to have its terminal closed.
   */
  async function copyOutput(
    threadId: string,
    run: Run,
    drain: boolean,
  ): Promise<{ run: Run; recent: string }> {
    let output = await readOutput(run.id);
    const before = output.dropped + output.text.length;
    let nextSeq = run.nextSeq;
    for (let read = 0; read < (drain ? MAX_DRAIN_READS : 1); read += 1) {
      const page = await bb.sdk.terminals.output({ terminalId: run.terminalId, sinceSeq: nextSeq });
      nextSeq = page.nextSeq;
      if (page.chunks.length === 0) break;
      const raw =
        output.pendingEscape +
        page.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
      const { plain, rest } = stripAnsiStreaming(raw);
      output = appendOutput(output, plain, rest);
    }
    const added = output.dropped + output.text.length - before;
    if (added > 0) {
      await bb.storage.kv.set(outputKeyFor(run.id), output);
      bb.realtime.publish(OUTPUT_ADDED, { threadId, runId: run.id });
    }
    return { run: { ...run, nextSeq }, recent: output.text.slice(-(added + ADDRESS_OVERLAP_CHARS)) };
  }

  async function closeTerminal(terminalId: string): Promise<void> {
    try {
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
    } catch (cause) {
      // Most often it is already gone, which is what we wanted.
      bb.log.warn(`could not close terminal ${terminalId}: ${messageOf(cause)}`);
    }
  }

  /** One look at a running command: its new output, whether it ended, its address. */
  async function poll(threadId: string, run: Run): Promise<Run> {
    let finished: boolean;
    let exitCode: number | null;
    try {
      // Status before output: once a command is seen to have exited, the
      // output read after it is complete.
      const terminal = await bb.sdk.terminals.get({ terminalId: run.terminalId });
      finished = terminal.status === "exited";
      exitCode = terminal.exitCode;
    } catch (cause) {
      bb.log.warn(`lost terminal ${run.terminalId} for "${run.name}": ${messageOf(cause)}`);
      return { ...run, status: "lost", addressPending: false };
    }
    const copied = await copyOutput(threadId, run, finished);
    let next = copied.run;
    if (next.addressPending) {
      const printed = outputMentions(copied.recent, next.url);
      const waitedLongEnough = Date.now() >= next.startedAt + ADDRESS_WAIT_MS;
      const failed = finished && exitCode !== 0;
      if (failed) next = { ...next, addressPending: false };
      else if (printed || waitedLongEnough || finished) {
        await openAddress(threadId, next);
        next = { ...next, addressPending: false };
      }
    }
    if (!finished) return next;
    await closeTerminal(run.terminalId);
    return { ...next, status: "exited", exitCode };
  }

  async function pollThread(threadId: string): Promise<void> {
    const runs = await readRuns(threadId);
    if (!runs.some((run) => run.status === "running")) return;
    const next: Run[] = [];
    for (const run of runs) next.push(run.status === "running" ? await poll(threadId, run) : run);
    await writeRuns(threadId, next);
    if (next.some((run, index) => run.status !== runs[index]?.status)) {
      bb.realtime.publish(RUNS_CHANGED, { threadId });
    }
  }

  async function pollAll(): Promise<void> {
    for (const key of await bb.storage.kv.list(RUNS_PREFIX)) {
      const threadId = key.slice(RUNS_PREFIX.length);
      try {
        await serialized(threadId, () => pollThread(threadId));
      } catch (cause) {
        bb.log.warn(`could not follow the commands in ${threadId}: ${messageOf(cause)}`);
      }
    }
  }

  // Started at load and stopped on reload, so a plugin update picks up the
  // runs where the previous version left them.
  bb.background.service("follow-runs", {
    async start(signal) {
      while (!signal.aborted) {
        await pollAll();
        await sleep(POLL_MS, signal);
      }
    },
  });

  // ── starting and stopping ─────────────────────────────────────────────

  /** Stop a running command, keeping everything it printed up to then. */
  async function stop(threadId: string, run: Run): Promise<Run> {
    let next = run;
    try {
      next = (await copyOutput(threadId, run, true)).run;
    } catch (cause) {
      bb.log.warn(`could not read the last output of "${run.name}": ${messageOf(cause)}`);
    }
    await closeTerminal(run.terminalId);
    return { ...next, status: "stopped", addressPending: false };
  }

  async function start(threadId: string, presetId: string): Promise<Run> {
    const { projectId } = await bb.sdk.threads.get({ threadId });
    const preset = (await readPresets(projectId)).find((candidate) => candidate.id === presetId);
    if (preset === undefined) throw new Error("That command is no longer in the list.");
    const previous: Run[] = [];
    for (const run of await readRuns(threadId)) {
      previous.push(run.presetId === presetId && run.status === "running" ? await stop(threadId, run) : run);
    }
    const terminal = await bb.sdk.terminals.create({
      scope: { kind: "thread", threadId },
      start: { mode: "command", command: preset.command },
      title: preset.name,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    });
    const run: Run = {
      id: crypto.randomUUID(),
      presetId,
      name: preset.name,
      command: preset.command,
      url: preset.url,
      terminalId: terminal.id,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      nextSeq: 0,
      addressPending: preset.url !== "",
    };
    const { kept, dropped } = pruneRuns([...previous, run]);
    await writeRuns(threadId, kept);
    await forget(dropped);
    bb.realtime.publish(RUNS_CHANGED, { threadId });
    return run;
  }

  async function runOf(threadId: string, runId: string): Promise<{ runs: Run[]; run: Run }> {
    const runs = await readRuns(threadId);
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new Error("That run is no longer in this thread's output.");
    return { runs, run };
  }

  const newestFirst = (runs: readonly Run[]) => [...runs].reverse().map(summarize);

  bb.rpc.register(rpcContract, {
    presets_get: async ({ projectId }) => ({ presets: await readPresets(projectId) }),

    presets_save: async ({ projectId, presets }) => {
      await bb.storage.kv.set(presetsKeyFor(projectId), presets);
      bb.realtime.publish(PRESETS_CHANGED, { projectId });
      return { presets };
    },

    projects: async () => ({
      projects: (await bb.sdk.projects.list({})).map(({ id, name }) => ({ id, name })),
    }),

    run: ({ threadId, presetId }) =>
      serialized(threadId, async () => ({ run: summarize(await start(threadId, presetId)) })),

    stop: ({ threadId, runId }) =>
      serialized(threadId, async () => {
        const { runs, run } = await runOf(threadId, runId);
        if (run.status !== "running") return { run: summarize(run) };
        const stopped = await stop(threadId, run);
        await writeRuns(threadId, runs.map((entry) => (entry.id === runId ? stopped : entry)));
        bb.realtime.publish(RUNS_CHANGED, { threadId });
        return { run: summarize(stopped) };
      }),

    runs: async ({ threadId }) => ({ runs: newestFirst(await readRuns(threadId)) }),

    clear: ({ threadId }) =>
      serialized(threadId, async () => {
        const runs = await readRuns(threadId);
        const running = runs.filter((run) => run.status === "running");
        await writeRuns(threadId, running);
        await forget(runs.filter((run) => run.status !== "running"));
        bb.realtime.publish(RUNS_CHANGED, { threadId });
        return { runs: newestFirst(running) };
      }),

    output: async ({ threadId, runId, from }) => {
      await runOf(threadId, runId);
      return outputAfter(await readOutput(runId), from);
    },
  });
}
