# Code Review Tab Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Code Review panel a home screen, and give each review its own tab in its own review thread.

**Architecture:** The nav panel keeps only the PR list. A new `threadPanelAction` renders one review's issues inside its review thread's right-hand panel. A new `openReview` RPC ensures the review and its thread exist, writes the tab onto that thread with `bb.sdk.threads.tabs.update`, and hands the thread id back for `navigate.toThread`. Discuss stops spawning a per-finding thread and sends into the review thread instead.

**Tech Stack:** TypeScript, BB plugin SDK 0.4.21 (`@get-bb/plugin-sdk`, `/app`, `/testing`, `/testing/app`), React 19, Zod 4, vitest + Testing Library + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-09-code-review-tab-model-design.md`

## Global Constraints

- **Work in `plugins/code-review/`.** All paths below are relative to it.
- **The install is a path install** at `path:/Users/robennals/bb-repos/bb-plugins/plugins/code-review`, so the running plugin is this checkout. It keeps running the old code until `bb plugin reload code-review`.
- **`bb.storage.migrate` is append-only by statement index.** Never edit or reorder a shipped statement. The `findings.discussion_thread_id` column stays; it just stops being read and written.
- **Pure logic goes in `review-core.ts`** and is unit-tested without a server. `server.ts` is registrations and plumbing; `app.tsx` is the panel.
- **Style: host token classes only** (`bg-card`, `text-muted-foreground`, `border-border`, `text-destructive`). No custom `@theme` colors, no literal `oklch(...)`.
- **Every task ends green:** `npm test` and `npm run typecheck` both pass before the commit.
- **Commit messages:** imperative subject, no `feat:`/`fix:` prefixes — match the repo's existing log (`Add persistent PR list filters`, `Release pr-manager 0.1.1`).

---

### Task 1: `reviewTabFor` — the tab object, as pure data

The tab written onto a thread is plain JSON. Building it is pure, so it belongs in `review-core.ts` where it can be tested without a server or a fake host.

**Files:**
- Modify: `review-core.ts` (append a new exported function near the other exported builders)
- Test: `review-core.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface ReviewPanelTab {
    id: string;
    kind: "plugin-panel";
    pluginId: string;
    actionId: string;
    title: string;
    paramsJson: string;
  }
  export function reviewTabFor(args: {
    pluginId: string;
    repo: string;
    number: number;
  }): ReviewPanelTab;
  ```
  Task 2 calls `reviewTabFor` and compares candidate tabs by `id`.

- [ ] **Step 1: Write the failing test**

Append to `review-core.test.ts`:

```ts
describe("reviewTabFor", () => {
  it("builds a plugin-panel tab BB's own tab schema accepts", () => {
    const tab = reviewTabFor({ pluginId: "code-review", repo: "acme/app", number: 7 });
    expect(tab).toEqual({
      id: "code-review-review-acme-app-7",
      kind: "plugin-panel",
      pluginId: "code-review",
      actionId: "review",
      title: "Code review",
      paramsJson: JSON.stringify({ repo: "acme/app", number: 7 }),
    });
  });

  it("gives one review one stable id, so a repeat install is recognisable", () => {
    const first = reviewTabFor({ pluginId: "code-review", repo: "acme/app", number: 7 });
    const again = reviewTabFor({ pluginId: "code-review", repo: "acme/app", number: 7 });
    expect(again.id).toBe(first.id);
  });

  it("gives two reviews different ids, so they are two tabs", () => {
    const seven = reviewTabFor({ pluginId: "code-review", repo: "acme/app", number: 7 });
    const eight = reviewTabFor({ pluginId: "code-review", repo: "acme/app", number: 8 });
    const other = reviewTabFor({ pluginId: "code-review", repo: "acme/other", number: 7 });
    expect(new Set([seven.id, eight.id, other.id]).size).toBe(3);
  });

  it("keeps the id safe for a repo whose name has odd characters", () => {
    const tab = reviewTabFor({ pluginId: "code-review", repo: "Acme.Corp/my_app", number: 12 });
    expect(tab.id).toBe("code-review-review-acme-corp-my-app-12");
    // The params keep the real repo; only the id is slugged.
    expect(JSON.parse(tab.paramsJson)).toEqual({ repo: "Acme.Corp/my_app", number: 12 });
  });
});
```

Add `reviewTabFor` to the existing `import { ... } from "./review-core"` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run review-core.test.ts -t reviewTabFor`
Expected: FAIL — `reviewTabFor is not a function` / TS error that it is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `review-core.ts`:

