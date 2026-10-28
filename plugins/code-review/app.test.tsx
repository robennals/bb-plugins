// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it, vi } from "vitest";
import type { FindingDto, QuestionDto, PullRequestDto, ReviewDto } from "./server";

/**
 * BB rebuilds `useBbNavigate()`'s object whenever anything it closes over
 * changes — the thread panel's opener, the route — so a slot re-renders with
 * a new one every time the user switches tab. The harness hands out one stable
 * object; a fresh copy per render keeps effects honest about that.
 */
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    useBbNavigate: () => ({ ...actual.useBbNavigate() }),
  };
});

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
  reviewThreadId: "thr_1",
  reviewThreadArchived: false,
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
  questions: [],
  proposedComment: null,
  revision: null,
  removedReason: null,
};

const QUESTION: QuestionDto = {
  id: "q1",
  question: "Is line 12 really wrong?",
  status: "answered",
  answer: "Yes — the loop reads **one past** the end.",
  updatedFields: [],
  askedAt: "2026-01-02T00:00:00Z",
  answeredAt: "2026-01-02T00:01:00Z",
};

/** The review with FINDING replaced by `finding`. */
const withFinding = (finding: FindingDto) => ({
  getPullRequest: () => ({
    pullRequest: PR,
    review: REVIEW,
    findings: [finding],
    hasPendingReview: false,
  }),
});

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
/** Radix tabs activate on mousedown, not click. */
function clickTab(element: HTMLElement): void {
  fireEvent.mouseDown(element);
  fireEvent.focus(element);
  fireEvent.click(element);
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
    askAboutFinding: () => ({ threadId: REVIEW.threadId }),
    startReview: () => ({ review: REVIEW }),
    openReview: () => ({ threadId: "thr_1", review: REVIEW }),
    getReviewForThread: () => ({ repo: "acme/app", number: 7 }),
    getPanelState: () => ({ repo: null, filter: null, sidePane: null, diffFile: null, diffUrl: null }),
    setPanelState: () => ({ repo: null, filter: null, sidePane: null, diffFile: null, diffUrl: null }),
    getReviewModel: () => null,
    setReviewModel: (model: unknown) => model,
    ...overrides,
  };
}

/** Per-test replacements for the rpc factory's default handlers. */
type RpcOverrides = Record<string, unknown>;

/** The review tab, as openReview opens it: params naming the review. */
function reviewTab(app: Awaited<ReturnType<typeof load>>, overrides: RpcOverrides = {}) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: null },
    { rpc: rpc(overrides) },
  );
}

/** The review tab, with the caller's own renderSlot options. */
function reviewTabWith(app: Awaited<ReturnType<typeof load>>, options: object) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: null },
    options as Parameters<typeof renderSlot>[2],
  );
}

/**
 * Click from the issue list into the one issue, the way a reader does. It
 * waits for the detail view's own back button rather than the comment box,
 * because a posted finding shows a link there instead of an editable draft.
 */
async function intoIssue(slot: ReturnType<typeof renderSlot>) {
  fireEvent.click(await slot.findByText("Off by one"));
  await slot.findByText("All issues");
  return slot;
}

/** The review tab with its one issue opened. */
async function openedIssue(overrides: RpcOverrides = {}) {
  const app = await load();
  return intoIssue(reviewTab(app, overrides));
}

