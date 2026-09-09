// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { measureBounds, type DesktopBrowserState } from "./lib/desktop-browser";
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

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const x = 0;",
  "+const x = 1;",
].join("\n");

const PR_VIEW = {
  url: "https://github.com/acme/app/pull/7",
  fetchedAt: "2026-01-02T00:00:00Z",
  isReviewedCommit: true,
  snapshot: {
    title: "Add a thing",
    body: "Why this change exists.",
    author: "dan",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    headSha: "sha7abcdef",
    comments: [{ author: "kim", body: "Looks good.", createdAt: "2026-01-02T00:00:00Z", file: null, line: null }],
    reviewComments: [
      { author: "sam", body: "off by one", createdAt: "2026-01-02T00:00:00Z", file: "src/a.ts", line: 11 },
    ],
    files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
  },
  filesWithPatch: ["src/a.ts"],
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
      inDiff: true,
      // `lines` starts at 9, so `const x = 1;` is line 10: the pull request
      // added it, replacing the line that sat after line 9.
      addedLines: [10],
      removals: [{ afterLine: 9, lines: ["const x = 0;"] }],
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
      // Supporting context the pull request does not touch.
      inDiff: false,
      addedLines: [],
      removals: [],
    },
  ],
};

/** The panel's RPC surface, with per-test overrides. */
/**
 * A stand-in for the desktop shell's browser API, recording what the pane
 * asks the main process to do. jsdom has neither `window.bbDesktop` nor
 * `ResizeObserver`, so both are installed for the tests that need them.
 */
function fakeDesktopBrowser(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; arg: unknown }> = [];
  const record =
    (method: string) =>
    (arg: unknown = undefined) => {
      calls.push({ method, arg });
    };
  let push: ((state: DesktopBrowserState) => void) | null = null;
  const browser = {
    attach: record("attach"),
    detach: record("detach"),
    navigate: record("navigate"),
    goBack: record("goBack"),
    goForward: record("goForward"),
    reload: record("reload"),
    setBounds: record("setBounds"),
    setVisible: record("setVisible"),
    onState: (listener: (state: DesktopBrowserState) => void) => {
      push = listener;
      return () => {
        push = null;
      };
    },
    ...overrides,
  };
  window.bbDesktop = { browser };
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    calls,
    of: (method: string) => calls.filter((call) => call.method === method),
    pushState: (state: DesktopBrowserState) => push?.(state),
  };
}

afterEach(() => {
  delete window.bbDesktop;
});

/** Radix tabs activate on mousedown, not click. */
function clickTab(element: HTMLElement): void {
  fireEvent.mouseDown(element);
  fireEvent.focus(element);
  fireEvent.click(element);
}

/** A fixed tab by id — position is the tab strip's business, not a test's. */
function fixedTab(app: Awaited<ReturnType<typeof load>>, id: string) {
  const tab = app.navPanels[0]?.fixedTabs?.find((entry) => entry.id === id);
  if (tab === undefined) throw new Error(`no fixed tab ${id}`);
  return tab;
}

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
    getReviewThread: () => ({ threadId: REVIEW.threadId }),
    getPullRequestView: () => PR_VIEW,
    getPullRequestPatch: () => ({ patch: PATCH }),
    askAboutFinding: () => ({ threadId: REVIEW.threadId }),
    getPanelState: () => ({ repo: null, filter: null, sidePane: null, diffFile: null, diffUrl: null }),
    setPanelState: () => ({ repo: null, filter: null, sidePane: null, diffFile: null, diffUrl: null }),
    ...overrides,
  };
}