```ts
/** The action id of the review tab, shared by the registration and the tab. */
export const REVIEW_TAB_ACTION_ID = "review";

/** A `plugin-panel` entry in a thread's tab list, as BB's tab schema wants it. */
export interface ReviewPanelTab {
  id: string;
  kind: "plugin-panel";
  pluginId: string;
  actionId: string;
  title: string;
  paramsJson: string;
}

/** Lowercase, dash-separated, safe to embed in a tab id. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The review tab for one pull request. The id is derived rather than random so
 * a second `openReview` for the same PR recognises the tab it already wrote,
 * even if the params comparison changes shape later.
 */
export function reviewTabFor(args: {
  pluginId: string;
  repo: string;
  number: number;
}): ReviewPanelTab {
  return {
    id: `${args.pluginId}-review-${slug(args.repo)}-${args.number}`,
    kind: "plugin-panel",
    pluginId: args.pluginId,
    actionId: REVIEW_TAB_ACTION_ID,
    title: "Code review",
    paramsJson: JSON.stringify({ repo: args.repo, number: args.number }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run review-core.test.ts -t reviewTabFor`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS — nothing else consumes `reviewTabFor` yet.

- [ ] **Step 6: Commit**

```bash
git add plugins/code-review/review-core.ts plugins/code-review/review-core.test.ts
git commit -m "Add reviewTabFor, the review tab as pure data"
```

---

### Task 2: `openReview` — ensure the review, the thread, and the tab

**Files:**
- Modify: `server.ts` — the RPC contract (near `startReview`, around line 240), the handler block (around line 1752), and a new `ensureReviewTab` helper beside `startReview`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `reviewTabFor`, `REVIEW_TAB_ACTION_ID` from Task 1; the existing private `startReview(repo, number, skillOverride?)`, `getReview(reviewId)`, `getReviewByThread(threadId)`, `reviewIdFor(repo, number)`, `toReviewDto(row)`.
- Produces two RPC methods later tasks call from the frontend:
  ```ts
  openReview: { input: { repo: string; number: number; skills?: string[] };
                output: { threadId: string; review: ReviewDto } }
  getReviewForThread: { input: { threadId: string };
                        output: { repo: string; number: number } | null }
  ```

- [ ] **Step 1: Extend the fake host so tabs and sends are observable**

In `server.test.ts`, `makeHost` currently stubs `threads.spawn` and `threads.get`. Add tab state and a send recorder to it, so every test in this task and Task 3 can assert against them.

Inside `makeHost`, above `createFakePluginHost`, add:

```ts
  /** The tab list of each thread, as BB would hold it. */
  const tabs = new Map<string, { revision: number; tabs: Record<string, unknown>[] }>();
  const sent: { threadId: string; text: string; mode: string }[] = [];
  /** Thread ids `threads.get` should report as deleted. */
  const deletedThreads = new Set<string>(options.deletedThreads ?? []);
  /** Set by a test to make the next N tabs.update calls fail on revision. */
  let tabUpdateConflicts = options.tabUpdateConflicts ?? 0;
```

Add to `makeHost`'s options type:

```ts
    /** Thread ids `threads.get` should throw for, as a deleted thread does. */
    deletedThreads?: string[];
    /** How many leading `tabs.update` calls reject with a revision conflict. */
    tabUpdateConflicts?: number;
```

Change the `threads` stub to:

```ts
      threads: {
        spawn: async (args) => {
          if (options.spawnError !== undefined) throw new Error(options.spawnError);
          spawned.push({
            prompt: args.prompt ?? "",
            projectId: args.projectId,
            title: args.title ?? "",
            parentThreadId: args.parentThreadId ?? null,
          });
          const id = `thr_${spawned.length}`;
          tabs.set(id, { revision: 1, tabs: [] });
          return makeThreadResponse({ id });
        },
        get: async ({ threadId }: { threadId: string }) => {
          if (deletedThreads.has(threadId)) throw new Error(`thread ${threadId} not found`);
          return makeThreadResponse({ id: threadId, environmentId: null });
        },
        send: async (args: { threadId: string; mode: string; input: unknown }) => {
          const input = (args.input ?? []) as { type: string; text?: string }[];
          sent.push({
            threadId: args.threadId,
            mode: args.mode,
            text: input.map((item) => item.text ?? "").join(""),
          });
          return { ok: true as const, delivery: "sent" as const };
        },
        tabs: {
          get: async ({ threadId }: { threadId: string }) =>
            tabs.get(threadId) ?? { revision: 1, tabs: [] },
          update: async (args: {
            threadId: string;
            expectedRevision: number;
            tabs: Record<string, unknown>[];
          }) => {
            if (tabUpdateConflicts > 0) {
              tabUpdateConflicts -= 1;
              // Someone else wrote in between: bump the revision and reject.
              const current = tabs.get(args.threadId) ?? { revision: 1, tabs: [] };
              tabs.set(args.threadId, { ...current, revision: current.revision + 1 });
              throw new Error("revision mismatch");
            }
            const current = tabs.get(args.threadId) ?? { revision: 1, tabs: [] };
            if (args.expectedRevision !== current.revision) throw new Error("revision mismatch");
            tabs.set(args.threadId, { revision: current.revision + 1, tabs: args.tabs });
            return { revision: current.revision + 1, tabs: args.tabs };
          },
        },
      },
```

