// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import type { FindingDto, PullRequestDto, ReviewDto } from "./server";

/**
 * The thunk matters: app.tsx binds the plugin runtime at module load, so
 * loadPluginApp must install the test runtime before importing it.
 */
const load = () => loadPluginApp(() => import("./app"));

const READY = {
  state: "ready" as const,
  detail: null,
  viewer: "robennals",
  repos: ["acme/app"],
  myTeams: ["acme/core"],
  skills: ["code-review"],
};

const PR: PullRequestDto = {
  repo: "acme/app",
  number: 7,
  title: "Add a thing",
  author: "dan",
  url: "https://github.com/acme/app/pull/7",
  updatedAt: "2026-01-02T00:00:00Z",
  isDraft: false,
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  headRefOid: "sha7",
  baseRefName: "main",
  headRefName: "feature",
  labels: [],
  reviewRequests: [{ login: "robennals", teamSlug: null }],
  reviewStatus: "reported",
  reviewThreadId: "thr_1",
  openFindings: 1,
  postedFindings: 0,
};

const REVIEW: ReviewDto = {
  id: "acme/app#7",
  repo: "acme/app",
  number: 7,
  title: "Add a thing",
  status: "reported",
  summary: "",
  error: null,
  threadId: "thr_1",
  findingsPath: "/w/f.json",
  skills: ["code-review"],
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

const FINDING: FindingDto = {
  id: "f1",
  reviewId: "acme/app#7",
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  side: "RIGHT",
  severity: "high",
  category: "correctness",
  title: "Off by one",
  gist: "The loop runs one past the end of the buffer.",
  summary: "The loop runs one past the end of the buffer.",
  background: "The loop walks the buffer.",
  problem: "It runs one past the end.",
  suggestedFix: "Use < instead of <=.",
  suggestedComment: "Please fix the bound here.",
  draftComment: null,
  state: "open",
  commentUrl: null,
  postedAt: null,
  postedAs: "comment",
  postAnchor: { kind: "line" as const, line: 12, startLine: 10, adjusted: false },
  references: [],
};

const CODE = {
  prUrl: "https://github.com/acme/app/pull/7",
  locations: [
    {
      file: "src/a.ts",
      startLine: 10,
      endLine: 12,
      note: "",
      isPrimary: true,
      diffUrl: "https://github.com/acme/app/pull/7/files#diff-abc123R10",
      blobUrl: "https://github.com/acme/app/blob/sha7/src/a.ts#L10-L12",
      contextBlock:
        "[`src/a.ts:10-12`](https://github.com/acme/app/blob/sha7/src/a.ts#L10-L12)\n\n```ts\nconst x = 1;\n```",
      firstLine: 9,
      lines: ["line nine", "const x = 1;", "const y = 2;", "const z = 3;", "line thirteen"],
      hasMoreAbove: true,
      hasMoreBelow: true,
      error: null,
    },
    {
      file: "src/other.ts",
      startLine: 20,
      endLine: 20,
      note: "the pattern this should match",
      isPrimary: false,
      diffUrl: "https://github.com/acme/app/pull/7/files#diff-def456R20",
      blobUrl: "https://github.com/acme/app/blob/sha7/src/other.ts#L20",
      contextBlock: "[`src/other.ts:20`](https://github.com/acme/app/blob/sha7/src/other.ts#L20)",
      firstLine: 20,
      lines: ["retry(() => run());"],
      hasMoreAbove: true,
      hasMoreBelow: true,
      error: null,
    },
  ],
};

/** The panel's RPC surface, with per-test overrides. */
function rpc(overrides: Record<string, unknown> = {}) {
  return {
    status: () => READY,
    listPullRequests: () => ({ pullRequests: [PR] }),
    getPullRequest: () => ({
      pullRequest: PR,
      review: REVIEW,
      findings: [FINDING],
      hasPendingReview: false,
    }),
    getFindingCode: () => CODE,
    reviewForThread: () => ({ review: REVIEW, openFindings: 1, configuredSkills: ["code-review"] }),
    getPanelState: () => ({ repo: null, filter: null }),
    setPanelState: () => ({ repo: null, filter: null }),
    ...overrides,
  };
}

/** Props the host hands a thread panel tab. */
const FINDINGS_TAB = { threadId: "thr_1", params: null };

/** The Findings tab, on its issue list. */
const findingsTab = (app: Awaited<ReturnType<typeof load>>) => app.threadPanelActions[0]!;

/**
 * The Findings tab, opened on the issue rather than the list. The tab has no
 * route, so the only way in is the one the reviewer uses: click the row.
 */
async function renderIssue(options: Parameters<typeof renderSlot>[2]) {
  const app = await load();
  const slot = renderSlot(findingsTab(app), FINDINGS_TAB, options);
  const row = await slot.findByText("Off by one");
  fireEvent.click(row.closest("button") ?? row);
  await slot.findByText("All issues");
  return slot;
}

describe("registrations", () => {
  it("registers the inbox panel, the Findings tab, and the header control", async () => {
    // loadPluginApp applies the host's own validation, so this catches slot-id
    // and path mistakes that would break the real surfaces.
    const app = await load();
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel?.id).toBe("code-review");
    expect(panel?.path).toBe("code-review");
    // The issue list is a thread panel tab now, not a fixed tab on the panel.
    expect(panel?.fixedTabs ?? []).toHaveLength(0);
    expect(app.threadPanelActions).toHaveLength(1);
    expect(app.threadPanelActions[0]?.id).toBe("findings");
    // "flush": the tab owns its own padding and scrolling.
    expect(app.threadPanelActions[0]?.layout).toBe("flush");
    expect(app.threadHeaderActions).toHaveLength(1);
    expect(app.threadHeaderActions[0]?.id).toBe("findings");
  });
});

