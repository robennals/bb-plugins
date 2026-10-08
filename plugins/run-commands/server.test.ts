import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preset } from "./presets.js";
import { OUTPUT_ADDED, RUNS_CHANGED } from "./channels.js";
import { MAX_RUNS } from "./runs.js";
import plugin, { ADDRESS_WAIT_MS, POLL_MS, rpcContract } from "./server.js";
import type { PanelTab } from "./tabs.js";

const PLUGIN = "run-commands";
const THREAD = "thr_1";
const ENVIRONMENT = "env_1";
const PROJECT = "proj_1";

const infoTab: PanelTab = { id: "a", kind: "thread-info" };

const dev: Preset = { id: "dev", name: "Dev server", command: "npm run dev", url: "" };
const tests: Preset = { id: "tests", name: "Tests", command: "npm test", url: "" };
const web: Preset = { ...dev, id: "web", url: "http://localhost:3000" };

const browserTab: PanelTab = {
  id: "run-commands-web-localhost-3000",
  kind: "browser",
  environmentId: ENVIRONMENT,
  title: "Dev server",
  url: "http://localhost:3000",
};

/**
 * A stand-in for BB's tab store. `update` enforces the same revision check the
 * real one does, so the compare-and-swap paths are exercised rather than
 * mocked away.
 */
function createTabStore() {
  const state = { revision: 4, tabs: [infoTab] };
  return {
    state,
    get: vi.fn(async () => ({ revision: state.revision, tabs: state.tabs })),
    update: vi.fn(
      async ({ expectedRevision, tabs }: { expectedRevision: number; tabs: PanelTab[] }) => {
        if (expectedRevision !== state.revision) throw new Error("revision mismatch");
        state.revision += 1;
        state.tabs = tabs;
        return { revision: state.revision, tabs: state.tabs };
      },
    ),
  };
}

interface FakeTerminal {
  id: string;
  status: "running" | "exited";
  exitCode: number | null;
  /** Everything printed so far; one chunk per `print`. */
  chunks: string[];
}

/** A stand-in for BB's terminals: enough to start, inspect, read and close one. */
function createTerminals() {
  const open = new Map<string, FakeTerminal>();
  let created = 0;
  const find = (terminalId: string) => {
    const terminal = open.get(terminalId);
    if (terminal === undefined) throw new Error(`no terminal ${terminalId}`);
    return terminal;
  };
  return {
    open,
    print: (terminalId: string, text: string) => find(terminalId).chunks.push(text),
    exit: (terminalId: string, exitCode: number) =>
      Object.assign(find(terminalId), { status: "exited", exitCode }),
    create: vi.fn(async (_args: unknown) => {
      created += 1;
      const terminal: FakeTerminal = {
        id: `term_${created}`,
        status: "running",
        exitCode: null,
        chunks: [],
      };
      open.set(terminal.id, terminal);
      return terminal;
    }),
    get: vi.fn(async ({ terminalId }: { terminalId: string }) => find(terminalId)),
    close: vi.fn(async ({ terminalId }: { terminalId: string }) => {
      const terminal = find(terminalId);
      open.delete(terminalId);
      return terminal;
    }),
    output: vi.fn(async ({ terminalId, sinceSeq = 0 }: { terminalId: string; sinceSeq?: number }) => {
      const { chunks } = find(terminalId);
      return {
        chunks: chunks.slice(sinceSeq).map((text, index) => ({
          seq: sinceSeq + index,
          dataBase64: Buffer.from(text).toString("base64"),
        })),
        nextSeq: chunks.length,
        truncated: false,
      };
    }),
  };
}

let stopService: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  stopService?.();
  stopService = null;
  vi.useRealTimers();
});