describe("registrations", () => {
  it("registers one nav panel with a single side tab that names it", async () => {
    // loadPluginApp applies the host's own validation, so this catches slot-id,
    // path, and fixed-tab/panel mismatches that would break the real panel.
    const app = await load();
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel?.id).toBe("code-review");
    expect(panel?.path).toBe("code-review");
    // A fixed tab whose panelId does not match its panel is rejected by BB.
    expect(panel?.fixedTabs?.every((tab) => tab.panelId === panel.id)).toBe(true);
    // One tab, because BB draws a plugin's fixed tabs icon-only and with the
    // plugin's own icon: two of them would be indistinguishable chips.
    expect(panel?.fixedTabs?.map((tab) => tab.id)).toEqual(["review"]);
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
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getPullRequest");
    expect(call?.input).toEqual({ repo: "acme/app", number: 7 });
    slot.lifecycle.unmount();
  });

  it("shows each issue as a title, a gist, and a location — not the full detail", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("The loop runs one past the end of the buffer.");
    await slot.findByText("src/a.ts:10-12");
    // The list is a summary: the long-form fields belong to the detail view.
    expect(slot.queryByText("The loop walks the buffer.")).toBeNull();
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });

  // It used to link out, which opened a BB browser tab that then sat there
  // across every other review.
  it("shows the PR in the plugin's own tab rather than opening a browser tab", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    fireEvent.click(await slot.findByText("Show pull request"));
    await waitFor(() =>
      expect(slot.inspection.experimental_fixedTabOpenCalls.map((call) => call.tabId)).toEqual([
        "review",
      ]),
    );
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.filter((entry) => entry.method === "setPanelState");
      expect(saved.map((entry) => entry.input)).toContainEqual({
        sidePane: "github",
        diffFile: null,
        diffUrl: null,
      });
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("falls back to the problem when the agent wrote no summary", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
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
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
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
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
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

  // There is no separate write-up any more: the comment is the finding's prose,
  // and everything else the reader needs is code shown beside it.
  it("leads with the comment, with no write-up above it", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("Off by one");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect((box as HTMLTextAreaElement).value).toBe("Please fix the bound here.");
    expect(slot.queryByText("Background")).toBeNull();
    expect(slot.queryByText("Problem")).toBeNull();
    expect(slot.queryByText("Suggested fix")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("asks for the code with a small amount of context by default", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("const x = 1;");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getFindingCode");
    expect(call?.input).toEqual({ findingId: "f1", context: 3 });
    slot.lifecycle.unmount();
  });

  it("numbers snippet lines by their real position in the file", async () => {
    // The whole value of this view is that the numbers match the finding.
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("const x = 1;");
    for (const lineNumber of ["9", "10", "11", "12", "13"]) {
      await slot.findByText(lineNumber);
    }
    expect(slot.queryByText("1")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stacks every file the issue points at, with the reference's note", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("src/a.ts:10-12");
    await slot.findByText("src/other.ts:20");
    await slot.findByText("the pattern this should match");
    await slot.findByText("retry(() => run());");
    slot.lifecycle.unmount();
  });

  it("links each file to its place in the PR diff on GitHub", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  // The snippet is the file, not a patch, so nothing in it says which lines the
  // pull request is responsible for unless the change is marked on it.
  it("marks added and deleted lines, and shows deletions the file no longer has", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    const added = (await slot.findByText("const x = 1;")).closest("tr");
    expect(added?.className).toContain("bg-diff-added");

    // A deleted line is not in the file at all; it is folded back in, in red,
    // beside the line that replaced it, and has no line number of its own.
    const removed = (await slot.findByText("const x = 0;")).closest("tr");
    expect(removed?.className).toContain("bg-diff-removed");
    expect(removed?.querySelector("td")?.textContent).toBe("");

    // Untouched context stays plain, so the colour means something.
    const context = (await slot.findByText("const y = 2;")).closest("tr");
    expect(context?.className).not.toContain("bg-diff-added");
    expect(context?.className).not.toContain("bg-diff-removed");
    slot.lifecycle.unmount();
  });

  // An uncoloured snippet is otherwise ambiguous between "the PR did not touch
  // this file" and "it did, but not the lines you are looking at".
  it("says where every cited location stands with the pull request", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    // src/a.ts: one line added, one deleted, in the window on show.
    await slot.findByText("+1 −1 here");
    // src/other.ts is supporting context the PR never touches.
    await slot.findByText("Not changed by this PR");
    slot.lifecycle.unmount();
  });

  it("distinguishes a changed file from changes in the lines on show", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          getFindingCode: () => ({
            ...CODE,
            locations: [{ ...CODE.locations[0], inDiff: true, addedLines: [], removals: [] }],
          }),
        }),
      },
    );
    await slot.findByText("Changed elsewhere in this file");
    slot.lifecycle.unmount();
  });

  it("says why a file could not be shown instead of rendering nothing", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
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

  // The old button navigated to the thread, which took the review off screen.
  it("opens the review thread in the side pane rather than navigating to it", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    fireEvent.click(await slot.findByText("Review thread"));
    await waitFor(() =>
      expect(slot.inspection.experimental_fixedTabOpenCalls.map((call) => call.tabId)).toEqual([
        "review",
      ]),
    );
    // The half to show is written to the panel's stored position, so it lands
    // whether that tab is closed, showing GitHub, or open in another window.
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.filter((entry) => entry.method === "setPanelState");
      expect(saved.map((entry) => entry.input)).toContainEqual({
        sidePane: "discussion",
        diffFile: null,
        diffUrl: null,
      });
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("offers no way into a thread for a pull request nobody has reviewed", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: null,
            findings: [],
            hasPendingReview: false,
          }),
        }),
      },
    );
    await slot.findByText("Review this PR");
    expect(slot.queryByText("Review thread")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("explains a finding that a re-run has replaced", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/gone" },
      { rpc: rpc() },
    );
    await slot.findByText("This issue is gone");
    slot.lifecycle.unmount();
  });

  // "Discuss" used to send straight into a fresh thread. It now opens a box:
  // the thread is shared with the whole review, so nothing is said in it
  // until the reviewer has said what they want to ask.
  it("asks for the question before it messages the review thread", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    fireEvent.click(await slot.findByText("Discuss"));
    const box = await slot.findByLabelText("Question about Off by one");
    expect(slot.inspection.rpcCalls.some((entry) => entry.method === "askAboutFinding")).toBe(
      false,
    );

    fireEvent.change(box, { target: { value: "Is line 12 really wrong?" } });
    fireEvent.click(await slot.findByText("Ask the review thread"));
    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find((entry) => entry.method === "askAboutFinding");
      expect(call?.input).toEqual({ findingId: "f1", question: "Is line 12 really wrong?" });
    });
    slot.lifecycle.unmount();
  });

  it("sends on cmd-enter, and closes the box without asking on cancel", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    fireEvent.click(await slot.findByText("Discuss"));
    const box = await slot.findByLabelText("Question about Off by one");

    // Empty: the shortcut must not put a bare prompt in the shared thread.
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => {
      const asks = slot.inspection.rpcCalls.filter((e) => e.method === "askAboutFinding");
      expect(asks.map((entry) => entry.input)).toEqual([{ findingId: "f1", question: "Why?" }]);
    });
    // The box closes itself once the question is on its way.
    await waitFor(() => expect(slot.queryByLabelText("Question about Off by one")).toBeNull());

    fireEvent.click(await slot.findByText("Discuss"));
    await slot.findByLabelText("Question about Off by one");
    fireEvent.click(await slot.findByText("Cancel"));
    await waitFor(() => expect(slot.queryByLabelText("Question about Off by one")).toBeNull());
    expect(slot.inspection.rpcCalls.filter((e) => e.method === "askAboutFinding")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("keeps the question in the box when it could not be delivered", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          askAboutFinding: () => {
            throw new Error("The review thread is gone.");
          },
        }),
      },
    );
    fireEvent.click(await slot.findByText("Discuss"));
    const box = await slot.findByLabelText("Question about Off by one");
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(await slot.findByText("Ask the review thread"));
    // Nothing is lost to a failed send: the box stays open, still holding it.
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((e) => e.method === "askAboutFinding")).toBe(true),
    );
    expect((slot.getByLabelText("Question about Off by one") as HTMLTextAreaElement).value).toBe(
      "Why?",
    );
    slot.lifecycle.unmount();
  });

  it("shows a posted issue as a link rather than an editable draft", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
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

describe("measureBounds", () => {
  // The attach/setBounds schema rejects a negative size, which is exactly what
  // an element scrolled out of the panel measures as.
  it("clamps an element's rectangle into the viewport", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({ left: -40, top: -30, width: 200, height: 100 }) as DOMRect;
    expect(measureBounds(element)).toEqual({ x: 0, y: 0, width: 160, height: 70 });

    element.getBoundingClientRect = () =>
      ({ left: 10, top: 10, width: 100_000, height: 100_000 }) as DOMRect;
    const huge = measureBounds(element);
    expect(huge.x + huge.width).toBe(window.innerWidth);
    expect(huge.y + huge.height).toBe(window.innerHeight);

    element.getBoundingClientRect = () =>
      ({ left: 5_000, top: 5_000, width: 200, height: 100 }) as DOMRect;
    expect(measureBounds(element)).toMatchObject({ width: 0, height: 0 });
  });
});