describe("registrations", () => {
  it("registers a nav panel with no fixed tabs, the review tab, and its header", async () => {
    // loadPluginApp applies the host's own validation, so this catches slot-id
    // and path mistakes that would break the real panel.
    const app = await load();
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel?.id).toBe("code-review");
    expect(panel?.path).toBe("code-review");
    // The panel is the home screen now; issues live in the thread's own tab.
    expect(panel?.fixedTabs ?? []).toHaveLength(0);
    // The action id must match the actionId reviewTabFor writes onto a thread.
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["review"]);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["review"]);
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
  it("shows each issue as a title, a gist, and a location — not the full detail", async () => {
    const app = await load();
    const slot = reviewTab(app);
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
  it("falls back to the problem when the agent wrote no summary", async () => {
    const app = await load();
    const slot = reviewTabWith(app, {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, summary: "", gist: "It runs one past the end." }],
      hasPendingReview: false,
          }),
        }),
      });
    await slot.findByText("It runs one past the end.");
    slot.lifecycle.unmount();
  });

  it("explains a review that has not run yet", async () => {
    const app = await load();
    const slot = reviewTabWith(app, {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: { ...PR, reviewStatus: "none", openFindings: 0 },
            review: null,
            findings: [],
            hasPendingReview: false,
          }),
        }),
      });
    await slot.findByText("No review yet");
    await slot.findByText("Review this PR");
    slot.lifecycle.unmount();
  });

  it("surfaces a failed review's error", async () => {
    const app = await load();
    const slot = reviewTabWith(app, {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: { ...REVIEW, status: "failed", error: "the thread gave up" },
            findings: [],
            hasPendingReview: false,
          }),
        }),
      });
    await slot.findByText("the thread gave up");
    slot.lifecycle.unmount();
  });
});

