// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Preset } from "./presets.js";
import type { RunSummary } from "./runs.js";

// The header menu's answers are toasts, so the toasts are the assertion —
// sonner is stubbed rather than rendered.
const toasts = { plain: vi.fn(), success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => {
  const toast = Object.assign((text: string) => toasts.plain(text), {
    success: (text: string) => toasts.success(text),
    error: (text: string) => toasts.error(text),
  });
  return { toast };
});

beforeEach(() => {
  toasts.plain.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const THREAD = "thr_1";
const PROJECT = "proj_1";
const dev: Preset = { id: "dev", name: "Dev server", command: "npm run dev", url: "" };

async function loadApp() {
  return await loadPluginApp(() => import("./app"));
}

// renderSlot mounts into document.body; without this every later query sees
// the previous test's markup too.
let mounted: { lifecycle: { unmount: () => void } } | null = null;
afterEach(() => {
  mounted?.lifecycle.unmount();
  mounted = null;
});

type Rpc = Record<string, (input: unknown) => unknown>;

async function renderHeader(rpc: Rpc) {
  const app = await loadApp();
  const registration = app.threadHeaderActions.find((entry) => entry.id === "run-commands")!;
  const slot = renderSlot(
    registration,
    { threadId: THREAD, projectId: PROJECT, isCompactViewport: false },
    { rpc },
  );
  mounted = slot;
  return slot;
}

const projects = () => ({
  projects: [
    { id: PROJECT, name: "app" },
    { id: "proj_2", name: "site" },
  ],
});

async function renderSettings(rpc: Rpc) {
  const app = await loadApp();
  const registration = app.settingsSections.find((entry) => entry.id === "commands")!;
  const slot = renderSlot(registration, {}, { rpc: { projects, ...rpc } });
  mounted = slot;
  return slot;
}

/** Radix opens its menus on pointer-down and keyboard, not on a synthetic click. */
async function openMenu(slot: Awaited<ReturnType<typeof renderHeader>>) {
  const trigger = await slot.findByLabelText("Run a command");
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("the header menu", () => {
  it("runs the command that is picked, in this thread, and shows the output tab", async () => {
    const run = vi.fn(() => ({ run: {} }));
    const slot = await renderHeader({ presets_get: () => ({ presets: [dev] }), run });
    await openMenu(slot);
    fireEvent.click(await slot.findByText("Dev server"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ threadId: THREAD, presetId: "dev" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "output", title: "Command output" },
    });
  });

  it("surfaces a rejected run as an error toast rather than silence", async () => {
    const slot = await renderHeader({
      presets_get: () => ({ presets: [dev] }),
      run: () => {
        throw new Error("this thread has no workspace");
      },
    });
    await openMenu(slot);
    fireEvent.click(await slot.findByText("Dev server"));
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith("this thread has no workspace"));
  });

  it("points at the editor when there are no commands yet", async () => {
    const slot = await renderHeader({ presets_get: () => ({ presets: [] }) });
    await openMenu(slot);
    expect(await slot.findByText("No commands yet")).toBeTruthy();
    expect(await slot.findByText("Edit commands…")).toBeTruthy();
  });

  it("asks for this project's commands, and refetches when they are edited elsewhere", async () => {
    const presets_get = vi.fn(() => ({ presets: [dev] }));
    const slot = await renderHeader({ presets_get });
    await vi.waitFor(() => expect(presets_get).toHaveBeenCalledWith({ projectId: PROJECT }));
    await slot.behavior.emitRealtime("presets-changed", { projectId: "proj_2" });
    await slot.behavior.emitRealtime("presets-changed", { projectId: PROJECT });
    await vi.waitFor(() => expect(presets_get).toHaveBeenCalledTimes(2));
  });
});

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1",
    name: "Dev server",
    command: "npm run dev",
    startedAt: 0,
    status: "running",
    exitCode: null,
    ...overrides,
  };
}

/** What the output tab sends to the `output` method. */
const outputInput = z.object({ runId: z.string(), from: z.number() });

async function renderOutput(rpc: Rpc) {
  const app = await loadApp();
  const registration = app.threadPanelActions.find((entry) => entry.id === "output")!;
  const slot = renderSlot(registration, { threadId: THREAD, params: null }, { rpc });
  mounted = slot;
  return slot;
}