describe("the side tab's two halves", () => {
  it("opens on GitHub and switches to the discussion, remembering the choice", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await slot.findByText("Why this change exists.");

    clickTab(slot.getByText("Discussion").closest("button") as HTMLElement);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.filter((entry) => entry.method === "setPanelState");
      // Picking a view by hand says nothing about which file the diff should
      // land on, so it leaves that alone.
      expect(saved.map((entry) => entry.input)).toContainEqual({ sidePane: "discussion" });
    });
    // The pull request half is gone, so only one of them is ever mounted.
    expect(slot.queryByText("Why this change exists.")).toBeNull();
    slot.lifecycle.unmount();
  });

  // The click is shown at once and the write follows, so the local override
  // has to stand down once the stored choice agrees with it.
  it("stops overriding the stored choice once it has caught up", async () => {
    const app = await load();
    let sidePane: "github" | "discussion" = "github";
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane,
            diffFile: null,
            diffUrl: null,
          }),
          setPanelState: (input: unknown) => {
            const next = (input as { sidePane?: "github" | "discussion" }).sidePane;
            if (next !== undefined) sidePane = next;
            return { repo: null, filter: null, sidePane, diffFile: null, diffUrl: null };
          },
        }),
      },
    );
    await slot.findByText("Why this change exists.");
    clickTab(slot.getByText("Discussion").closest("button") as HTMLElement);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((e) => e.method === "getReviewThread")).toBe(true),
    );

    // The server now agrees, so the pane follows the stored value from here on.
    await slot.behavior.emitRealtime("code-review-panel-state-changed", {});
    await waitFor(() => expect(slot.queryByText("Why this change exists.")).toBeNull());
    slot.lifecycle.unmount();
  });

  // The tab unmounts on every deselect, so the choice cannot live in the
  // component: it is stored with the rest of the panel's position.
  it("comes back to the half that was last open", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc({ getPanelState: () => ({ repo: null, filter: null, sidePane: "discussion", diffFile: null, diffUrl: null }) }) },
    );
    // The discussion half asks for the thread; the GitHub half never would.
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((e) => e.method === "getReviewThread")).toBe(true),
    );
    expect(slot.inspection.rpcCalls.some((e) => e.method === "getPullRequestView")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("explains the discussion half when no pull request is open", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "" },
      { rpc: rpc({ getPanelState: () => ({ repo: null, filter: null, sidePane: "discussion", diffFile: null, diffUrl: null }) }) },
    );
    await slot.findByText("Open a pull request to see the thread that reviewed it.");
    slot.lifecycle.unmount();
  });

  // Losing the stored choice must not leave the tab permanently blank.
  it("falls back to the pull request when the stored choice cannot be read", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => {
            throw new Error("no panel state");
          },
        }),
      },
    );
    await slot.findByText("Why this change exists.");
    slot.lifecycle.unmount();
  });
});