describe("the pull request list", () => {
  it("lists the PRs the filter returned", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    await slot.findByText("dan");
    slot.lifecycle.unmount();
  });

  it("asks for the direct-request filter first", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls.find((entry) => entry.method === "listPullRequests");
    expect((listCall?.input as { filter: { kind: string } }).filter.kind).toBe("mine");
    slot.lifecycle.unmount();
  });

  it("says the list excludes your own pull requests when it is empty", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ listPullRequests: () => ({ fetchedAt: "", pullRequests: [] }) }) },
    );
    const allTab = (await slot.findByText("All open")).closest("button") as HTMLElement;
    fireEvent.mouseDown(allTab);
    fireEvent.focus(allTab);
    fireEvent.click(allTab);
    await slot.findByText("This repo has no open pull requests from anyone else.");
    slot.lifecycle.unmount();
  });

  it("explains an empty list instead of showing a blank page", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ listPullRequests: () => ({ pullRequests: [] }) }) },
    );
    await slot.findByText("Nothing to review");
    slot.lifecycle.unmount();
  });

  it("opens the review thread of a PR that already has one", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    const row = await slot.findByText("Add a thing");
    fireEvent.click(row.closest("button") ?? row);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thr_1",
      });
    });
    // Opening an existing review must not start another one.
    expect(slot.inspection.rpcCalls.some((entry) => entry.method === "startReview")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("starts the review of a PR that has none, then opens its thread", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          listPullRequests: () => ({
            pullRequests: [
              { ...PR, reviewStatus: "none", reviewThreadId: null, openFindings: 0 },
            ],
          }),
          startReview: () => ({ review: { ...REVIEW, threadId: "thr_9" } }),
        }),
      },
    );
    // The row says what pressing it does, because pressing it spawns an agent.
    await slot.findByText("Review");
    const row = await slot.findByText("Add a thing");
    fireEvent.click(row.closest("button") ?? row);
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "startReview",
        input: { repo: "acme/app", number: 7 },
      });
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thr_9",
      });
    });
    slot.lifecycle.unmount();
  });

  it("says so when a started review somehow has no thread to open", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          listPullRequests: () => ({
            pullRequests: [
              { ...PR, reviewStatus: "none", reviewThreadId: null, openFindings: 0 },
            ],
          }),
          startReview: () => ({ review: { ...REVIEW, threadId: null } }),
        }),
      },
    );
    const row = await slot.findByText("Add a thing");
    fireEvent.click(row.closest("button") ?? row);
    await waitFor(() => expect(slot.queryByText("starting")).toBeNull());
    // Nowhere to go, so it says nothing happened rather than navigating.
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("says why nothing happened when starting a review fails", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          listPullRequests: () => ({
            pullRequests: [
              { ...PR, reviewStatus: "none", reviewThreadId: null, openFindings: 0 },
            ],
          }),
          startReview: () => {
            throw new Error("no project for acme/app");
          },
        }),
      },
    );
    const row = await slot.findByText("Add a thing");
    fireEvent.click(row.closest("button") ?? row);
    // The row comes back rather than staying stuck on "starting".
    await waitFor(() => expect(slot.queryByText("starting")).toBeNull());
    await slot.findByText("Review");
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("tells the user how to fix an unconfigured gh instead of failing silently", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: () => ({ ...READY, state: "needs_configuration", detail: "gh not found" }),
        }),
      },
    );
    await slot.findByText("The GitHub CLI needs setting up");
    await slot.findByText("gh not found");
    slot.lifecycle.unmount();
  });
});