Return the new state from `makeHost` by extending its return object:

```ts
  const tabsOf = (threadId: string) => tabs.get(threadId)?.tabs ?? [];

  return { bb, harness, calls, spawned, failures, call, submit, findings, review, tabsOf, sent };
```

- [ ] **Step 2: Write the failing tests**

Append to `server.test.ts`:

```ts
describe("opening a review", () => {
  it("starts a review and spawns its thread when the PR has never been reviewed", async () => {
    const host = await makeHost();
    const opened = await host.call<{ threadId: string; review: ReviewDto }>("openReview", {
      repo: REPO,
      number: 7,
    });
    expect(opened.threadId).toBe("thr_1");
    expect(opened.review.status).toBe("running");
    expect(host.spawned).toHaveLength(1);
    expect(host.spawned[0]?.prompt).toContain(REVIEW_ID);
  });

  it("reuses a finished review's thread instead of running the agent again", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    const opened = await host.call<{ threadId: string }>("openReview", {
      repo: REPO,
      number: 7,
    });
    expect(opened.threadId).toBe("thr_1");
    // Still exactly the one thread the review itself spawned.
    expect(host.spawned).toHaveLength(1);
  });

  it("re-runs the review when its thread has been deleted", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() }, deletedThreads: ["thr_1"] });
    await runReview(host);
    const opened = await host.call<{ threadId: string }>("openReview", {
      repo: REPO,
      number: 7,
    });
    expect(opened.threadId).toBe("thr_2");
    expect(host.spawned).toHaveLength(2);
  });

  it("writes the review tab onto the review thread", async () => {
    const host = await makeHost();
    await host.call("openReview", { repo: REPO, number: 7 });
    expect(host.tabsOf("thr_1")).toEqual([
      {
        id: "code-review-review-acme-app-7",
        kind: "plugin-panel",
        pluginId: "code-review",
        actionId: "review",
        title: "Code review",
        paramsJson: JSON.stringify({ repo: REPO, number: 7 }),
      },
    ]);
  });

  it("keeps the tabs already on the thread, appending its own after them", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    // A terminal the user opened themselves must survive the open.
    host.seedTabs("thr_1", [{ id: "t1", kind: "terminal", terminalId: "term_1" }]);
    await host.call("openReview", { repo: REPO, number: 7 });
    expect(host.tabsOf("thr_1").map((tab) => tab.kind)).toEqual(["terminal", "plugin-panel"]);
  });

  it("writes the tab once, however many times the review is opened", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    await host.call("openReview", { repo: REPO, number: 7 });
    await host.call("openReview", { repo: REPO, number: 7 });
    await host.call("openReview", { repo: REPO, number: 7 });
    expect(host.tabsOf("thr_1")).toHaveLength(1);
  });

  it("retries once when someone else changed the tabs in between", async () => {
    const host = await makeHost({ tabUpdateConflicts: 1 });
    await host.call("openReview", { repo: REPO, number: 7 });
    expect(host.tabsOf("thr_1")).toHaveLength(1);
  });

  it("still opens the review when the tab cannot be written at all", async () => {
    const host = await makeHost({ tabUpdateConflicts: 5 });
    const opened = await host.call<{ threadId: string }>("openReview", {
      repo: REPO,
      number: 7,
    });
    // A missing tab is cosmetic; losing the review would not be.
    expect(opened.threadId).toBe("thr_1");
    expect(host.tabsOf("thr_1")).toHaveLength(0);
  });

  it("tells the tab which review a thread belongs to", async () => {
    const host = await makeHost();
    await host.call("openReview", { repo: REPO, number: 7 });
    const found = await host.call("getReviewForThread", { threadId: "thr_1" });
    expect(found).toEqual({ repo: REPO, number: 7 });
  });

  it("reports no review for a thread that is not one", async () => {
    const host = await makeHost();
    const found = await host.call("getReviewForThread", { threadId: "thr_other" });
    expect(found).toBeNull();
  });
});
```

The "keeps the tabs already on the thread" test needs a seeder. Add it to `makeHost` beside `tabsOf`, and include it in the returned object:

