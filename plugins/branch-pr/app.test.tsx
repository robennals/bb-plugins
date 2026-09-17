// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, expect, describe, it, vi } from "vitest";
import { LAUNCHER_ACTION_ID, type OpenResult } from "./server.js";

// The header button's whole visible output is a toast, so the toasts are the
// assertion — sonner is stubbed rather than rendered.
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

const opened: OpenResult = {
  outcome: "opened",
  number: 7,
  title: "Ship it",
  url: "https://github.com/acme/app/pull/7",
};

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

async function renderHeader(open: (input: unknown) => unknown) {
  const app = await loadApp();
  const registration = app.threadHeaderActions.find((entry) => entry.id === "branch-pr")!;
  const slot = renderSlot(
    registration,
    { threadId: THREAD, projectId: "prj_1", isCompactViewport: false },
    { rpc: { open } },
  );
  mounted = slot;
  return slot;
}

async function renderLauncher(open: (input: unknown) => unknown) {
  const app = await loadApp();
  const registration = app.threadPanelActions.find((entry) => entry.id === LAUNCHER_ACTION_ID)!;
  const slot = renderSlot(registration, { threadId: THREAD, params: null }, { rpc: { open } });
  mounted = slot;
  return slot;
}

describe("registrations", () => {
  // The frontend harness captures no command-palette actions, so the palette
  // registration is verified by hand against a running bb, not here.
  it("registers the header button and the panel launcher", async () => {
    const app = await loadApp();
    expect(app.threadHeaderActions.map((entry) => entry.id)).toContain("branch-pr");
    expect(app.threadPanelActions.map((entry) => entry.id)).toContain(LAUNCHER_ACTION_ID);
  });
});

describe("the header button", () => {
  it("asks for this thread's pull request, not the launcher's", async () => {
    const open = vi.fn(() => opened);
    const slot = await renderHeader(open);
    (await slot.findByLabelText("Open this branch's pull request")).click();
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith({ threadId: THREAD, fromLauncher: false }),
    );
  });

  it("celebrates what it opened", async () => {
    const slot = await renderHeader(vi.fn(() => opened));
    (await slot.findByLabelText("Open this branch's pull request")).click();
    await vi.waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Opened PR #7 — Ship it"),
    );
  });

  it("reports a branch with no pull request without crying error", async () => {
    const result: OpenResult = { outcome: "absent", branchName: "my-feature" };
    const slot = await renderHeader(vi.fn(() => result));
    (await slot.findByLabelText("Open this branch's pull request")).click();
    await vi.waitFor(() =>
      expect(toasts.plain).toHaveBeenCalledWith("No pull request for my-feature."),
    );
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("surfaces a rejected call as an error toast rather than silence", async () => {
    const slot = await renderHeader(
      vi.fn(() => {
        throw new Error("the tab list would not hold still");
      }),
    );
    (await slot.findByLabelText("Open this branch's pull request")).click();
    await vi.waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("the tab list would not hold still"),
    );
  });
});

describe("the panel launcher", () => {
  it("looks the pull request up on mount, asking to drop its own tab", async () => {
    const open = vi.fn(() => opened);
    await renderLauncher(open);
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith({ threadId: THREAD, fromLauncher: true }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("names the branch that has no pull request", async () => {
    const result: OpenResult = { outcome: "absent", branchName: "my-feature" };
    const slot = await renderLauncher(vi.fn(() => result));
    expect(await slot.findByText("No pull request for my-feature.")).toBeTruthy();
  });

  it("reports a failed lookup as a failure, never as 'no pull request'", async () => {
    const result: OpenResult = { outcome: "unavailable", message: "gh is not authenticated" };
    const slot = await renderLauncher(vi.fn(() => result));
    const message = await slot.findByText(
      "Could not check for a pull request: gh is not authenticated",
    );
    expect(message).toBeTruthy();
  });

  it("shows the reason when the call itself is rejected", async () => {
    const slot = await renderLauncher(
      vi.fn(() => {
        throw new Error("the tab list would not hold still");
      }),
    );
    expect(await slot.findByText("the tab list would not hold still")).toBeTruthy();
  });

  it("asks again when Try again is pressed", async () => {
    const result: OpenResult = { outcome: "absent", branchName: "my-feature" };
    const open = vi.fn(() => result);
    const slot = await renderLauncher(open);
    (await slot.findByText("Try again")).click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