describe("a PR's issue list", () => {
  it("deep-links to a PR through the panel's subPath", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getPullRequest");
    expect(call?.input).toEqual({ repo: "acme/app", number: 7 });
    slot.lifecycle.unmount();
  });

  it("shows each issue as a title, a gist, and a location — not the full detail", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, { rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("The loop runs one past the end of the buffer.");
    await slot.findByText("src/a.ts:10-12");
    // The list is a summary: the long-form fields belong to the detail view.
    expect(slot.queryByText("The loop walks the buffer.")).toBeNull();
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers a way into the PR on GitHub", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, { rpc: rpc() });
    const link = await slot.findByText("Open on GitHub");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://github.com/acme/app/pull/7");
    slot.lifecycle.unmount();
  });

  it("falls back to the problem when the agent wrote no summary", async () => {
    const app = await load();
    const slot = renderSlot(
      findingsTab(app),
      FINDINGS_TAB,
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, summary: "", gist: "It runs one past the end." }],
      hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("It runs one past the end.");
    slot.lifecycle.unmount();
  });

  it("explains a review that has not run yet", async () => {
    const app = await load();
    const slot = renderSlot(
      findingsTab(app),
      FINDINGS_TAB,
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: { ...PR, reviewStatus: "none", openFindings: 0 },
            review: null,
            findings: [],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("No review yet");
    await slot.findByText("Review this PR");
    slot.lifecycle.unmount();
  });

  it("surfaces a failed review's error", async () => {
    const app = await load();
    const slot = renderSlot(
      findingsTab(app),
      FINDINGS_TAB,
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: { ...REVIEW, status: "failed", error: "the thread gave up" },
            findings: [],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("the thread gave up");
    slot.lifecycle.unmount();
  });
});