```ts
  const seedTabs = (threadId: string, extra: Record<string, unknown>[]) => {
    const current = tabs.get(threadId) ?? { revision: 1, tabs: [] };
    tabs.set(threadId, { revision: current.revision, tabs: [...extra, ...current.tabs] });
  };
```

`REPO` and `REVIEW_ID` are already defined at the top of the test file; these tests need no new imports.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server.test.ts -t "opening a review"`
Expected: FAIL — `unknown_method` for `openReview` and `getReviewForThread`.

- [ ] **Step 4: Add the contract entries**

In `server.ts`, after the `startReview` entry in `defineRpcContract`:

```ts
  /**
   * Open a review: make sure it exists, has a live thread, and that the
   * thread carries this review's tab. The panel then navigates to the thread.
   */
  openReview: {
    input: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
      skills: z.array(z.string()).optional(),
    }),
    output: z.object({ threadId: z.string(), review: reviewSchema }),
  },
  /** Which review a thread belongs to, for a tab opened from the launcher. */
  getReviewForThread: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ repo: z.string(), number: z.number() }).nullable(),
  },
```

- [ ] **Step 5: Write the helper and the handlers**

In `server.ts`, add the import at the top: `reviewTabFor` from `./review-core` (the file already imports several names from it).

Add beside `startReview`:

```ts
  /**
   * Make sure this review's tab is on its thread. The tab list is BB's, and
   * another client may be writing it too, so this is a compare-and-swap with
   * one retry. Failing to write the tab must not fail the open: the review is
   * usable from the thread panel's own New tab → Actions list either way.
   */
  async function ensureReviewTab(threadId: string, repo: string, number: number): Promise<void> {
    const tab = reviewTabFor({ pluginId: bb.pluginId, repo, number });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const current = await bb.sdk.threads.tabs.get({ threadId });
        if (current.tabs.some((entry) => entry.id === tab.id)) return;
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          tabs: [...current.tabs, tab],
        });
        return;
      } catch (error) {
        if (attempt === 1) {
          bb.log.warn(`could not add the review tab to ${threadId}: ${String(error)}`);
          return;
        }
      }
    }
  }

  /** Is this thread still there? A deleted one has to be replaced. */
  async function threadExists(threadId: string): Promise<boolean> {
    try {
      await bb.sdk.threads.get({ threadId });
      return true;
    } catch {
      return false;
    }
  }

  async function openReview(
    repo: string,
    number: number,
    skillOverride?: string[],
  ): Promise<{ threadId: string; review: ReviewDto }> {
    requireRepo(repo);
    const existing = getReview(reviewIdFor(repo, number));
    // Reuse a review whose thread is still alive: re-reading yesterday's
    // findings should cost nothing.
    const reusable =
      existing !== null &&
      existing.thread_id !== null &&
      (await threadExists(existing.thread_id));
    const review = reusable ? toReviewDto(existing) : await startReview(repo, number, skillOverride);
    const threadId = review.threadId;
    if (threadId === null) throw new Error(`Review ${review.id} has no thread.`);
    await ensureReviewTab(threadId, repo, number);
    return { threadId, review };
  }
```

Register both handlers beside `startReview`'s:

```ts
    async openReview({ repo, number, skills }) {
      return openReview(repo, number, skills);
    },
    getReviewForThread({ threadId }) {
      const row = getReviewByThread(threadId);
      return row === null ? null : { repo: row.repo, number: row.number };
    },
```

The `existing` narrowing needs `existing.thread_id` non-null inside `toReviewDto(existing)`; TypeScript narrows `existing` through the `reusable` boolean only if it is written as a single expression, so if `tsc` complains, restructure as:

```ts
    if (
      existing !== null &&
      existing.thread_id !== null &&
      (await threadExists(existing.thread_id))
    ) {
      await ensureReviewTab(existing.thread_id, repo, number);
      return { threadId: existing.thread_id, review: toReviewDto(existing) };
    }
    const review = await startReview(repo, number, skillOverride);
    if (review.threadId === null) throw new Error(`Review ${review.id} has no thread.`);
    await ensureReviewTab(review.threadId, repo, number);
    return { threadId: review.threadId, review };
```

Prefer this second form — it needs no `reusable` variable and narrows cleanly.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server.test.ts -t "opening a review"`
Expected: PASS (10 tests)

- [ ] **Step 7: Add both methods to the registrations test**

In `server.test.ts`'s `describe("registrations")`, add `"openReview"` and `"getReviewForThread"` to the second `for` loop's array (`["getFindingCode", "getPanelState", "setPanelState"]`).