describe("an issue and its code", () => {
  // The write-up above the comment is gone: the comment is the finding's prose,
  // and everything else the reader needs is code shown beside it. The suggested
  // fix is the exception — it is for the reviewer, not the author.
  it("leads with the comment, with no write-up above it beyond the fix", async () => {
    const app = await load();
    const slot = await openedIssue();
    await slot.findByText("Off by one");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect((box as HTMLTextAreaElement).value).toBe("Please fix the bound here.");
    expect(slot.queryByText("Background")).toBeNull();
    expect(slot.queryByText("Problem")).toBeNull();
    await slot.findByText("Suggested fix");
    slot.lifecycle.unmount();
  });

  it("leaves the section out when the agent offered no fix", async () => {
    const slot = await openedIssue({
      getPullRequest: () => ({
        pullRequest: PR,
        review: REVIEW,
        findings: [{ ...FINDING, suggestedFix: "" }],
        hasPendingReview: false,
      }),
    });
    await slot.findByLabelText("Comment for Off by one");
    expect(slot.queryByText("Suggested fix")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("asks for the code with a small amount of context by default", async () => {
    const app = await load();
    const slot = await openedIssue();
    await slot.findByText("const x = 1;");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getFindingCode");
    expect(call?.input).toEqual({ findingId: "f1", context: 3 });
    slot.lifecycle.unmount();
  });

  it("numbers snippet lines by their real position in the file", async () => {
    // The whole value of this view is that the numbers match the finding.
    const app = await load();
    const slot = await openedIssue();
    await slot.findByText("const x = 1;");
    for (const lineNumber of ["9", "10", "11", "12", "13"]) {
      await slot.findByText(lineNumber);
    }
    expect(slot.queryByText("1")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stacks every file the issue points at, with the reference's note", async () => {
    const app = await load();
    const slot = await openedIssue();
    await slot.findByText("src/a.ts:10-12");
    await slot.findByText("src/other.ts:20");
    await slot.findByText("the pattern this should match");
    await slot.findByText("retry(() => run());");
    slot.lifecycle.unmount();
  });

  it("links each file to its place in the PR diff on GitHub", async () => {
    const app = await load();
    const slot = await openedIssue();
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
    const slot = await openedIssue();
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
    const slot = await openedIssue();
    // src/a.ts: one line added, one deleted, in the window on show.
    await slot.findByText("+1 −1 here");
    // src/other.ts is supporting context the PR never touches.
    await slot.findByText("Not changed by this PR");
    slot.lifecycle.unmount();
  });

  it("distinguishes a changed file from changes in the lines on show", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          getFindingCode: () => ({
            ...CODE,
            locations: [{ ...CODE.locations[0], inDiff: true, addedLines: [], removals: [] }],
          }),
        }),
      }));
    await slot.findByText("Changed elsewhere in this file");
    slot.lifecycle.unmount();
  });

  it("says why a file could not be shown instead of rendering nothing", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          getFindingCode: () => ({
            prUrl: CODE.prUrl,
            locations: [
              { ...CODE.locations[0], lines: [], error: "404 Not Found at c5b7b2a7bc42" },
            ],
          }),
        }),
      }));
    await slot.findByText("404 Not Found at c5b7b2a7bc42");
    slot.lifecycle.unmount();
  });

  // The old button navigated to the thread, which took the review off screen.
  it("explains a finding that a re-run has replaced", async () => {
    // The issue is in the list you clicked and gone by the time the detail
    // asks for it again — which is exactly what a re-run does underneath you.
    const app = await load();
    let calls = 0;
    const slot = reviewTabWith(app, {
      rpc: rpc({
        getPullRequest: () => {
          calls += 1;
          return {
            pullRequest: PR,
            review: REVIEW,
            findings: calls === 1 ? [FINDING] : [],
            hasPendingReview: false,
          };
        },
      }),
    });
    fireEvent.click(await slot.findByText("Off by one"));
    await slot.findByText("This issue is gone");
    slot.lifecycle.unmount();
  });

  // "Discuss" used to send straight into a fresh thread. It now opens a box:
  // the thread is shared with the whole review, so nothing is said in it
  // until the reviewer has said what they want to ask.
  it("asks for the question before it messages the review thread", async () => {
    const app = await load();
    const slot = await openedIssue();
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
    const slot = await openedIssue();
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

  it("shows the answer on the issue, and what it changed", async () => {
    const slot = await openedIssue(
      withFinding({
        ...FINDING,
        questions: [{ ...QUESTION, updatedFields: ["summary", "suggestedComment"] }],
      }),
    );
    await slot.findByText("Is line 12 really wrong?");
    await slot.findByText(/one past/);
    await slot.findByText("Updated this issue's summary and comment.");
    slot.lifecycle.unmount();
  });

  it("says when an answer is still coming", async () => {
    const slot = await openedIssue(
      withFinding({ ...FINDING, questions: [{ ...QUESTION, status: "pending", answer: null }] }),
    );
    await slot.findByText("Waiting for the review thread to answer…");
    slot.lifecycle.unmount();
  });

  it("marks an issue whose answer is still coming in the list", async () => {
    const app = await load();
    const slot = reviewTab(
      app,
      withFinding({ ...FINDING, questions: [{ ...QUESTION, status: "pending", answer: null }] }),
    );
    await slot.findByText("answering");
    slot.lifecycle.unmount();
  });

  it("shows the thread's reply when it answered in the chat instead", async () => {
    const slot = await openedIssue(
      withFinding({
        ...FINDING,
        questions: [{ ...QUESTION, status: "unanswered", answer: "It is fine." }],
      }),
    );
    await slot.findByText(/replied in the chat without putting an answer here/);
    await slot.findByText("It is fine.");
    slot.lifecycle.unmount();
  });

  it("offers a revised comment the reviewer's edit kept out", async () => {
    const slot = await openedIssue({
      ...withFinding({ ...FINDING, draftComment: "My wording.", proposedComment: "Better wording." }),
      resolveProposedComment: () => ({ finding: FINDING }),
    });
    await slot.findByText("Better wording.");
    fireEvent.click(await slot.findByText("Use this comment"));
    fireEvent.click(await slot.findByText("Keep mine"));
    await waitFor(() => {
      const calls = slot.inspection.rpcCalls.filter((e) => e.method === "resolveProposedComment");
      expect(calls.map((call) => call.input)).toEqual([
        { findingId: "f1", use: true },
        { findingId: "f1", use: false },
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("says what the review thread revised, and why", async () => {
    const slot = await openedIssue(
      withFinding({
        ...FINDING,
        revision: {
          at: new Date().toISOString(),
          note: "only the last iteration is off",
          fields: ["severity", "location"],
        },
      }),
    );
    await slot.findByText(
      "The review thread revised this issue (severity and location) just now: only the last iteration is off",
    );
    slot.lifecycle.unmount();
  });

  it("says why the review thread withdrew an issue", async () => {
    const slot = await openedIssue(
      withFinding({ ...FINDING, state: "dismissed", removedReason: "the caller already checks it" }),
    );
    await slot.findByText(/withdrew this issue: the caller already checks it/);
    await slot.findByText("Restore");
    slot.lifecycle.unmount();
  });

  // An answer can rewrite the comment while the reviewer is looking at it.
  it("follows a rewritten comment, but never over an unsaved edit", async () => {
    let suggestedComment = FINDING.suggestedComment;
    const slot = await openedIssue({
      getPullRequest: () => ({
        pullRequest: PR,
        review: REVIEW,
        findings: [{ ...FINDING, suggestedComment }],
        hasPendingReview: false,
      }),
    });
    const box = (await slot.findByLabelText("Comment for Off by one")) as HTMLTextAreaElement;
    suggestedComment = "Rewritten by an answer.";
    await slot.behavior.emitRealtime("code-review-changed", {});
    await waitFor(() => expect(box.value).toBe("Rewritten by an answer."));

    fireEvent.change(box, { target: { value: "Typing…" } });
    suggestedComment = "Rewritten again.";
    await slot.behavior.emitRealtime("code-review-changed", {});
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((e) => e.method === "getPullRequest").length,
      ).toBeGreaterThanOrEqual(3);
    });
    expect(box.value).toBe("Typing…");
    slot.lifecycle.unmount();
  });

  it("keeps the question in the box when it could not be delivered", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          askAboutFinding: () => {
            throw new Error("The review thread is gone.");
          },
        }),
      }));
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
    const slot = await intoIssue(reviewTabWith(app, {
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
      }));
    await slot.findByText("View on GitHub");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
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
    const slot = await intoIssue(reviewTabWith(app, { rpc: rpc(), openUrl: () => true }));
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
    const slot = await openedIssue();
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("leaves a modifier-click to the browser", async () => {
    // Cmd-click means "new tab"; swallowing it would be worse than useless.
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, { rpc: rpc(), openUrl: () => true }));
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
    return await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, ...overrides }],
            hasPendingReview: false,
          }),
        }),
      }));
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
    const slot = await intoIssue(reviewTabWith(app, {
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
      }));
    await slot.findByText("Draft comment");
    await slot.findByText(/Submit that review on GitHub to publish it/);
    slot.lifecycle.unmount();
  });

  it("still says posted for an ordinary published comment", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
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
      }));
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
    return await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, ...overrides }],
            hasPendingReview: false,
          }),
        }),
      }));
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
    const slot = await openedIssue();
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
    const slot = await openedIssue();
    const code = await slot.findByText("const x = 1;");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect(isBefore(code, box)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("puts the other referenced code below the comment", async () => {
    const app = await load();
    const slot = await openedIssue();
    const box = await slot.findByLabelText("Comment for Off by one");
    const other = await slot.findByText("src/other.ts:20");
    expect(isBefore(box, other)).toBe(true);
    slot.lifecycle.unmount();
  });

  it("separates the attached code from the supporting code", async () => {
    const app = await load();
    const slot = await openedIssue();
    await slot.findByText("Code the comment attaches to");
    await slot.findByText("Other code this issue points at (1)");
    slot.lifecycle.unmount();
  });

  it("says the code is what the issue is about when nothing can be attached", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
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
      }));
    await slot.findByText("Code this issue is about");
    expect(slot.queryByText("Code the comment attaches to")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("omits the supporting section when the issue cites one place", async () => {
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, { rpc: rpc({ getFindingCode: () => ({ ...CODE, locations: [CODE.locations[0]] }) }) }));
    await slot.findByText("const x = 1;");
    expect(slot.queryByText(/Other code this issue points at/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("still shows the comment when the code cannot be loaded", async () => {
    // Losing the snippet must not cost the reviewer the comment.
    const app = await load();
    const slot = await intoIssue(reviewTabWith(app, {
        rpc: rpc({
          getFindingCode: () => {
            throw new Error("boom");
          },
        }),
      }));
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

describe("the review tab", () => {
  it("shows the issues for the review its params name", async () => {
    const app = await load();
    const slot = reviewTab(app);
    await slot.findByText("Off by one");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getPullRequest");
    expect(call?.input).toEqual({ repo: "acme/app", number: 7 });
    slot.lifecycle.unmount();
  });

  it("walks into an issue and back out again", async () => {
    const slot = await openedIssue();
    await slot.findByLabelText("Comment for Off by one");
    fireEvent.click(await slot.findByText("All issues"));
    await slot.findByText("The loop runs one past the end of the buffer.");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows the suggested fix, which is the part worth keeping", async () => {
    const slot = await openedIssue();
    await slot.findByText("Use < instead of <=.");
    slot.lifecycle.unmount();
  });

  it("works out which review it is from the thread it is in", async () => {
    const app = await load();
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      { rpc: rpc() },
    );
    await slot.findByText("Off by one");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getReviewForThread");
    expect(call?.input).toEqual({ threadId: "thr_1" });
    slot.lifecycle.unmount();
  });

  it("asks the thread even when a tab saved by an older version names a PR", async () => {
    // Older versions put the PR in the tab's params. The thread gives the same
    // answer, so the params are not trusted for it.
    const app = await load();
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: { repo: "acme/other", number: 99 } },
      { rpc: rpc() },
    );
    await slot.findByText("Off by one");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getReviewForThread");
    expect(call?.input).toEqual({ threadId: "thr_1" });
    slot.lifecycle.unmount();
  });

  it("says so when the thread is not a code review", async () => {
    const app = await load();
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_other", params: null },
      { rpc: rpc({ getReviewForThread: () => null }) },
    );
    await slot.findByText("Not a code review");
    slot.lifecycle.unmount();
  });

  it("offers a re-run, and no way back to a thread you are already in", async () => {
    const app = await load();
    const slot = reviewTab(app);
    await slot.findByText("Re-run review");
    expect(slot.queryByText("Review thread")).toBeNull();
    expect(slot.queryByText("All pull requests")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("starting and opening a review from the home screen", () => {
  const home = (app: Awaited<ReturnType<typeof load>>, overrides: RpcOverrides = {}) =>
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc(overrides) });

  it("never starts a review just because the row was clicked", async () => {
    // Starting a review spends an agent run, so it takes a deliberate press.
    const app = await load();
    const slot = home(app);
    fireEvent.click(await slot.findByText("Add a thing"));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((entry) => entry.method === "listPullRequests")).toBe(
        true,
      );
    });
    expect(
      slot.inspection.rpcCalls.some(
        (entry) => entry.method === "startReview" || entry.method === "openReview",
      ),
    ).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("starts a review without leaving the list, and offers it from the row", async () => {
    const app = await load();
    // The server records the review and announces it, so every later list has it.
    let pullRequest = { ...PR, reviewStatus: "none", openFindings: 0 };
    const slot = home(app, {
      listPullRequests: () => ({ pullRequests: [pullRequest] }),
      startReview: () => {
        pullRequest = { ...PR, reviewStatus: "running", openFindings: 0 };
        return { review: REVIEW };
      },
    });
    fireEvent.click(await slot.findByText("Start review"));
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.find((entry) => entry.method === "startReview")?.input,
      ).toEqual({ repo: "acme/app", number: 7 });
    });
    // No second press, and so no second agent run, until the list catches up.
    expect((await slot.findByText("Starting…")).closest("button")).toHaveProperty("disabled", true);

    await slot.behavior.emitRealtime("code-review-changed", { at: "2026-01-02T00:00:00Z" });
    const openReview = await slot.findByText("Open review");
    expect(slot.inspection.navigateCalls).toEqual([]);

    // Going to the review is still one click away.
    fireEvent.click(openReview);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ threadId: "thr_1" }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("offers Start review again when the review could not be started", async () => {
    const app = await load();
    const slot = home(app, {
      listPullRequests: () => ({
        pullRequests: [{ ...PR, reviewStatus: "none", openFindings: 0 }],
      }),
      startReview: () => {
        throw new Error("GitHub is not reachable");
      },
    });
    fireEvent.click(await slot.findByText("Start review"));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((entry) => entry.method === "startReview")).toBe(true);
    });
    await waitFor(() => {
      expect(slot.getByText("Start review").closest("button")).toHaveProperty("disabled", false);
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("offers Open review for a PR that has one, and starts nothing", async () => {
    const app = await load();
    const slot = home(app);
    fireEvent.click(await slot.findByText("Open review"));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.find((entry) => entry.method === "openReview")?.input).toEqual(
        { repo: "acme/app", number: 7 },
      );
    });
    expect(slot.inspection.rpcCalls.some((entry) => entry.method === "startReview")).toBe(false);
    slot.lifecycle.unmount();
  });

  // Unarchiving is broken in BB, so an archived thread is somewhere you cannot
  // work: the row has to offer a new review, and keep the old thread readable.
  it("offers Start review, plus a link to the thread, when the review's thread is archived", async () => {
    const app = await load();
    const slot = home(app, {
      listPullRequests: () => ({
        pullRequests: [{ ...PR, reviewThreadId: "thr_old", reviewThreadArchived: true }],
      }),
    });
    await slot.findByText("Start review");
    expect(slot.queryByText("Open review")).toBeNull();

    fireEvent.click(await slot.findByText("Archived thread"));
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ threadId: "thr_old" }),
      );
    });
    // Reading the old thread must not spend an agent run or reopen the review.
    expect(
      slot.inspection.rpcCalls.some(
        (entry) => entry.method === "startReview" || entry.method === "openReview",
      ),
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("offers no archived-thread link for a live review", async () => {
    const app = await load();
    const slot = home(app);
    await slot.findByText("Open review");
    expect(slot.queryByText("Archived thread")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stays on the list when the review cannot be opened", async () => {
    const app = await load();
    const slot = home(app, {
      openReview: () => {
        throw new Error("no review thread to open");
      },
    });
    fireEvent.click(await slot.findByText("Open review"));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((entry) => entry.method === "openReview")).toBe(true);
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("renders the list even for a link from the old routed panel", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    // No route to the issue list any more: a stale deep link lands at home.
    expect(slot.queryByText("Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("choosing the review model", () => {
  const OPUS = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };

  it("shows the model reviews run with, beside the PR list", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ getReviewModel: () => OPUS }) },
    );
    expect(await slot.findByLabelText("Model")).toHaveProperty("value", "claude-opus-5-5");
    // The default shown is the one for the repo on screen.
    await waitFor(() => {
      const asked = slot.inspection.rpcCalls.filter((entry) => entry.method === "getReviewModel");
      expect(asked.at(-1)?.input).toEqual({ repo: "acme/app" });
    });
    slot.lifecycle.unmount();
  });

  it("saves a new choice", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ getReviewModel: () => OPUS }) },
    );
    // The test picker drops an unapplied edit when its value is refetched, as
    // it is once the saved repo arrives; wait for the list that follows it.
    await slot.findByText("Add a thing");
    await waitFor(() => {
      const asked = slot.inspection.rpcCalls.filter((entry) => entry.method === "getReviewModel");
      expect(asked.at(-1)?.input).toEqual({ repo: "acme/app" });
    });
    fireEvent.change(await slot.findByLabelText("Model"), { target: { value: "gpt-6-astra" } });
    fireEvent.click(slot.getByText("Apply execution selection"));
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.find((entry) => entry.method === "setReviewModel");
      expect(saved?.input).toEqual({ ...OPUS, model: "gpt-6-astra" });
    });
    slot.lifecycle.unmount();
  });

  it("stays out of the way when there is no model to show", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    expect(slot.queryByLabelText("Model")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the review tab opening itself", () => {
  /** The header slot BB mounts inside a thread. */
  const header = (
    app: Awaited<ReturnType<typeof load>>,
    threadId: string,
    overrides: RpcOverrides = {},
  ) =>
    renderSlot(
      app.threadHeaderActions[0]!,
      { threadId, projectId: "proj_1", isCompactViewport: false },
      { rpc: rpc(overrides), openThreadPanel: () => true },
    );

  const opensOf = (slot: ReturnType<typeof header>) =>
    slot.inspection.navigateCalls.filter((call) => call.method === "openThreadPanel");

  /** Re-render the header twice, as switching tabs does in BB. */
  const rerenderTwice = async (slot: ReturnType<typeof header>) => {
    await slot.behavior.emitRealtime("code-review-changed", {});
    await slot.behavior.emitRealtime("code-review-changed", {});
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "getReviewForThread"),
      ).toHaveLength(3);
    });
  };

  /** The review tab itself on screen in `threadId`'s side panel. */
  const showTab = (app: Awaited<ReturnType<typeof load>>, threadId: string) =>
    renderSlot(app.threadPanelActions[0]!, { threadId, params: null }, { rpc: rpc() });

  // The tab remembers being shown for the rest of the session, so each test
  // uses its own thread.

  it("opens the review tab when a review thread opens", async () => {
    const app = await load();
    const slot = header(app, "thr_opens");
    await waitFor(() => {
      expect(opensOf(slot)[0]).toEqual(
        // No params, so BB matches the tab the server wrote.
        expect.objectContaining({ options: { actionId: "review" } }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("keeps asking until the tab is on screen, then stops", async () => {
    const app = await load();
    // BB says yes before the thread's panel state has loaded, then drops the
    // open, so a yes alone must not stop the asking.
    const slot = header(app, "thr_retries");
    await waitFor(() => expect(opensOf(slot)).toHaveLength(1));
    await rerenderTwice(slot);
    expect(opensOf(slot)).toHaveLength(3);

    const tab = showTab(app, "thr_retries");
    await waitFor(() => {
      expect(tab.inspection.rpcCalls.some((call) => call.method === "getReviewForThread")).toBe(
        true,
      );
    });
    // Re-renders, as a tab switch causes in BB, must not drag the user back.
    await slot.behavior.emitRealtime("code-review-changed", {});
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "getReviewForThread"),
      ).toHaveLength(4);
    });
    expect(opensOf(slot)).toHaveLength(3);
    tab.lifecycle.unmount();
    slot.lifecycle.unmount();
  });

  it("does not open the tab again on a later visit", async () => {
    const app = await load();
    const tab = showTab(app, "thr_seen");
    await waitFor(() => {
      expect(tab.inspection.rpcCalls.some((call) => call.method === "getReviewForThread")).toBe(
        true,
      );
    });
    tab.lifecycle.unmount();

    const slot = header(app, "thr_seen");
    await rerenderTwice(slot);
    expect(opensOf(slot)).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("does not open a tab in a thread that is not a review", async () => {
    const app = await load();
    const slot = header(app, "thr_plain", { getReviewForThread: () => null });
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((entry) => entry.method === "getReviewForThread")).toBe(
        true,
      );
    });
    expect(opensOf(slot)).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("offers a way back to the tab on a review thread", async () => {
    const app = await load();
    const slot = header(app, "thr_1");
    fireEvent.click(await slot.findByText("Code review"));
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "openThreadPanel" }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("renders nothing on a thread that is not a review", async () => {
    const app = await load();
    const slot = header(app, "thr_plain", { getReviewForThread: () => null });
    await waitFor(() => {
      expect(slot.inspection.rpcCalls.some((entry) => entry.method === "getReviewForThread")).toBe(
        true,
      );
    });
    expect(slot.queryByText("Code review")).toBeNull();
    slot.lifecycle.unmount();
  });
});