describe("an issue and its code", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  it("shows the full detail above the code", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("The loop walks the buffer.");
    await slot.findByText("It runs one past the end.");
    await slot.findByText("Use < instead of <=.");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect((box as HTMLTextAreaElement).value).toBe("Please fix the bound here.");
    slot.lifecycle.unmount();
  });

  it("asks for the code with a small amount of context by default", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByText("const x = 1;");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getFindingCode");
    expect(call?.input).toEqual({ findingId: "f1", context: 3 });
    slot.lifecycle.unmount();
  });

  it("numbers snippet lines by their real position in the file", async () => {
    // The whole value of this view is that the numbers match the finding.
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByText("const x = 1;");
    for (const lineNumber of ["9", "10", "11", "12", "13"]) {
      await slot.findByText(lineNumber);
    }
    expect(slot.queryByText("1")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stacks every file the issue points at, with the reference's note", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByText("src/a.ts:10-12");
    await slot.findByText("src/other.ts:20");
    await slot.findByText("the pattern this should match");
    await slot.findByText("retry(() => run());");
    slot.lifecycle.unmount();
  });

  it("links each file to its place in the PR diff on GitHub", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("says why a file could not be shown instead of rendering nothing", async () => {
    const slot = await renderIssue(
      {
        rpc: rpc({
          getFindingCode: () => ({
            prUrl: CODE.prUrl,
            locations: [
              { ...CODE.locations[0], lines: [], error: "404 Not Found at c5b7b2a7bc42" },
            ],
          }),
        }),
      },
    );
    await slot.findByText("404 Not Found at c5b7b2a7bc42");
    slot.lifecycle.unmount();
  });

  it("explains an issue that a re-run replaced while you were reading it", async () => {
    let findings = [FINDING];
    const slot = await renderIssue({
      rpc: rpc({
        getPullRequest: () => ({
          pullRequest: PR,
          review: REVIEW,
          findings,
          hasPendingReview: false,
        }),
      }),
    });
    await slot.findByText("It runs one past the end.");
    // A re-run drops the open findings and announces it.
    findings = [];
    await slot.behavior.emitRealtime("code-review-changed", { at: "now" });
    await slot.findByText("This issue is gone");
    slot.lifecycle.unmount();
  });

  it("shows a posted issue as a link rather than an editable draft", async () => {
    const slot = await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [
              {
                ...FINDING,
                state: "posted",
                commentUrl: "https://github.com/acme/app/pull/7#c1",
              },
            ],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("View on GitHub");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("asking about an issue", () => {
  it("quotes the issue into the review thread's composer rather than spawning a thread", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    const button = await slot.findByText("Ask about this");
    fireEvent.click(button.closest("button") ?? button);
    await waitFor(() => expect(slot.inspection.composer.quotes).toHaveLength(1));
    const quote = slot.inspection.composer.quotes[0] ?? "";
    expect(quote).toContain("src/a.ts:10-12");
    expect(quote).toContain("acme/app#7");
    expect(quote).toContain("Off by one");
    expect(quote).toContain("Please fix the bound here.");
    slot.lifecycle.unmount();
  });

  it("quotes the reviewer's own edit, not the original suggestion", async () => {
    const slot = await renderIssue({
      rpc: rpc({
        getPullRequest: () => ({
          pullRequest: PR,
          review: REVIEW,
          findings: [{ ...FINDING, draftComment: "My own wording." }],
          hasPendingReview: false,
        }),
      }),
    });
    const button = await slot.findByText("Ask about this");
    fireEvent.click(button.closest("button") ?? button);
    await waitFor(() => expect(slot.inspection.composer.quotes).toHaveLength(1));
    expect(slot.inspection.composer.quotes[0]).toContain("My own wording.");
    slot.lifecycle.unmount();
  });
});

describe("moving between the issue list and an issue", () => {
  it("goes back to the list, since the browser's back no longer does", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, { rpc: rpc() });
    const row = await slot.findByText("Off by one");
    fireEvent.click(row.closest("button") ?? row);
    // On the issue: the long-form fields the list deliberately omits.
    await slot.findByText("The loop walks the buffer.");
    const back = await slot.findByText("All issues");
    fireEvent.click(back.closest("button") ?? back);
    await waitFor(() => expect(slot.queryByText("All issues")).toBeNull());
    // Back on the list: the gist, and no comment box.
    await slot.findByText("The loop runs one past the end of the buffer.");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the Findings tab on a thread that is not a review", () => {
  it("says so instead of showing an empty issue list", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, {
      rpc: rpc({
        reviewForThread: () => ({ review: null, openFindings: 0, configuredSkills: [] }),
      }),
    });
    await slot.findByText("Not a code review");
    slot.lifecycle.unmount();
  });

  it("resolves the review from the thread, not from tab params", async () => {
    const app = await load();
    const slot = renderSlot(findingsTab(app), FINDINGS_TAB, { rpc: rpc() });
    await slot.findByText("Off by one");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "reviewForThread");
    expect(call?.input).toEqual({ threadId: "thr_1" });
    slot.lifecycle.unmount();
  });
});