describe("the diff view", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  // It used to link to GitHub, which left a browser tab behind for every
  // issue whose code you looked at.
  it("opens the plugin's diff on the cited file rather than GitHub", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    fireEvent.click((await slot.findAllByText("diff"))[0]!);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.filter((entry) => entry.method === "setPanelState");
      expect(saved.map((entry) => entry.input)).toContainEqual({
        sidePane: "diff",
        diffFile: "src/a.ts",
        diffUrl: "https://github.com/acme/app/pull/7/files#diff-abc123R10",
      });
    });
    expect(slot.inspection.experimental_fixedTabOpenCalls.map((call) => call.tabId)).toEqual([
      "review",
    ]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("offers no diff for a file the pull request does not change", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    // src/other.ts is supporting context, so there is no diff to show.
    const buttons = await slot.findAllByText("diff");
    expect((buttons[0]?.closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect((buttons.at(-1)?.closest("button") as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("opens the requested file expanded and leaves the rest closed", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane: "diff",
            diffFile: "src/a.ts",
            diffUrl: null,
          }),
          getPullRequestView: () => ({
            ...PR_VIEW,
            snapshot: {
              ...PR_VIEW.snapshot,
              files: [
                { path: "src/a.ts", additions: 3, deletions: 1 },
                { path: "src/b.ts", additions: 1, deletions: 0 },
              ],
            },
            filesWithPatch: ["src/a.ts", "src/b.ts"],
          }),
        }),
      },
    );
    // The requested file loads its patch on sight; the other waits to be asked.
    await waitFor(() => {
      const patches = slot.inspection.rpcCalls.filter(
        (entry) => entry.method === "getPullRequestPatch",
      );
      expect(patches.map((entry) => entry.input)).toEqual([
        { repo: "acme/app", number: 7, file: "src/a.ts" },
      ]);
    });
    slot.lifecycle.unmount();
  });

  // The request is stored panel-wide, so it can name a file from the review
  // you were looking at before this one.
  it("ignores a requested file that is not in this pull request", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane: "diff",
            diffFile: "some/other/review.ts",
            diffUrl: null,
          }),
        }),
      },
    );
    await slot.findByText("1 file changed");
    expect(
      slot.inspection.rpcCalls.some((entry) => entry.method === "getPullRequestPatch"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("explains itself when no pull request is open", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "" },
      {
        rpc: rpc({
          getPanelState: () => ({ repo: null, filter: null, sidePane: "diff", diffFile: null, diffUrl: null }),
        }),
      },
    );
    await slot.findByText("Open a pull request to read its diff here.");
    slot.lifecycle.unmount();
  });

  // A fragment applied while the page loads scrolls to where the target is at
  // that moment, and GitHub's diff keeps growing underneath it — so the anchor
  // goes on after the page has settled, not during the load.
  it("loads the diff first and anchors it once the page has settled", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const anchored = "https://github.com/acme/app/pull/7/files#diff-abc123R10";
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane: "diff",
            diffFile: "src/a.ts",
            diffUrl: anchored,
          }),
        }),
      },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    expect(desktop.of("attach")[0]?.arg).toMatchObject({
      tabId: "code-review:diff:acme/app#7",
      url: "https://github.com/acme/app/pull/7/files",
    });
    expect(desktop.of("navigate")).toEqual([]);

    const settled = {
      tabId: "code-review:diff:acme/app#7",
      url: "https://github.com/acme/app/pull/7/files",
      title: "Files changed",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      errorText: "",
    };
    desktop.pushState({ ...settled, isLoading: true });
    expect(desktop.of("navigate")).toEqual([]);

    desktop.pushState(settled);
    await waitFor(() =>
      expect(desktop.of("navigate").at(-1)?.arg).toEqual({
        tabId: "code-review:diff:acme/app#7",
        url: anchored,
      }),
    );

    // Once only: where the reader goes from here is theirs, not ours to undo.
    desktop.pushState({ ...settled, url: "https://github.com/acme/app/pull/7/commits" });
    expect(desktop.of("navigate")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("opens the whole diff when no location asked for a file", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane: "diff",
            diffFile: null,
            diffUrl: null,
          }),
        }),
      },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    expect(desktop.of("attach")[0]?.arg).toMatchObject({
      url: "https://github.com/acme/app/pull/7/files",
    });
    slot.lifecycle.unmount();
  });

  // GitHub's files page is expensive to load; asking for another file inside
  // the same pull request should move it, not fetch it again.
  it("navigates the view it already has to a newly requested file", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const anchored = (file: string) => ({
      repo: null,
      filter: null,
      sidePane: "diff" as const,
      diffFile: file,
      diffUrl: `https://github.com/acme/app/pull/7/files#${file}`,
    });
    let state = anchored("src/a.ts");
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc({ getPanelState: () => state }) },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));

    state = anchored("src/b.ts");
    await slot.behavior.emitRealtime("code-review-panel-state-changed", {});
    await waitFor(() =>
      expect(desktop.of("navigate").at(-1)?.arg).toEqual({
        tabId: "code-review:diff:acme/app#7",
        url: "https://github.com/acme/app/pull/7/files#src/b.ts",
      }),
    );
    // Still the one view: no reload, and nothing torn down.
    expect(desktop.of("attach")).toHaveLength(1);
    expect(desktop.of("detach")).toEqual([]);
    slot.lifecycle.unmount();
  });

  // The pull request and its diff are two views of one review, so moving
  // between them must not throw either page away.
  it("keeps the pull request's view alive while the diff is on screen", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const tab = fixedTab(app, "review");
    const onPr = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    onPr.lifecycle.unmount();

    const onDiff = renderSlot(
      tab,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({
            repo: null,
            filter: null,
            sidePane: "diff",
            diffFile: null,
            diffUrl: null,
          }),
        }),
      },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(2));
    expect(desktop.of("detach")).toEqual([]);
    onDiff.lifecycle.unmount();
  });

  it("says so when the diff could not be read", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({ repo: null, filter: null, sidePane: "diff", diffFile: null, diffUrl: null }),
          getPullRequestView: () => {
            throw new Error("gh: not found");
          },
        }),
      },
    );
    await slot.findByText("Could not read this diff");
    await slot.findByText("gh: not found");
    slot.lifecycle.unmount();
  });

  it("reaches the diff from a supporting file too, not just the issue's own", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          // Both cited files are in the pull request here, so both offer a diff.
          getFindingCode: () => ({
            ...CODE,
            locations: [
              CODE.locations[0],
              { ...CODE.locations[1], inDiff: true, addedLines: [20], removals: [] },
            ],
          }),
        }),
      },
    );
    const buttons = await slot.findAllByText("diff");
    fireEvent.click(buttons.at(-1)!);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.filter((entry) => entry.method === "setPanelState");
      expect(saved.map((entry) => entry.input)).toContainEqual({
        sidePane: "diff",
        diffFile: "src/other.ts",
        diffUrl: "https://github.com/acme/app/pull/7/files#diff-def456R20",
      });
    });
    slot.lifecycle.unmount();
  });
});