async function createHost(presets: Preset[] = [dev, tests, web]) {
  const store = createTabStore();
  const terminals = createTerminals();
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    sdk: {
      threads: {
        get: vi.fn(async () => ({ environmentId: ENVIRONMENT, projectId: PROJECT })),
        tabs: { get: store.get, update: store.update },
      },
      terminals,
      projects: {
        list: vi.fn(async () => [
          { id: PROJECT, name: "app", path: "/repos/app" },
          { id: "proj_2", name: "site", path: "/repos/site" },
        ]),
      },
    },
  });
  plugin(bb);
  const service = harness.behavior.runService("follow-runs");
  stopService = () => service.controller.abort();
  const rpc = (method: string, input: Record<string, unknown>) =>
    harness.behavior.callRpc(method, { threadId: THREAD, ...input });
  const run = async (presetId: string) =>
    rpcContract.run.output.parse(await rpc("run", { presetId })).run;
  const runs = async () => rpcContract.runs.output.parse(await rpc("runs", {})).runs;
  const output = async (runId: string, from = 0) =>
    rpcContract.output.output.parse(await rpc("output", { runId, from }));
  /** Let the background loop take another look. */
  const tick = () => vi.advanceTimersByTimeAsync(POLL_MS);
  await harness.behavior.callRpc("presets_save", { projectId: PROJECT, presets });
  return { harness, store, terminals, rpc, run, runs, output, tick };
}

describe("running a command", () => {
  it("starts it in a terminal for the thread and records the run", async () => {
    const { terminals, run, runs } = await createHost();
    const started = await run("dev");
    expect(terminals.create).toHaveBeenCalledWith({
      scope: { kind: "thread", threadId: THREAD },
      start: { mode: "command", command: "npm run dev" },
      title: "Dev server",
      cols: 120,
      rows: 30,
    });
    expect(started).toMatchObject({ name: "Dev server", command: "npm run dev", status: "running" });
    expect(await runs()).toEqual([started]);
  });

  it("lists runs newest first", async () => {
    const { run, runs } = await createHost();
    await run("dev");
    await run("tests");
    expect((await runs()).map((entry) => entry.name)).toEqual(["Tests", "Dev server"]);
  });

  it("restarts a command that is still running instead of starting a second copy", async () => {
    const { terminals, run, runs } = await createHost();
    await run("dev");
    await run("dev");
    expect([...terminals.open.keys()]).toEqual(["term_2"]);
    expect((await runs()).map((entry) => entry.status)).toEqual(["running", "stopped"]);
  });

  it("refuses a command that has since been removed from the list", async () => {
    const { run } = await createHost([]);
    await expect(run("dev")).rejects.toThrow("That command is no longer in the list.");
  });

  it("forgets the oldest finished run, and its output, past the limit", async () => {
    const { terminals, run, runs, output, tick } = await createHost();
    const first = await run("tests");
    terminals.print("term_1", "first\n");
    terminals.exit("term_1", 0);
    await tick();
    for (let index = 1; index < MAX_RUNS; index += 1) await run("tests");
    expect(await runs()).toHaveLength(MAX_RUNS);
    await run("tests");
    expect((await runs()).map((entry) => entry.id)).not.toContain(first.id);
    await expect(output(first.id)).rejects.toThrow("no longer in this thread's output");
  });
});

describe("following a command's output", () => {
  it("copies what it prints, without colour codes, and announces each addition", async () => {
    const { harness, terminals, run, output, tick } = await createHost();
    const started = await run("dev");
    terminals.print("term_1", "\u001b[32mcompiling\u001b[0m\r\n");
    await tick();
    expect(await output(started.id)).toEqual({ text: "compiling\r\n", start: 0, end: 11 });
    expect(harness.realtimeSignals).toContainEqual({
      channel: OUTPUT_ADDED,
      payload: { threadId: THREAD, runId: started.id },
    });
    terminals.print("term_1", "ready\r\n");
    await tick();
    expect(await output(started.id, 11)).toEqual({ text: "ready\r\n", start: 11, end: 18 });
  });

  it("joins an escape sequence split between two reads", async () => {
    const { terminals, run, output, tick } = await createHost();
    const started = await run("dev");
    terminals.print("term_1", "a\u001b[3");
    await tick();
    terminals.print("term_1", "2mb");
    await tick();
    expect((await output(started.id)).text).toBe("ab");
  });

  it("records how a command ended, keeps its last words, and closes its terminal", async () => {
    const { harness, terminals, run, runs, output, tick } = await createHost();
    const started = await run("tests");
    terminals.print("term_1", "1 failed\n");
    terminals.exit("term_1", 1);
    await tick();
    expect(await runs()).toEqual([{ ...started, status: "exited", exitCode: 1 }]);
    expect((await output(started.id)).text).toBe("1 failed\n");
    expect(terminals.open.size).toBe(0);
    expect(harness.realtimeSignals).toContainEqual({ channel: RUNS_CHANGED, payload: { threadId: THREAD } });
  });

  it("marks a run lost when its terminal disappears", async () => {
    const { terminals, run, runs, tick } = await createHost();
    await run("dev");
    terminals.open.delete("term_1");
    await tick();
    expect((await runs())[0]?.status).toBe("lost");
  });

  it("stops a command, keeping what it printed", async () => {
    const { terminals, rpc, run, runs, output } = await createHost();
    const started = await run("dev");
    terminals.print("term_1", "serving\n");
    await rpc("stop", { runId: started.id });
    expect(terminals.open.size).toBe(0);
    expect((await runs())[0]?.status).toBe("stopped");
    expect((await output(started.id)).text).toBe("serving\n");
  });

  it("clears finished runs and keeps running ones", async () => {
    const { terminals, rpc, run, runs, tick } = await createHost();
    await run("tests");
    terminals.exit("term_1", 0);
    await tick();
    await run("dev");
    await rpc("clear", {});
    expect((await runs()).map((entry) => entry.name)).toEqual(["Dev server"]);
  });
});

