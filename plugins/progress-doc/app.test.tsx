// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_ACTION_ID, type ListFilesResult, type LoadResult } from "./rpc";

const THREAD = "thr_1";
const DOC = "/home/me/agent-progress/ship-it-thr_1.md";

let mounted: { lifecycle: { unmount: () => void } } | null = null;
afterEach(() => {
  mounted?.lifecycle.unmount();
  mounted = null;
});

const noFiles: ListFilesResult = { kind: "missing", dir: "/home/me/agent-progress" };

async function renderPanel(rpc: {
  load: (input: unknown) => LoadResult;
  listFiles?: (input: unknown) => ListFilesResult;
  choosePath?: (input: unknown) => unknown;
  askAgent?: (input: unknown) => unknown;
  forget?: (input: unknown) => unknown;
}) {
  const app = await loadPluginApp(() => import("./app"));
  const registration = app.threadPanelActions.find((entry) => entry.id === PANEL_ACTION_ID)!;
  const slot = renderSlot(
    registration,
    { threadId: THREAD, params: null },
    {
      rpc: {
        listFiles: () => noFiles,
        choosePath: () => ({ ok: true, docPath: DOC }),
        askAgent: () => ({ ok: true, docPath: DOC }),
        forget: () => ({ ok: true }),
        ...rpc,
      },
    },
  );
  mounted = slot;
  return slot;
}

describe("with no doc chosen", () => {
  const unchosen = (): LoadResult => ({ kind: "unchosen" });

  it("lists the agent-progress files and opens the one you click", async () => {
    const choosePath = vi.fn(() => ({ ok: true, docPath: DOC }));
    const slot = await renderPanel({
      load: unchosen,
      listFiles: () => ({
        kind: "ok",
        dir: "/home/me/agent-progress",
        files: [{ name: "ship-it-thr_1.md", path: DOC, mtimeMs: 1 }],
      }),
      choosePath,
    });
    (await slot.findByText("ship-it-thr_1.md")).click();
    await vi.waitFor(() => expect(choosePath).toHaveBeenCalledWith({ threadId: THREAD, path: DOC }));
  });

  it("opens a pasted path", async () => {
    const choosePath = vi.fn(() => ({ ok: true, docPath: DOC }));
    const slot = await renderPanel({ load: unchosen, choosePath });
    const input = await slot.findByLabelText("Path to a markdown file");
    fireEvent.change(input, { target: { value: "~/notes/plan.md" } });
    (await slot.findByText("Open")).click();
    await vi.waitFor(() =>
      expect(choosePath).toHaveBeenCalledWith({ threadId: THREAD, path: "~/notes/plan.md" }),
    );
  });

  it("shows why a pasted path was refused", async () => {
    const slot = await renderPanel({
      load: unchosen,
      choosePath: () => ({ ok: false, message: "Not an absolute path." }),
    });
    fireEvent.change(await slot.findByLabelText("Path to a markdown file"), {
      target: { value: "plan.md" },
    });
    (await slot.findByText("Open")).click();
    expect(await slot.findByText("Not an absolute path.")).toBeTruthy();
  });

  it("asks the agent to keep a doc", async () => {
    const askAgent = vi.fn(() => ({ ok: true, docPath: DOC }));
    const slot = await renderPanel({ load: unchosen, askAgent });
    (await slot.findByText("Ask the agent to keep a progress doc")).click();
    await vi.waitFor(() => expect(askAgent).toHaveBeenCalledWith({ threadId: THREAD }));
  });
});

describe("with a doc chosen", () => {
  function chosen(doc: Extract<LoadResult, { kind: "chosen" }>["doc"], askedAgent = false) {
    return (): LoadResult => ({ kind: "chosen", docPath: DOC, askedAgent, doc });
  }

  it("renders the doc as markdown under its path", async () => {
    const slot = await renderPanel({ load: chosen({ kind: "content", content: "# Progress", mtimeMs: 1 }) });
    expect((await slot.findByTestId("bb-markdown")).textContent).toBe("# Progress");
    expect(slot.getByText(DOC)).toBeTruthy();
  });

  it("waits for the agent when it was asked to create the doc", async () => {
    const slot = await renderPanel({ load: chosen({ kind: "missing" }, true) });
    expect(await slot.findByText(/Waiting for the agent to create this file/)).toBeTruthy();
  });

  it("says the file is missing when nobody was asked to create it", async () => {
    const slot = await renderPanel({ load: chosen({ kind: "missing" }) });
    expect(await slot.findByText(/doesn't exist/)).toBeTruthy();
  });

  it("forgets the choice when you change file", async () => {
    const forget = vi.fn(() => ({ ok: true }));
    const slot = await renderPanel({
      load: chosen({ kind: "content", content: "# Progress", mtimeMs: 1 }),
      forget,
    });
    (await slot.findByText("Change file")).click();
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith({ threadId: THREAD }));
  });
});

describe("a thread with no workspace", () => {
  it("says there is no machine to read from", async () => {
    const slot = await renderPanel({ load: () => ({ kind: "no-machine" }) });
    expect(await slot.findByText(/no workspace yet/)).toBeTruthy();
  });
});

describe("when loading fails", () => {
  it("says why instead of loading forever", async () => {
    const slot = await renderPanel({
      load: () => {
        throw new Error("environment env_1 no longer exists");
      },
    });
    expect(await slot.findByText(/environment env_1 no longer exists/)).toBeTruthy();
  });
});

describe("polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it("waits for a slow poll to finish before starting the next", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = deferred<LoadResult>();
    const load = vi.fn(() => slow.promise);
    await renderPanel({ load: load as never });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow poll that answers after the doc was changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = deferred<LoadResult>();
    const chosenDoc: LoadResult = {
      kind: "chosen",
      docPath: DOC,
      askedAgent: false,
      doc: { kind: "content", content: "# Picked", mtimeMs: 1 },
    };
    let picked = false;
    const answers: Array<() => LoadResult | Promise<LoadResult>> = [
      () => ({ kind: "unchosen" }),
      () => slow.promise,
    ];
    const load = vi.fn(() => (picked ? chosenDoc : answers.shift()!()));
    const slot = await renderPanel({
      load: load as never,
      listFiles: () => ({
        kind: "ok",
        dir: "/home/me/agent-progress",
        files: [{ name: "ship-it-thr_1.md", path: DOC, mtimeMs: 1 }],
      }),
      choosePath: () => {
        picked = true;
        return { ok: true, docPath: DOC };
      },
    });
    const file = await slot.findByText("ship-it-thr_1.md");
    await vi.advanceTimersByTimeAsync(3_000); // the second, slow poll is now in flight
    expect(load).toHaveBeenCalledTimes(2);
    file.click();
    expect((await slot.findByTestId("bb-markdown")).textContent).toBe("# Picked");
    // Real timers from here, so React's scheduler can render the stale answer
    // if the panel accepts it; 200ms is well short of the next poll.
    vi.useRealTimers();
    slow.resolve({ kind: "unchosen" });
    await new Promise((settle) => setTimeout(settle, 200));
    expect(slot.queryByTestId("bb-markdown")?.textContent).toBe("# Picked");
  });
});