describe("the file browser", () => {
  const onFiles = (overrides: Record<string, unknown> = {}) =>
    rpc({
      getPanelState: () => ({
        repo: null,
        filter: null,
        sidePane: "files",
        diffFile: null,
        diffUrl: null,
      }),
      ...overrides,
    });

  // A reviewer regularly needs a file the change does not touch, and the diff
  // has only the ones it does.
  it("browses the repository at the commit the review read", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: onFiles() },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    // The commit, not the branch: a fork's branch is not under this repo.
    expect(desktop.of("attach")[0]?.arg).toMatchObject({
      tabId: "code-review:files:acme/app#7",
      url: "https://github.com/acme/app/tree/sha7abcdef",
    });
    slot.lifecycle.unmount();
  });

  // It is a third view of the same review, so it must not evict the others.
  it("shares the review's other views rather than replacing them", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const tab = fixedTab(app, "review");
    const onPr = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    onPr.lifecycle.unmount();

    const files = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: onFiles() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(2));
    expect(desktop.of("detach")).toEqual([]);
    files.lifecycle.unmount();
  });

  it("says there is nothing to browse when no commit was recorded", async () => {
    fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: onFiles({
          getPullRequestView: () => ({
            ...PR_VIEW,
            snapshot: { ...PR_VIEW.snapshot, headSha: "" },
          }),
        }),
      },
    );
    await slot.findByText("No commit to browse");
    slot.lifecycle.unmount();
  });

  it("offers a link out where there is no in-app browser to drive", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: onFiles() },
    );
    const link = await slot.findByText("Browse this commit on GitHub");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/tree/sha7abcdef",
    );
    slot.lifecycle.unmount();
  });

  it("explains itself when no pull request is open", async () => {
    const app = await load();
    const slot = renderSlot(fixedTab(app, "review"), { subPath: "" }, { rpc: onFiles() });
    await slot.findByText("Open a pull request to browse the repository at its commit.");
    slot.lifecycle.unmount();
  });

  it("says so when the pull request could not be read", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: onFiles({
          getPullRequestView: () => {
            throw new Error("gh: not found");
          },
        }),
      },
    );
    await slot.findByText("Could not read this pull request");
    slot.lifecycle.unmount();
  });
});