- [ ] **Step 8: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add plugins/code-review/server.ts plugins/code-review/server.test.ts
git commit -m "Add openReview, which ensures a review thread and its review tab"
```

---

### Task 3: Discuss sends into the review thread

**Files:**
- Modify: `server.ts` — `discussFinding` (around line 1381)
- Test: `server.test.ts` — rewrite `describe("discussing a finding")`

**Interfaces:**
- Consumes: `buildDiscussionPrompt` from `review-core.ts` (unchanged), `bb.sdk.threads.send`.
- Produces: `discussFinding`'s output stays `{ threadId: string }` — now the review thread. The frontend (Task 4) toasts instead of opening a tab.

- [ ] **Step 1: Write the failing tests**

Replace `describe("discussing a finding")` in `server.test.ts` with:

```ts
describe("discussing a finding", () => {
  it("sends the finding into the review thread rather than spawning another", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const result = await host.call<{ threadId: string }>("discussFinding", {
      findingId: finding?.id,
    });
    expect(result.threadId).toBe("thr_1");
    // The review thread and nothing else: the review agent already has the
    // whole PR in context.
    expect(host.spawned).toHaveLength(1);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.threadId).toBe("thr_1");
    // "auto" starts an idle thread and queues or steers a running one.
    expect(host.sent[0]?.mode).toBe("auto");
    expect(host.sent[0]?.text).toContain("src/a.ts:10-12");
    expect(host.sent[0]?.text).toContain(FINDING.problem);
    expect(host.sent[0]?.text).toContain("Do not post anything to GitHub.");
  });

  it("seeds the message with the user's edit when there is one", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("setFindingComment", { findingId: finding?.id, comment: "My wording." });
    await host.call("discussFinding", { findingId: finding?.id });
    expect(host.sent[0]?.text).toContain("My wording.");
  });

  it("refuses while the review is still running, so its idle is not misread", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    // A re-run deletes only open findings, so dismiss this one to keep it, then
    // put the review back to running the way a re-run does.
    await host.call("setFindingState", { findingId: finding?.id, state: "dismissed" });
    await host.call("startReview", { repo: REPO, number: 7 });
    await expect(
      host.call("discussFinding", { findingId: finding?.id }),
    ).rejects.toThrow(/still running/i);
  });

  it("says what to do when the review has no thread", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() }, deletedThreads: ["thr_1"] });
    const [finding] = await runReview(host);
    await expect(
      host.call("discussFinding", { findingId: finding?.id }),
    ).rejects.toThrow(/re-run the review/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server.test.ts -t "discussing a finding"`
Expected: FAIL — the current implementation spawns a thread, so `host.sent` is empty and `host.spawned` has 2 entries.

- [ ] **Step 3: Rewrite the handler**

Replace `discussFinding` in `server.ts` with:

```ts
  /**
   * Talk an issue over with the agent that found it. The review thread already
   * holds the PR snapshot, the diff, and its own reasoning, so the discussion
   * goes there rather than into a thread of its own.
   */
  async function discussFinding(findingId: string): Promise<string> {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    if (review.thread_id === null) {
      throw new Error("This review has no thread — re-run the review first.");
    }
    // A review thread that goes idle without submitting is marked failed, so a
    // question asked mid-run would be read as the review giving up.
    if (review.status === "running" || review.status === "queued") {
      throw new Error("The review is still running — wait for it to finish, then discuss.");
    }
    await bb.sdk.threads.send({
      threadId: review.thread_id,
      mode: "auto",
      input: [
        {
          type: "text",
          text: buildDiscussionPrompt({
            repo: review.repo,
            number: review.number,
            prTitle: review.title,
            finding: {
              file: finding.file,
              startLine: finding.startLine,
              endLine: finding.endLine,
              title: finding.title,
              background: finding.background,
              problem: finding.problem,
              suggestedFix: finding.suggestedFix,
              suggestedComment: effectiveComment(finding),
            },
          }),
        },
      ],
    });
    return review.thread_id;
  }
```

Nothing reads or writes `findings.discussion_thread_id` any more. Leave the column and its migration statement alone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server.test.ts -t "discussing a finding"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS. If a test asserts `discussionThreadId` on a finding DTO, it still passes — the field stays in the DTO and stays null.

- [ ] **Step 6: Commit**

```bash
git add plugins/code-review/server.ts plugins/code-review/server.test.ts
git commit -m "Send a discussed finding to the review thread instead of a new one"
```

---

### Task 4: The frontend — home screen plus a review tab

The biggest task, and one reviewable unit: the panel cannot lose its routing until something else renders the issue views, and the tests move in the same step.

**Files:**
- Modify: `app.tsx`
- Test: `app.test.tsx`

**Interfaces:**
- Consumes: `openReview`, `getReviewForThread` (Task 2), `discussFinding` (Task 3).
- Produces: a `threadPanelAction` registration with `id: "review"` — the same id `reviewTabFor` writes as `actionId`.

- [ ] **Step 1: Write the failing registration and review-tab tests**

In `app.test.tsx`, replace `describe("registrations")` with:

```ts
describe("registrations", () => {
  it("registers a nav panel with no fixed tabs, and the review tab action", async () => {
    // loadPluginApp applies the host's own validation, so this catches
    // slot-id and path mistakes that would break the real panel.
    const app = await load();
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel?.id).toBe("code-review");
    expect(panel?.path).toBe("code-review");
    // The panel is the home screen now; issues live in the thread's own tab.
    expect(panel?.fixedTabs ?? []).toHaveLength(0);
    expect(app.threadPanelActions).toHaveLength(1);
    // The id must match the actionId reviewTabFor writes onto the thread.
    expect(app.threadPanelActions[0]?.id).toBe("review");
    expect(app.threadPanelActions[0]?.title).toBe("Code review");
  });
});
```

Add a helper beside the `rpc` factory:

```ts
/** The review tab, as `openReview` opens it. */
function reviewTab(app: Awaited<ReturnType<typeof load>>, overrides = {}) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: { repo: "acme/app", number: 7 } },
    { rpc: rpc(overrides) },
  );
}