describe("the output tab", () => {
  it("shows the newest run open, with its output, and older ones closed", async () => {
    const older = summary({ id: "run_0", name: "Tests", status: "exited", exitCode: 1 });
    const slot = await renderOutput({
      runs: () => ({ runs: [summary(), older] }),
      output: (input) =>
        outputInput.parse(input).runId === "run_1"
          ? { text: "50%\r100%\r\nready\n", start: 0, end: 15 }
          : { text: "", start: 0, end: 0 },
    });
    expect(await slot.findByText("Failed (exit code 1)")).toBeTruthy();
    const box = await slot.findByText((_, element) => element?.tagName === "PRE");
    await vi.waitFor(() => expect(box.textContent).toBe("100%\nready\n"));
    expect(slot.container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("asks only for the output it does not have yet when told more arrived", async () => {
    const output = vi.fn((input: unknown) =>
      outputInput.parse(input).from === 0
        ? { text: "one\n", start: 0, end: 4 }
        : { text: "two\n", start: 4, end: 8 },
    );
    const slot = await renderOutput({ runs: () => ({ runs: [summary()] }), output });
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
    await slot.behavior.emitRealtime("output-added", { threadId: THREAD, runId: "run_1" });
    await vi.waitFor(() =>
      expect(output).toHaveBeenLastCalledWith({ threadId: THREAD, runId: "run_1", from: 4 }),
    );
    await vi.waitFor(() => expect(slot.container.querySelector("pre")?.textContent).toBe("one\ntwo\n"));
  });

  it("stops a running command", async () => {
    const stop = vi.fn(() => ({ run: summary({ status: "stopped" }) }));
    const slot = await renderOutput({
      runs: () => ({ runs: [summary()] }),
      output: () => ({ text: "", start: 0, end: 0 }),
      stop,
    });
    fireEvent.click(await slot.findByLabelText('Stop "Dev server"'));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: THREAD, runId: "run_1" }));
  });

  it("opens and closes a run's box", async () => {
    const slot = await renderOutput({
      runs: () => ({ runs: [summary()] }),
      output: () => ({ text: "", start: 0, end: 0 }),
    });
    const toggle = await slot.findByRole("button", { expanded: true });
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(slot.container.querySelector("pre")).toBeNull());
  });

  it("says where to start when nothing has run yet", async () => {
    const slot = await renderOutput({ runs: () => ({ runs: [] }) });
    expect(await slot.findByText(/Nothing has run in this thread yet/)).toBeTruthy();
  });
});

describe("the command editor", () => {
  it("saves a command that was added", async () => {
    const save = vi.fn((input: unknown) => input);
    const slot = await renderSettings({ presets_get: () => ({ presets: [] }), presets_save: save });
    fireEvent.click(await slot.findByText("Add command"));
    fireEvent.change(slot.getByLabelText("Name of new command"), { target: { value: "Dev server" } });
    fireEvent.change(slot.getByLabelText('Command for "Dev server"'), {
      target: { value: "npm run dev" },
    });
    fireEvent.click(slot.getByText("Save"));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        projectId: PROJECT,
        presets: [
          { id: expect.any(String), name: "Dev server", command: "npm run dev", url: "" },
        ],
      }),
    );
  });

  it("says what is wrong instead of saving a command with no command line", async () => {
    const save = vi.fn((input: unknown) => input);
    const slot = await renderSettings({
      presets_get: () => ({ presets: [{ ...dev, command: "" }] }),
      presets_save: save,
    });
    fireEvent.click(await slot.findByText("Save"));
    expect(await slot.findByText("Enter the command to run")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("removes a command", async () => {
    const save = vi.fn((input: unknown) => input);
    const slot = await renderSettings({ presets_get: () => ({ presets: [dev] }), presets_save: save });
    fireEvent.click(await slot.findByLabelText('Remove "Dev server"'));
    fireEvent.click(slot.getByText("Save"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ projectId: PROJECT, presets: [] }));
  });

  it("edits the commands of whichever project is picked", async () => {
    const presets_get = vi.fn(() => ({ presets: [] }));
    const slot = await renderSettings({ presets_get });
    fireEvent.change(await slot.findByLabelText("Project"), { target: { value: "proj_2" } });
    await vi.waitFor(() => expect(presets_get).toHaveBeenLastCalledWith({ projectId: "proj_2" }));
  });
});