describe("a command with an address to open", () => {
  it("opens the address once the command has printed it, and not before", async () => {
    const { store, terminals, run, tick } = await createHost();
    await run("web");
    terminals.print("term_1", "compiling…\r\n");
    await tick();
    await tick();
    expect(store.state.tabs).toEqual([infoTab]);
    terminals.print("term_1", "ready on http://localhost:3000\r\n");
    await tick();
    expect(store.state.tabs).toEqual([infoTab, browserTab]);
  });

  it("opens it anyway when the command never prints it", async () => {
    const { store, run } = await createHost();
    await run("web");
    await vi.advanceTimersByTimeAsync(ADDRESS_WAIT_MS + POLL_MS);
    expect(store.state.tabs).toEqual([infoTab, browserTab]);
  });

  it("does not open it for a command that failed", async () => {
    const { store, terminals, run } = await createHost();
    await run("web");
    terminals.exit("term_1", 1);
    await vi.advanceTimersByTimeAsync(ADDRESS_WAIT_MS + POLL_MS);
    expect(store.state.tabs).toEqual([infoTab]);
  });

  it("does not open it for a command stopped while starting up", async () => {
    const { store, rpc, run } = await createHost();
    const started = await run("web");
    await rpc("stop", { runId: started.id });
    await vi.advanceTimersByTimeAsync(ADDRESS_WAIT_MS + POLL_MS);
    expect(store.state.tabs).toEqual([infoTab]);
  });

  it("retries the tab write once when another client changed the tabs first", async () => {
    const { store, terminals, run, tick } = await createHost();
    await run("web");
    store.get.mockResolvedValueOnce({ revision: 3, tabs: [infoTab] });
    terminals.print("term_1", "http://localhost:3000\n");
    await tick();
    expect(store.update).toHaveBeenCalledTimes(2);
    expect(store.state.tabs).toEqual([infoTab, browserTab]);
  });
});

describe("the list of commands", () => {
  it("is saved for its project, and tells that project's open headers to refetch", async () => {
    const { harness } = await createHost([dev]);
    await expect(harness.behavior.callRpc("presets_get", { projectId: PROJECT })).resolves.toEqual({
      presets: [dev],
    });
    expect(harness.realtimeSignals).toContainEqual({
      channel: "presets-changed",
      payload: { projectId: PROJECT },
    });
  });

  it("belongs to one project: another project starts with none", async () => {
    const { harness } = await createHost([dev]);
    await expect(harness.behavior.callRpc("presets_get", { projectId: "proj_2" })).resolves.toEqual({
      presets: [],
    });
  });

  it("offers every project to the Settings page, by id and name only", async () => {
    const { harness } = await createHost();
    await expect(harness.behavior.callRpc("projects", null)).resolves.toEqual({
      projects: [
        { id: PROJECT, name: "app" },
        { id: "proj_2", name: "site" },
      ],
    });
  });
});