describe("the pull request tab, showing GitHub itself", () => {
  it("attaches a view for the pull request in the route", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    expect(desktop.of("attach")[0]?.arg).toMatchObject({
      tabId: "code-review:acme/app#7",
      url: "https://github.com/acme/app/pull/7",
      visible: true,
    });
    slot.lifecycle.unmount();
  });

  // The tab unmounts on every deselect. Destroying the view there is what
  // made re-selecting it reload the page.
  it("hides the view when the tab is deselected, and keeps its page", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const tab = fixedTab(app, "review");
    const first = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    first.lifecycle.unmount();
    expect(desktop.of("setVisible").at(-1)?.arg).toEqual({
      tabId: "code-review:acme/app#7",
      visible: false,
    });
    expect(desktop.of("detach")).toEqual([]);

    // Selecting it again reuses the same view with no URL, so BB leaves the
    // page — including wherever the reader had browsed to — alone.
    const second = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(2));
    expect(desktop.of("attach")[1]?.arg).toMatchObject({
      tabId: "code-review:acme/app#7",
      url: "",
      visible: true,
    });
    expect(desktop.of("detach")).toEqual([]);
    second.lifecycle.unmount();
  });

  // Keeping a view per pull request ever visited would be a real leak, so the
  // one belonging to the review you left is reclaimed when you open another.
  it("reclaims the previous pull request's view when another needs one", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const tab = fixedTab(app, "review");
    const first = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    first.lifecycle.unmount();

    const second = renderSlot(tab, { subPath: "pr/acme/app/9" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(2));
    expect(desktop.of("attach")[1]?.arg).toMatchObject({
      tabId: "code-review:acme/app#9",
      url: "https://github.com/acme/app/pull/9",
    });
    expect(desktop.of("detach").map((call) => call.arg)).toEqual(["code-review:acme/app#7"]);
    second.lifecycle.unmount();
  });

  // Two panes can show the same pull request at once; one closing must not
  // pull the view out from under the other.
  it("keeps a view while another pane is still showing it", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const tab = fixedTab(app, "review");
    const left = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    const right = renderSlot(tab, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(2));

    left.lifecycle.unmount();
    expect(desktop.of("setVisible")).toEqual([]);
    right.lifecycle.unmount();
    expect(desktop.of("setVisible").at(-1)?.arg).toEqual({
      tabId: "code-review:acme/app#7",
      visible: false,
    });
  });

  // The view is a native overlay in window coordinates, so it only stays over
  // the tab if it is told every time the layout moves.
  it("re-measures when BB says the layout moved", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    const before = desktop.of("setBounds").length;
    // Unchanged bounds are not worth an IPC round trip, so move the box first.
    const slotBox = slot.getByTestId("github-view");
    slotBox.getBoundingClientRect = () =>
      ({ left: 12, top: 34, width: 300, height: 200 }) as DOMRect;
    window.dispatchEvent(new Event("bb:browser-view-bounds-sync"));
    await waitFor(() => expect(desktop.of("setBounds").length).toBeGreaterThan(before));
    expect(desktop.of("setBounds").at(-1)?.arg).toEqual({
      tabId: "code-review:acme/app#7",
      bounds: { x: 12, y: 34, width: 312 - 12, height: 234 - 34 },
    });

    // The event fires for every layout change; most do not move this box, and
    // re-sending the same rectangle is pure IPC churn.
    const settled = desktop.of("setBounds").length;
    window.dispatchEvent(new Event("bb:browser-view-bounds-sync"));
    window.dispatchEvent(new Event("bb:browser-view-bounds-sync"));
    expect(desktop.of("setBounds")).toHaveLength(settled);
    slot.lifecycle.unmount();
  });

  it("drives back, forward and reload on the view it owns", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    // Back and forward stay disabled until the page says there is history.
    expect((slot.getByLabelText("Go back") as HTMLButtonElement).disabled).toBe(true);
    desktop.pushState({
      tabId: "code-review:acme/app#7",
      url: "https://github.com/acme/app/pull/7/files",
      title: "Add a thing by dan",
      isLoading: false,
      canGoBack: true,
      canGoForward: true,
      errorText: "",
    });
    await slot.findByText("Add a thing by dan");

    fireEvent.click(slot.getByLabelText("Go back"));
    fireEvent.click(slot.getByLabelText("Go forward"));
    fireEvent.click(slot.getByLabelText("Reload"));
    expect(desktop.of("goBack")[0]?.arg).toBe("code-review:acme/app#7");
    expect(desktop.of("goForward")[0]?.arg).toBe("code-review:acme/app#7");
    expect(desktop.of("reload")[0]?.arg).toBe("code-review:acme/app#7");

    // "Open externally" follows where the user browsed to, not the PR root.
    fireEvent.click(slot.getByLabelText("Open in an external browser"));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ url: "https://github.com/acme/app/pull/7/files" }),
    );
    slot.lifecycle.unmount();
  });

  it("shows the page's own error rather than a blank box", async () => {
    const desktop = fakeDesktopBrowser();
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await waitFor(() => expect(desktop.of("attach")).toHaveLength(1));
    desktop.pushState({
      tabId: "code-review:acme/app#7",
      url: "https://github.com/acme/app/pull/7",
      title: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      errorText: "ERR_INTERNET_DISCONNECTED",
    });
    await slot.findByText("ERR_INTERNET_DISCONNECTED");
    slot.lifecycle.unmount();
  });

  // The API is undocumented and BB's own declaration marks parts of it
  // optional for version skew, so a missing method must not break the tab.
  it("falls back to the stored pull request when the API is not all there", async () => {
    fakeDesktopBrowser({ setBounds: undefined });
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await slot.findByText("Why this change exists.");
    slot.lifecycle.unmount();
  });
});

