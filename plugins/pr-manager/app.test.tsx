// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, describe, it } from "vitest";
import type { PullRequest, SavedState } from "./server";

/**
 * The thunk matters: app.tsx binds the plugin runtime at module load, so
 * loadPluginApp must install the test runtime before importing it.
 */
const load = () => loadPluginApp(() => import("./app"));

const PR: PullRequest = {
  key: "acme/app#7", id: "PR_7", repository: "acme/app", number: 7, title: "Add a thing", url: "https://github.com/acme/app/pull/7",
  status: "FAILING", summary: "1 check failing", isDraft: false, headRefName: "feature", baseRefName: "main",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: null, changeMarker: "m1",
  projectId: "prj_1", projectName: "App", threadId: null, threadTitle: null, threadArchived: false,
};

function savedState(pr: PullRequest): SavedState {
  return {
    repositories: [{ repository: "acme/app", projectName: "App" }], selectedRepository: "acme/app", sortOrder: "STATUS",
    list: { repository: "acme/app", prs: [pr], refreshedAt: "2026-01-02T00:00:00Z" },
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