describe("the thread-header control", () => {
  const HEADER = { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false };

  it("opens the Findings tab on arrival at a review thread", async () => {
    const app = await load();
    const slot = renderSlot(app.threadHeaderActions[0]!, HEADER, {
      rpc: rpc(),
      openThreadPanel: () => true,
    });
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({
          method: "openThreadPanel",
          options: expect.objectContaining({ actionId: "findings" }),
        }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("shows the open issue count", async () => {
    const app = await load();
    const slot = renderSlot(app.threadHeaderActions[0]!, HEADER, {
      rpc: rpc({
        reviewForThread: () => ({ review: REVIEW, openFindings: 3, configuredSkills: [] }),
      }),
      openThreadPanel: () => true,
    });
    await slot.findByText("3 open");
    slot.lifecycle.unmount();
  });

  it("says so when the host will not open the tab here", async () => {
    const app = await load();
    const slot = renderSlot(app.threadHeaderActions[0]!, HEADER, {
      rpc: rpc(),
      // A surface with no side panel declines rather than throwing.
      openThreadPanel: () => false,
    });
    await slot.findByText("1 open");
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "openThreadPanel" }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("renders nothing at all on a thread that is not a review", async () => {
    const app = await load();
    const slot = renderSlot(app.threadHeaderActions[0]!, HEADER, {
      rpc: rpc({
        reviewForThread: () => ({ review: null, openFindings: 0, configuredSkills: [] }),
      }),
      openThreadPanel: () => true,
    });
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.some((entry) => entry.method === "reviewForThread"),
      ).toBe(true);
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("re-opens the tab when pressed, so closing it is not final", async () => {
    const app = await load();
    const slot = renderSlot(app.threadHeaderActions[0]!, HEADER, {
      rpc: rpc(),
      openThreadPanel: () => true,
    });
    const button = await slot.findByText("1 open");
    await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
    fireEvent.click(button.closest("button") ?? button);
    await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(2));
    slot.lifecycle.unmount();
  });
});

describe("remembering where you were", () => {
  it("restores the saved repo and filter instead of asking again", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: () => ({ ...READY, repos: ["acme/other", "acme/app"] }),
          getPanelState: () => ({
            repo: "acme/app",
            filter: { kind: "team", teamSlug: "acme/core" },
          }),
        }),
      },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    // Not "acme/other" (the first repo) and not the default "mine" filter.
    expect(listCall?.input).toEqual({
      repo: "acme/app",
      filter: { kind: "team", teamSlug: "acme/core" },
    });
    slot.lifecycle.unmount();
  });

  it("falls back to the first repo when nothing was saved", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect(listCall?.input).toEqual({ repo: "acme/app", filter: { kind: "mine" } });
    slot.lifecycle.unmount();
  });

  it("drops a saved repo the plugin no longer knows about", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ getPanelState: () => ({ repo: "acme/removed", filter: null }) }) },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect((listCall?.input as { repo: string }).repo).toBe("acme/app");
    slot.lifecycle.unmount();
  });

  it("saves the filter when the user changes it", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const allTab = (await slot.findByText("All open")).closest("button") as HTMLElement;
    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(allTab);
    fireEvent.focus(allTab);
    fireEvent.click(allTab);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.find((entry) => entry.method === "setPanelState");
      expect((saved?.input as { filter: { kind: string } })?.filter?.kind).toBe("all");
    });
    slot.lifecycle.unmount();
  });
});

describe("links out to GitHub", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  it("opens through BB's URL routing rather than a raw navigation", async () => {
    const slot = await renderIssue(
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("src/a.ts:10-12");
    fireEvent.click(link.closest("a") ?? link);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({
          method: "openUrl",
          url: "https://github.com/acme/app/pull/7/files#diff-abc123R10",
        }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("routes the PR link too", async () => {
    const app = await load();
    const slot = renderSlot(
      findingsTab(app),
      FINDINGS_TAB,
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("Open on GitHub");
    fireEvent.click(link.closest("a") ?? link);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "openUrl", url: "https://github.com/acme/app/pull/7" }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("keeps a real href so the link can be copied or opened in a new tab", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("leaves a modifier-click to the browser", async () => {
    // Cmd-click means "new tab"; swallowing it would be worse than useless.
    const slot = await renderIssue(
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("src/a.ts:10-12");
    fireEvent.click(link.closest("a") ?? link, { metaKey: true });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
});

describe("remembering the repo when status is slow", () => {
  it("keeps the saved repo even though the repo list arrives later", async () => {
    // Reproduction: in production `status` runs a gh auth probe and a teams
    // lookup, so it lands seconds after `getPanelState`. The saved repo must
    // not be discarded in the gap while the repo list is still empty.
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { ...READY, repos: ["acme/other", "acme/app"] };
          },
          getPanelState: () => ({ repo: "acme/app", filter: { kind: "mine" } }),
        }),
      },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect((listCall?.input as { repo: string }).repo).toBe("acme/app");
    slot.lifecycle.unmount();
  });
});

describe("the comment to post", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  const withFinding = async (overrides: Partial<FindingDto>) => {
    return await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, ...overrides }],
            hasPendingReview: false,
          }),
        }),
      },
    );
  };

  it("says which file and line range the comment lands on", async () => {
    const slot = await withFinding({});
    await slot.findByText("on src/a.ts, lines 10–12");
    slot.lifecycle.unmount();
  });

  it("says a single line as a line, not a range", async () => {
    const slot = await withFinding({
      startLine: 10,
      endLine: 10,
      postAnchor: { kind: "line" as const, line: 10, startLine: null, adjusted: false },
    });
    await slot.findByText("on src/a.ts, line 10");
    slot.lifecycle.unmount();
  });

  it("treats a null endLine as a single line", async () => {
    const slot = await withFinding({
      startLine: 10,
      endLine: null,
      postAnchor: { kind: "line" as const, line: 10, startLine: null, adjusted: false },
    });
    await slot.findByText("on src/a.ts, line 10");
    slot.lifecycle.unmount();
  });

  it("says when the anchor is on the old side of the diff", async () => {
    const slot = await withFinding({
      side: "LEFT",
      startLine: 4,
      endLine: 4,
      postAnchor: { kind: "line" as const, line: 4, startLine: null, adjusted: false },
    });
    await slot.findByText("on src/a.ts, line 4 of the old file");
    slot.lifecycle.unmount();
  });

  it("says it attaches to the file when the issue names no line", async () => {
    const slot = await withFinding({
      startLine: null,
      endLine: null,
      postAnchor: { kind: "file", line: null, startLine: null, adjusted: false },
    });
    await slot.findByText("on the file src/a.ts");
    await slot.findByText(/names no line/);
    slot.lifecycle.unmount();
  });

  it("links the target to that spot in the PR diff", async () => {
    const slot = await withFinding({});
    const link = await slot.findByText("on src/a.ts, lines 10–12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("says where a posted comment went, in the past tense", async () => {
    const slot = await withFinding({
      state: "posted",
      commentUrl: "https://github.com/acme/app/pull/7#c1",
    });
    await slot.findByText("Posted comment");
    await slot.findByText("on src/a.ts, lines 10–12");
    slot.lifecycle.unmount();
  });

  it("lets the box grow to the whole comment instead of clipping it", async () => {
    // Regression: `rows` was computed from newline count, so a long wrapped
    // one-paragraph comment — the usual shape — rendered three rows tall.
    const long = "A very long single-line review comment. ".repeat(30);
    const slot = await withFinding({ suggestedComment: long, draftComment: null });
    const box = (await slot.findByLabelText("Comment for Off by one")) as HTMLTextAreaElement;
    expect(box.value).toBe(long);
    // Height is driven by content, not by a fixed row count.
    expect(box.getAttribute("rows")).toBe("1");
    expect(box.className).toContain("overflow-hidden");
    slot.lifecycle.unmount();
  });
});

