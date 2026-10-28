// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, describe, it } from "vitest";
import { rpcContract, type PullRequest, type SavedState } from "./server";

/**
 * The thunk matters: app.tsx binds the plugin runtime at module load, so
 * loadPluginApp must install the test runtime before importing it.
 */
const load = () => loadPluginApp(() => import("./app"));

const PR: PullRequest = {
  key: "acme/app#7", id: "PR_7", repository: "acme/app", number: 7, title: "Add a thing", url: "https://github.com/acme/app/pull/7",
  status: "FAILING", summary: "1 check failing", isDraft: false, headRefName: "feature", baseRefName: "main", stack: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: null, changeMarker: "m1",
  projectId: "prj_1", projectName: "App", threadId: null, threadTitle: null, threadArchived: false, feedbackMuted: false,
};

function savedState(...prs: PullRequest[]): SavedState {
  return {
    repositories: [{ repository: "acme/app", projectName: "App" }], selectedRepository: "acme/app", sortOrder: "STATUS",
    list: { repository: "acme/app", prs, refreshedAt: "2026-01-02T00:00:00Z" }, collapsedStacks: [],
  };
}

describe("creating a thread for a pull request", () => {
  it("stays on the list, and offers the new thread from the pull request's row", async () => {
    const app = await load();
    // The server links the thread to the pull request, so every later list has it.
    let state = savedState(PR);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        prs_list: () => state,
        prs_refresh: () => state,
        prs_create_thread: () => {
          state = savedState({ ...PR, threadId: "thr_new", threadTitle: "PR #7: Add a thing" });
          return { threadId: "thr_new" };
        },
        prs_resolve_thread: () => ({ threadId: "thr_new", archived: false }),
      },
    });

    fireEvent.click(await slot.findByText("Create thread"));
    const instructions = await slot.findByLabelText("What should the agent do with #7?");
    fireEvent.change(instructions, { target: { value: "Fix the failing check." } });
    fireEvent.click(slot.getByText("Create thread"));

    const openThread = await slot.findByText("Open thread");
    expect(slot.inspection.rpcCalls.find((entry) => entry.method === "prs_create_thread")?.input)
      .toMatchObject({ repository: "acme/app", number: 7, projectId: "prj_1", instructions: "Fix the failing check." });
    expect(slot.queryByLabelText("What should the agent do with #7?")).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([]);

    // Going to the thread is still one click away.
    fireEvent.click(openThread);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ threadId: "thr_new" }));
    });
    slot.lifecycle.unmount();
  });
});