describe("the pull request tab", () => {
  it("explains itself when no pull request is open", async () => {
    const app = await load();
    const slot = renderSlot(fixedTab(app, "review"), { subPath: "" }, { rpc: rpc() });
    await slot.findByText("No pull request open");
    slot.lifecycle.unmount();
  });

  // The point of the tab: BB's own Browser tabs are shared across the panel,
  // so a GitHub page opened for one review outlives the review it belonged to.
  it("reads the pull request in the route, not the last one opened", async () => {
    const app = await load();
    const asked: unknown[] = [];
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequestView: (input: unknown) => {
            asked.push(input);
            return PR_VIEW;
          },
        }),
      },
    );
    await slot.findByText("Add a thing");
    await waitFor(() => expect(asked).toEqual([{ repo: "acme/app", number: 7 }]));
    slot.lifecycle.unmount();
  });

  it("shows the description, the conversation, and the changed files", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await slot.findByText("Why this change exists.");
    await slot.findByText("Looks good.");
    await slot.findByText("off by one");
    // An inline review comment says where it is; a conversation one does not.
    await slot.findByText("src/a.ts:11");
    await slot.findByText("1 file changed");
    await slot.findByText("src/a.ts");
    slot.lifecycle.unmount();
  });

  // A whole diff is far more than the reader asked for, and BB's diff viewer
  // is not cheap to mount.
  it("loads a file's patch only when that file is opened", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await slot.findByText("src/a.ts");
    expect(slot.inspection.rpcCalls.some((e) => e.method === "getPullRequestPatch")).toBe(false);

    fireEvent.click(slot.getByText("src/a.ts"));
    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find((e) => e.method === "getPullRequestPatch");
      expect(call?.input).toEqual({ repo: "acme/app", number: 7, file: "src/a.ts" });
    });
    slot.lifecycle.unmount();
  });

  // Re-fetching would move the code out from under findings already written
  // against it, so the server refuses and the tab does not offer it.
  it("says why a file's diff could not be loaded instead of spinning", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequestPatch: () => {
            throw new Error("src/a.ts is not in this pull request's diff.");
          },
        }),
      },
    );
    fireEvent.click(await slot.findByText("src/a.ts"));
    await slot.findByText("src/a.ts is not in this pull request's diff.");
    slot.lifecycle.unmount();
  });

  it("offers no refresh for a reviewed pull request, and says why", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc() },
    );
    await slot.findByText("sha7abc", { exact: false });
    expect(slot.queryByText("Refresh from GitHub")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers a refresh for a pull request that has not been reviewed", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      { rpc: rpc({ getPullRequestView: () => ({ ...PR_VIEW, isReviewedCommit: false }) }) },
    );
    fireEvent.click(await slot.findByText("Refresh from GitHub"));
    await waitFor(() => {
      const calls = slot.inspection.rpcCalls.filter((e) => e.method === "getPullRequestView");
      expect(calls.some((e) => (e.input as { refresh?: boolean }).refresh === true)).toBe(true);
    });
    slot.lifecycle.unmount();
  });

  it("says so when the pull request could not be read", async () => {
    const app = await load();
    const slot = renderSlot(
      fixedTab(app, "review"),
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequestView: () => {
            throw new Error("gh: not found");
          },
        }),
      },
    );
    await slot.findByText("Could not read this pull request");
    await slot.findByText("gh: not found");
    slot.lifecycle.unmount();
  });
});