describe("a comment added to a pending review", () => {
  it("says it is a draft, not a published comment", async () => {
    // Nobody else can see it until the review is submitted on GitHub, so
    // calling it "posted" would be a lie.
    const slot = await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [
              {
                ...FINDING,
                state: "posted",
                postedAs: "pending-review",
                commentUrl: "https://github.com/acme/app/pull/7#d1",
              },
            ],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("Draft comment");
    await slot.findByText(/Submit that review on GitHub to publish it/);
    slot.lifecycle.unmount();
  });

  it("still says posted for an ordinary published comment", async () => {
    const slot = await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [
              { ...FINDING, state: "posted", commentUrl: "https://github.com/acme/app/pull/7#c1" },
            ],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("Posted comment");
    expect(slot.queryByText(/Submit that review on GitHub/)).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("a comment that cannot be anchored to a line", () => {
  // GitHub refuses a line comment outside a diff hunk (verified against the
  // API: the last line of a hunk is accepted, the next line is not), so the
  // comment attaches to the file and has to carry the lines itself.
  const toFile = {
    startLine: 59,
    endLine: 59,
    postAnchor: { kind: "file", line: null, startLine: null, adjusted: false },
  } as Partial<FindingDto>;

  const render = async (overrides: Partial<FindingDto> = toFile) => {
    return await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, ...overrides }],
            hasPendingReview: false,
          }),
        }),
      },
    );
  };

  it("says it will attach to the file, and why", async () => {
    const slot = await render();
    await slot.findByText("on the file src/a.ts");
    await slot.findByText(/anchors comments only to lines inside the diff/);
    slot.lifecycle.unmount();
  });

  it("labels the button as a comment on the file", async () => {
    const slot = await render();
    await slot.findByText("Comment on the file");
    slot.lifecycle.unmount();
  });

  it("says the code will be carried into the comment", async () => {
    const slot = await render();
    await slot.findByText(/a link and the code will be added above your text/);
    slot.lifecycle.unmount();
  });

  it("posts the link and quoted lines above the comment, without being asked", async () => {
    // Nobody wants the contextless version, so this is not a button.
    const slot = await render();
    const button = await slot.findByText("Comment on the file");
    fireEvent.click(button.closest("button") ?? button);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.find((entry) => entry.method === "setFindingComment");
      const body = (saved?.input as { comment: string } | undefined)?.comment ?? "";
      expect(body).toContain("[`src/a.ts:10-12`](https://github.com/acme/app/blob/sha7/src/a.ts");
      expect(body).toContain("```ts");
      expect(body.indexOf("blob/sha7")).toBeLessThan(body.indexOf("Please fix the bound here."));
    });
    slot.lifecycle.unmount();
  });

  it("says it will be a plain pull request comment when the file is not in the diff", async () => {
    const slot = await render({
      postAnchor: { kind: "pull-request", line: null, startLine: null, adjusted: false },
    });
    await slot.findByText("as a comment on the pull request");
    await slot.findByText(/does not touch that file/);
    slot.lifecycle.unmount();
  });

  it("does not add context when the comment anchors to the lines", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByLabelText("Comment for Off by one");
    expect(slot.queryByText(/will be added above your text/)).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the order of an issue view", () => {
  /** True when `a` appears before `b` in the document. */
  const isBefore = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("puts the code the comment attaches to above the comment itself", async () => {
    // The comment has to be read against the code, not from memory.
    const slot = await renderIssue({ rpc: rpc() });
    const code = await slot.findByText("const x = 1;");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect(isBefore(code, box)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("puts the other referenced code below the comment", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    const box = await slot.findByLabelText("Comment for Off by one");
    const other = await slot.findByText("src/other.ts:20");
    expect(isBefore(box, other)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("separates the attached code from the supporting code", async () => {
    const slot = await renderIssue({ rpc: rpc() });
    await slot.findByText("Code the comment attaches to");
    await slot.findByText("Other code this issue points at (1)");
    slot.lifecycle.unmount();
  });

  it("says the code is what the issue is about when nothing can be attached", async () => {
    const slot = await renderIssue(
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{
              ...FINDING,
              startLine: null,
              endLine: null,
              postAnchor: { kind: "file" as const, line: null, startLine: null, adjusted: false },
            }],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("Code this issue is about");
    expect(slot.queryByText("Code the comment attaches to")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("omits the supporting section when the issue cites one place", async () => {
    const slot = await renderIssue(
      { rpc: rpc({ getFindingCode: () => ({ ...CODE, locations: [CODE.locations[0]] }) }) },
    );
    await slot.findByText("const x = 1;");
    expect(slot.queryByText(/Other code this issue points at/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("still shows the comment when the code cannot be loaded", async () => {
    // Losing the snippet must not cost the reviewer the comment.
    const slot = await renderIssue(
      {
        rpc: rpc({
          getFindingCode: () => {
            throw new Error("boom");
          },
        }),
      },
    );
    await slot.findByText("Could not load the code");
    await slot.findByLabelText("Comment for Off by one");
    slot.lifecycle.unmount();
  });
});

describe("the Mine tab", () => {
  const clickTab = (element: HTMLElement) => {
    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(element);
    fireEvent.focus(element);
    fireEvent.click(element);
  };

  it("asks for the pull requests you opened, not ones assigned to you", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    clickTab((await slot.findByText("Mine")).closest("button") as HTMLElement);
    await waitFor(() => {
      const last = slot.inspection.rpcCalls
        .filter((entry) => entry.method === "listPullRequests")
        .at(-1);
      expect((last?.input as { filter: { kind: string } }).filter.kind).toBe("authored");
    });
    slot.lifecycle.unmount();
  });

  it("is remembered like any other filter", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    clickTab((await slot.findByText("Mine")).closest("button") as HTMLElement);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.find((entry) => entry.method === "setPanelState");
      expect((saved?.input as { filter: { kind: string } })?.filter?.kind).toBe("authored");
    });
    slot.lifecycle.unmount();
  });

  it("restores onto the Mine tab when that is what was saved", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ getPanelState: () => ({ repo: "acme/app", filter: { kind: "authored" } }) }) },
    );
    await waitFor(() => {
      const last = slot.inspection.rpcCalls
        .filter((entry) => entry.method === "listPullRequests")
        .at(-1);
      expect((last?.input as { filter: { kind: string } }).filter.kind).toBe("authored");
    });
    slot.lifecycle.unmount();
  });

  it("says something different when you have no open pull requests", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ listPullRequests: () => ({ fetchedAt: "", pullRequests: [] }) }) },
    );
    clickTab((await slot.findByText("Mine")).closest("button") as HTMLElement);
    await slot.findByText("You have no open pull requests in this repo.");
    slot.lifecycle.unmount();
  });
});