describe("muting feedback", () => {
  it("mutes from the row's menu, and offers to unmute once it is muted", async () => {
    const app = await load();
    const withFeedback: PullRequest = { ...PR, status: "FEEDBACK", summary: "Feedback from octocat needs a response" };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        prs_list: () => savedState(withFeedback),
        prs_refresh: () => savedState(withFeedback),
        prs_set_feedback_muted: () => savedState({ ...withFeedback, status: "WAITING", summary: "Muted feedback from octocat · waiting for more", feedbackMuted: true }),
      },
    });

    const openMenu = async () => {
      const menuButton = await slot.findByLabelText("More actions for pull request 7");
      fireEvent.keyDown(menuButton, { key: "Enter" });
    };
    await openMenu();
    // The menu is rendered outside the panel, so it is looked for on the whole screen.
    fireEvent.click(await screen.findByText("Mute feedback until there is more"));

    await slot.findByText("Muted feedback from octocat · waiting for more");
    expect(slot.inspection.rpcCalls.find((entry) => entry.method === "prs_set_feedback_muted")?.input)
      .toEqual({ repository: "acme/app", number: 7, muted: true });
    // A muted pull request is no longer FEEDBACK, and still has to offer the way back.
    await openMenu();
    await screen.findByText("Unmute feedback");
    slot.lifecycle.unmount();
  });

  it("offers no menu on a pull request with no feedback", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { prs_list: () => savedState(PR), prs_refresh: () => savedState(PR) } });
    await slot.findByText("Add a thing");
    expect(slot.queryByLabelText("More actions for pull request 7")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("stacked pull requests", () => {
  const stacked = (number: number, headRefName: string, baseRefName: string, status: PullRequest["status"]): PullRequest => ({
    ...PR, key: `acme/app#${number}`, id: `PR_${number}`, number, title: `Change ${number}`, headRefName, baseRefName, status,
  });
  const state = savedState(
    stacked(1, "a", "main", "FAILING"), stacked(2, "b", "a", "WAITING"), stacked(3, "c", "b", "WAITING"), stacked(9, "z", "main", "WAITING"),
  );

  it("names a stack after its lowest pull request still open", async () => {
    const app = await load();
    const partMerged = savedState(stacked(1, "a", "main", "MERGED"), stacked(2, "b", "a", "WAITING"), stacked(3, "c", "b", "WAITING"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { prs_list: () => partMerged, prs_refresh: () => partMerged } });
    await slot.findByRole("region", { name: "Stack of 3 pull requests: Change 2" });
    slot.lifecycle.unmount();
  });

  it("shows a stack as one unit that collapses to its header, and saves that", async () => {
    const app = await load();
    let current = state;
    const saves: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        prs_list: () => current, prs_refresh: () => current,
        prs_set_stack_collapsed: (raw: unknown) => {
          const input = rpcContract.prs_set_stack_collapsed.input.parse(raw);
          saves.push(input);
          current = { ...current, collapsedStacks: input.collapsed ? [input.stack] : [] };
          return current;
        },
      },
    });
    const stack = await slot.findByRole("region", { name: "Stack of 3 pull requests: Change 1" });
    expect(Array.from(stack.querySelectorAll("h2")).map((title) => title.textContent)).toEqual(["Change 3", "Change 2", "Change 1"]);
    expect(slot.getByText("Change 9").closest("section")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: /Change 1 · Stack of 3/ }));
    expect(stack.querySelectorAll("h2")).toHaveLength(0);
    expect(stack.textContent).toBe("Change 1· Stack of 3");
    await waitFor(() => expect(saves).toEqual([{ repository: "acme/app", stack: "acme/app#1", collapsed: true }]));
    slot.lifecycle.unmount();
  });

  it("opens with the stacks that were collapsed last time still collapsed", async () => {
    const app = await load();
    const collapsed = { ...state, collapsedStacks: ["acme/app#1"] };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { prs_list: () => collapsed, prs_refresh: () => collapsed } });
    const stack = await slot.findByRole("region", { name: "Stack of 3 pull requests: Change 1" });
    expect(stack.querySelectorAll("h2")).toHaveLength(0);
    expect(slot.getByRole("button", { name: /Change 1 · Stack of 3/ }).getAttribute("aria-expanded")).toBe("false");
    slot.lifecycle.unmount();
  });

  it("shows only a stack's matching pull requests under a filter, with the rest one click away", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { prs_list: () => state, prs_refresh: () => state } });
    fireEvent.click(await slot.findByLabelText(/Filter by failing status/));

    const stack = await slot.findByRole("region", { name: "Stack of 3 pull requests: Change 1" });
    expect(Array.from(stack.querySelectorAll("h2")).map((title) => title.textContent)).toEqual(["Change 1"]);
    expect(slot.queryByText("Change 9")).toBeNull();

    fireEvent.click(slot.getByText("2 more in this stack: #3, #2"));
    expect(Array.from(stack.querySelectorAll("h2")).map((title) => title.textContent)).toEqual(["Change 3", "Change 2", "Change 1"]);
    fireEvent.click(slot.getByText("Show only matching"));
    expect(Array.from(stack.querySelectorAll("h2")).map((title) => title.textContent)).toEqual(["Change 1"]);
    slot.lifecycle.unmount();
  });
});