/** The review tab with one issue open. */
async function openedIssue(overrides = {}) {
  const app = await load();
  const slot = reviewTab(app, overrides);
  fireEvent.click(await slot.findByText("Off by one"));
  await slot.findByLabelText("Comment for Off by one");
  return slot;
}
```

Add `getReviewForThread: () => ({ repo: "acme/app", number: 7 })`, `openReview: () => ({ threadId: "thr_1", review: REVIEW })`, and `discussFinding: () => ({ threadId: "thr_1" })` to the `rpc()` factory's defaults.

Then add:

```ts
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
    await slot.findByText("The loop walks the buffer.");
    fireEvent.click(await slot.findByText("All issues"));
    await slot.findByText("The loop runs one past the end of the buffer.");
    expect(slot.queryByText("The loop walks the buffer.")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("works out which review it is when opened from the tab launcher", async () => {
    // A launcher-opened tab has no params, only the thread it is in.
    const app = await load();
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      { rpc: rpc() },
    );
    await slot.findByText("Off by one");
    const call = slot.inspection.rpcCalls.find(
      (entry) => entry.method === "getReviewForThread",
    );
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

describe("opening a review from the home screen", () => {
  it("opens the review and goes to its thread", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    fireEvent.click(await slot.findByText("Add a thing"));
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.find((entry) => entry.method === "openReview")?.input,
      ).toEqual({ repo: "acme/app", number: 7 });
    });
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        expect.objectContaining({ kind: "thread", threadId: "thr_1" }),
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("stays on the list when the review cannot be opened", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          openReview: () => {
            throw new Error("gh is not logged in");
          },
        }),
      },
    );
    fireEvent.click(await slot.findByText("Add a thing"));
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
```

The `navigateCalls` shape is what the harness records for `toThread`; if the recorded object differs, read `slot.inspection.navigateCalls` in a failing run and match its actual shape rather than guessing.

Delete `describe("the discussion tab")` entirely.

- [ ] **Step 2: Repoint every issue-view test at the review tab**

These `describe` blocks render the panel at a `pr/...` or `pr/.../f/...` subPath and must render the review tab instead. Mechanical, one pattern:

- `describe("a PR's issue list")` — replace each `renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc(X) })` with `reviewTab(app, X)`. Delete the test named `"deep-links to a PR through the panel's subPath"` (there is no such route) — the `"shows the issues for the review its params name"` test in Step 1 covers the same RPC assertion.
- `describe("an issue and its code")`, `describe("the order of an issue view")` — replace the `detailPath` renders with `await openedIssue(X)` and delete the now-unused `detailPath` constants.
- `describe("the comment to post")`, `describe("a comment added to a pending review")`, `describe("a comment that cannot be anchored to a line")` — rewrite their local `withFinding` helper as:

```ts
  const withFinding = (overrides: Partial<FindingDto>) =>
    openedIssue({
      getPullRequest: () => ({
        pullRequest: PR,
        review: REVIEW,
        findings: [{ ...FINDING, ...overrides }],
        hasPendingReview: false,
      }),
    });
```

  Each block's own `hasPendingReview` / severity variations go in the same override object, exactly as they do today.
- `describe("links out to GitHub")` — the PR-link test renders the issue list; use `reviewTab(app)`. The per-location link tests render the detail; use `openedIssue()`.
- Untouched: `describe("the pull request list")`, `describe("remembering where you were")`, `describe("remembering the repo when status is slow")`, `describe("the Mine tab")` — all home-screen behavior.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run app.test.tsx`
Expected: FAIL — `app.threadPanelActions` is empty, so `app.threadPanelActions[0]!` is undefined and every repointed test throws.