describe("the discussion tab", () => {
  it("explains itself when no pull request is open", async () => {
    const app = await load();
    const tab = fixedTab(app, "review");
    const slot = renderSlot(tab, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("No pull request open");
    slot.lifecycle.unmount();
  });

  // The tab follows the route, so opening another PR cannot leave the pane
  // showing the thread that reviewed the previous one.
  it("shows the review thread for the pull request in the route", async () => {
    const app = await load();
    const tab = fixedTab(app, "review");
    const asked: unknown[] = [];
    const slot = renderSlot(
      tab,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({ repo: null, filter: null, sidePane: "discussion", diffFile: null, diffUrl: null }),
          getReviewThread: (input: unknown) => {
            asked.push(input);
            return { threadId: "thr_1" };
          },
        }),
      },
    );
    await waitFor(() => expect(asked).toEqual([{ repo: "acme/app", number: 7 }]));
    slot.lifecycle.unmount();
  });

  it("says so when the pull request has not been reviewed yet", async () => {
    const app = await load();
    const tab = fixedTab(app, "review");
    const slot = renderSlot(
      tab,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPanelState: () => ({ repo: null, filter: null, sidePane: "discussion", diffFile: null, diffUrl: null }),
          getReviewThread: () => ({ threadId: null }),
        }),
      },
    );
    await slot.findByText("No review thread yet");
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
            sidePane: null,
            diffFile: null,
            diffUrl: null,
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
      { rpc: rpc({ getPanelState: () => ({ repo: "acme/removed", filter: null, sidePane: null, diffFile: null, diffUrl: null }) }) },
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
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
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

  it("keeps a real href so the link can be copied or opened in a new tab", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("leaves a modifier-click to the browser", async () => {
    // Cmd-click means "new tab"; swallowing it would be worse than useless.
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
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
          getPanelState: () => ({ repo: "acme/app", filter: { kind: "mine" }, sidePane: null, diffFile: null, diffUrl: null }),
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
    const app = await load();
    return renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
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
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
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
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
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
    const app = await load();
    return renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
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
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7/f/f1" }, { rpc: rpc() });
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
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7/f/f1" }, { rpc: rpc() });
    const code = await slot.findByText("const x = 1;");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect(isBefore(code, box)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("puts the other referenced code below the comment", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7/f/f1" }, { rpc: rpc() });
    const box = await slot.findByLabelText("Comment for Off by one");
    const other = await slot.findByText("src/other.ts:20");
    expect(isBefore(box, other)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("separates the attached code from the supporting code", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7/f/f1" }, { rpc: rpc() });
    await slot.findByText("Code the comment attaches to");
    await slot.findByText("Other code this issue points at (1)");
    slot.lifecycle.unmount();
  });

  it("says the code is what the issue is about when nothing can be attached", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
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
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
      { rpc: rpc({ getFindingCode: () => ({ ...CODE, locations: [CODE.locations[0]] }) }) },
    );
    await slot.findByText("const x = 1;");
    expect(slot.queryByText(/Other code this issue points at/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("still shows the comment when the code cannot be loaded", async () => {
    // Losing the snippet must not cost the reviewer the comment.
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/f1" },
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
      { rpc: rpc({ getPanelState: () => ({ repo: "acme/app", filter: { kind: "authored" }, sidePane: null, diffFile: null, diffUrl: null }) }) },
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