- [ ] **Step 4: Add the review tab to `app.tsx`**

Delete `Route`, `parseSubPath`, `routeToSubPath`, `DiscussionTab`, `discussionTabRef`, `DiscussionTarget`, and the now-unused imports (`ThreadChat`, `experimental_useAppPanel`, `experimental_useFixedTabTarget`, `JsonValue` if nothing else uses it).

Add the tab component after `FindingDetailView`:

```tsx
// ---------------------------------------------------------------------------
// The review tab — one review's issues, in its own thread's panel
// ---------------------------------------------------------------------------

/** What the tab is about, however it was opened. */
function useReviewSubject(
  rpc: Rpc,
  threadId: string,
  params: unknown,
): { subject: { repo: string; number: number } | null; isLoading: boolean } {
  // Params round-trip through tab persistence, so validate rather than trust.
  const fromParams = useMemo(() => {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
    const { repo, number } = params as { repo?: unknown; number?: unknown };
    if (typeof repo !== "string" || typeof number !== "number") return null;
    return { repo, number };
  }, [params]);

  // A tab opened from the panel's own Actions launcher has no params, so ask
  // the server which review this thread is.
  const resolved = useLiveQuery(
    () => (fromParams === null ? rpc.call("getReviewForThread", { threadId }) : Promise.resolve(null)),
    [rpc, threadId, fromParams],
  );

  if (fromParams !== null) return { subject: fromParams, isLoading: false };
  return { subject: resolved.data ?? null, isLoading: resolved.isLoading };
}

function ReviewTab({ threadId, params }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const { subject, isLoading } = useReviewSubject(rpc, threadId, params);
  const [openFindingId, setOpenFindingId] = useState<string | null>(null);
  const status = useLiveQuery(() => rpc.call("status"), [rpc]);

  if (subject === null) {
    return isLoading ? (
      <Skeleton className="h-32 w-full rounded-lg" />
    ) : (
      <EmptyState
        icon="Search"
        title="Not a code review"
        detail="This thread has no review attached. Start one from the Code Review panel."
      />
    );
  }
  if (openFindingId !== null) {
    return (
      <FindingDetailView
        rpc={rpc}
        repo={subject.repo}
        number={subject.number}
        findingId={openFindingId}
        onBack={() => setOpenFindingId(null)}
      />
    );
  }
  return (
    <PrFindingsView
      rpc={rpc}
      repo={subject.repo}
      number={subject.number}
      skills={status.data?.skills ?? []}
      onOpenFinding={setOpenFindingId}
    />
  );
}
```

Change `PrFindingsView`'s props: drop `onBack`, and delete every `<BackButton onBack={onBack} label="All pull requests" />` inside it (there is one per branch — the error, loading, and loaded paths). `FindingDetailView` keeps its `onBack` and its "All issues" `BackButton`.

Delete `ReviewControls`' "Review thread" button and the `useBbNavigate` call it needs, keeping the review/re-run button, the skills line, and the error line.

In `FindingActions`, change the Discuss handler to:

```tsx
        onClick={() => {
          rpc
            .call("discussFinding", { findingId: finding.id })
            .then(() => toast.success("Sent to the review thread"), reportError);
        }}
```

and delete the `panel.openFixedTab` block and the `discuss` callback's tab plumbing.

In `CodeReviewPanel`, delete the `route`/`go` machinery and the `subPath` prop use, and give `PrListView` an `onOpenPr` that opens the review:

```tsx
        onOpenPr={(nextRepo, number) => {
          rpc.call("openReview", { repo: nextRepo, number }).then(
            (opened) => navigate.toThread(opened.threadId),
            reportError,
          );
        }}
```

Register both slots:

```tsx
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Code Review",
    // Only a fallback: the manifest icon asset wins on compact surfaces.
    icon: "Search",
    path: PANEL_PATH,
    component: CodeReviewPanel,
  });
  // One tab per review, in that review's own thread. No `run`: its context
  // carries no RPC client, so it could not work out which review a thread is
  // for — the component resolves that itself from `threadId`.
  app.slots.threadPanelAction({
    id: "review",
    title: "Code review",
    icon: "Search",
    component: ReviewTab,
    layout: "padded",
  });
});
```

`CodeReviewPanel` still receives `{ subPath }` from the host; leave the prop in its signature and ignore it, so a stale deep link renders the list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add plugins/code-review/app.tsx plugins/code-review/app.test.tsx
git commit -m "Make the panel a home screen and give each review its own tab"
```

---

### Task 5: Documentation, build, install, and the live check

The spec's two open risks are settled here, against the running editor.

**Files:**
- Modify: `README.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Rewrite the README's loop**

Replace the numbered list under "## The loop" with:

```markdown
1. **Pick a PR.** The Code Review panel lists a repo's open pull requests,
   filtered by who was asked to review: **Asked me**, **Asked my team** (any of
   them, or one you pick), or **All open**. Each row carries its review status —
   *reviewing*, the open and posted issue counts, or *review failed*.
2. **Open it.** Pressing a row opens that PR's review: a BB thread runs the
   review skills you configured against the change and writes structured
   findings, and a **Code review** tab opens beside the thread. A PR reviewed
   before opens straight onto its findings without running the agent again;
   **Re-run review** in the tab is how you ask for a fresh pass.
3. **Skim the issues.** The tab is a plain list: severity, title, and a
   three-line gist. Nothing else, plus one button through to the PR on GitHub.
4. **Open an issue** for the detail — background, problem, suggested fix — and
   below it, every file the issue points at, stacked, each showing just the
   cited lines with their real line numbers. That includes files the finding
   only mentioned in passing: `src/thing.ts:42` in its prose becomes a snippet.
   Any file header links to that file's place in the PR diff on GitHub.
5. **Act on it**: **post the comment verbatim**, **edit it first**, **discuss it
   with the review agent** in the thread beside the tab, or **dismiss it**.

Reviews are threads, so two reviews are two threads with a tab each, and the
PR and its diff open as ordinary browser tabs from any link in the tab.
```

Also update the "Act on it" phrasing further down if it repeats "side tab", and the closing line of that section: the panel remembers the repo and filter, which is still true.

- [ ] **Step 2: Bump the version**

In `package.json`, set `"version": "0.2.0"` — the tab model is a breaking change to how the plugin is used.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `bb plugin build` writes `dist/app.js`, `dist/app.css`, `dist/app.meta.json`, `dist/server.js`, `dist/server.meta.json` with no errors.

- [ ] **Step 4: Reload the running plugin**

Run: `bb plugin reload code-review && bb plugin list --json | python3 -c "import json,sys; print([p['status'] for p in json.load(sys.stdin)['plugins'] if p['id']=='code-review'])"`
Expected: `['running']`. If it is `error`, read `bb plugin logs code-review -n 50`.

- [ ] **Step 5: Settle risk one — does a server-written tab render?**

Open the Code Review panel in the editor and press a PR row. Confirm:
- the view moves to the review thread;
- a **Code review** tab is in that thread's right-hand panel;
- it shows the issue list (or the "review is working" empty state while the agent runs).

Then run `bb tabs list <threadId>` (the tab-manager plugin) to confirm the tab is in BB's own list, not just on screen.

If the tab is absent from the panel but present in `bb tabs list`, the write worked and the render did not: implement the spec's fallback — an `experimental_threadHeaderAction` that calls `openThreadPanel({ actionId: "review", params: { repo, number } })` once per review thread — and note it in the README.

- [ ] **Step 6: Settle risk two — is the tab focused?**

On a review thread that already has another tab open (open a terminal in it first), press the PR row again from home. Note whether the review tab is selected or merely present. If it is merely present, say so in the handoff — selection is client panel state, and `openThreadPanel` from the Step 5 fallback is the only lever on it.

- [ ] **Step 7: Check the whole loop by hand**

- Open a second review and confirm two threads each carry their own tab.
- Walk into an issue and back out with **All issues**.
- Press the PR link and confirm it opens as a browser tab.
- Press **Discuss** on an issue and confirm the message lands in the thread beside the tab.
- Re-open a reviewed PR from home and confirm no new agent run starts.

- [ ] **Step 8: Commit**

```bash
git add plugins/code-review/README.md plugins/code-review/package.json
git commit -m "Document the tab model and release code-review 0.2.0"
```

---

## Self-review notes

- **Spec coverage:** home screen (Task 4), review tab with params and the `threadId` fallback (Tasks 2, 4), review controls moved (Task 4), Discuss into the review thread (Task 3), `openReview` with reuse / re-spawn / CAS retry (Task 2), `reviewTabFor` in `review-core.ts` (Task 1), README (Task 5), both live risks (Task 5).
- **One spec deviation:** the spec did not say Discuss should refuse while a review is running. The `thread.idle` handler marks a *running* review failed when its thread goes idle without submitting findings, so a question asked mid-run would be read as the review giving up. Task 3 refuses in that window and says why. Flag it for retroactive review.
- **Type consistency:** `reviewTabFor` returns `actionId: "review"`; the `threadPanelAction` registration uses `id: "review"`; the test asserts they match. `discussFinding` keeps its `{ threadId }` output so the contract is unchanged.
