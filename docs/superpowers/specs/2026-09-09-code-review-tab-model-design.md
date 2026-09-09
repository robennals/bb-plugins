# Code Review: one home screen, one tab per review

> **Revised 2026-09-09, second pass.** The first pass was written against a
> stale checkout: `origin/main` already carried PR #8, "Make the code review
> panel self-contained", which rebuilt much of the same plugin. This design is
> now stated against that base. What changed:
>
> - **`background` and `problem` are gone for good.** PR #8 removed them as a
>   write-up nobody read, and that judgment stands. `suggestedFix` comes back:
>   it was often useful, and it returns through `ensureColumn`, not by editing
>   the migration that dropped it.
> - **Review threads are ordinary visible threads.** PR #8 spawned them hidden
>   and archived them once GitHub stopped asking for the review. Both go: the
>   thread is now the surface you work in, so hiding it or archiving it
>   underneath you is wrong.
> - **PR #8's four-view GitHub side tab is removed**, along with
>   `lib/desktop-browser.ts` and the `window.bbDesktop` workaround it needed.
>   Viewing a PR or a diff is an ordinary browser tab, opened from a link.
> - **PR #8's `askAboutFinding` is kept as-is** — it asks what you want to know
>   and sends it to the review thread, which is a better version of what the
>   first pass built.
> - **Kept from PR #8:** the diff-coloured snippets, `references` as the way an
>   issue carries context, the reworked findings prompt, and `ensureColumn`.

The Code Review plugin holds everything in its own sidebar panel: a pull
request list, a per-PR issue list, an issue detail view, and one fixed side tab
carrying four views of the pull request — the PR, its diff, its files, and the
review conversation. Every review shares that single panel, so two reviews
cannot be open at once, and the side tab shows whichever review you opened
last. Driving GitHub inside that tab also needs `window.bbDesktop`, a BB
internal, because GitHub refuses to be iframed.

This design splits it in two. The panel becomes a home screen and nothing
else. Each review opens its own tab in its own review thread, so BB's existing
thread and tab model does the multiplexing the panel was trying to do itself.

- **Home** — the pull request list, exactly as it looks today.
- **A review** — the review agent's thread, with a *Code review* tab beside it
  holding that review's issues.
- **A PR or a diff** — a browser tab in that thread, opened from a link.

## Why this fits BB

Three capabilities in the plugin SDK make it work, all of them already public:

- **`threadPanelAction`** registers a closable tab in a thread's right-hand
  panel, rendering a plugin component with persisted JSON `params`. Different
  params open sibling tabs, so two reviews are two tabs in two threads.
- **`bb.sdk.threads.tabs.get` / `tabs.update`** read and write a thread's tab
  list server-side, with a `expectedRevision` compare-and-swap. The tab union
  includes `plugin-panel` (a `threadPanelAction` tab, by `pluginId` +
  `actionId` + `paramsJson`) and `browser` (a URL). This is how a review tab
  gets installed on a thread the user is not currently looking at.
- **`useBbNavigate().openUrl`** already opens a GitHub URL through the client's
  own browser preference, which is what the plugin's `GithubLink` uses today.
  Viewing the PR needs no new code.

Reviews already spawn one thread per PR, into the project that owns the repo's
checkout, so the thread this design hangs everything off exists today. Two
things about it change: it is spawned **visible** rather than hidden, and the
sweep that archived it once GitHub stopped asking for the review goes, because
you cannot work in a thread that is archived underneath you.

## Surfaces

### The nav panel is home

`CodeReviewPanel` keeps its status probe, its saved repo/filter state, and its
`PrListView`. It loses its router:

- **Delete `Route`, `parseSubPath`, `routeToSubPath`, and the `go` callback.**
  The panel renders one view. A stale deep link (`.../code-review/pr/o/r/12`)
  lands on the list, because an unparsed `subPath` is simply ignored.
- **Delete the `fixedTabs` registration** and with it the whole four-view side
  tab — `ReviewSideTab` and its panes, `reviewTabRef`, and the
  `lib/desktop-browser` plumbing they needed.
- **`PrRow` gains no new UI.** It already shows the review badge — `reviewing`
  while the agent runs, `N open · M posted` once findings land, `review failed`
  on error — because `listPullRequests` returns `reviewStatus`, `openFindings`,
  and `postedFindings` per PR.

Pressing a row no longer navigates within the panel. It opens the review (see
"Opening a review" below).

### The review tab

A new `threadPanelAction`:

```ts
app.slots.threadPanelAction({
  id: "review",
  title: "Code review",
  component: ReviewTab,
  layout: "padded",
});
```

There is no `run`. A `threadPanelAction`'s `run` context carries only
`threadId` and `openPanel` — no RPC client, because `useRpc` is a hook and
`run` is a plain callback — so it could not resolve which review a thread is
for. Omitting `run` means activating the action from the thread panel's
**New tab → Actions** list opens a tab immediately with `params: null`, which
this design makes a working entry point rather than a dead one.

`ReviewTab` therefore resolves its subject in two steps:

- **`params` is `{ repo: string, number: number }` when present.** They
  round-trip through tab persistence, so they are untrusted input: validate the
  shape, then fetch everything by id through the existing `getPullRequest` and
  `getFindingCode` RPCs rather than trusting anything embedded in the tab.
- **`params` is `null`** — a launcher-opened tab — so fall back to the
  `threadId` prop and a new `getReviewForThread({ threadId })` RPC, which wraps
  the existing `getReviewByThread` row lookup and returns `{ repo, number }` or
  `null`. `null` renders an empty state: "This thread is not a code review."

Params stay on the tab even though `threadId` alone would do, because they give
the tab a stable identity for the dedupe rule and a meaningful title.

Inside, the tab owns one piece of state — which issue is open:

```ts
const [openFindingId, setOpenFindingId] = useState<string | null>(null);
```

- **`null`** renders `ReviewControls` plus `PrFindingsView`: the open, posted,
  and dismissed issue groups, each row a severity badge, a title, a three-line
  gist, and a location.
- **A finding id** renders `FindingDetailView`: the summary, the suggested fix,
  the editable comment, the post/dismiss/ask actions, and every place the issue
  cites stacked below as a snippet, carrying the change in BB's diff colours
  with real line numbers.

`PrFindingsView` and `FindingDetailView` keep PR #8's own bodies, changed only
in their back affordances and in rendering `suggestedFix` again. `PrFindingsView` loses its `onBack` prop and its
"All pull requests" `BackButton` — the tab is the top of its own stack, and
home is a sidebar click away. `FindingDetailView` keeps its "All issues"
`BackButton`, now wired to `setOpenFindingId(null)`.

The tab needs the configured skill list for `ReviewControls`' "Skills: …"
line, which the panel used to pass down from its own `status` query. `ReviewTab`
calls `status` itself; it is a cheap cached probe and the tab is a separate
mount.

### Review controls live in the tab

`ReviewControls` moves into the review tab, above the issue list, and keeps
its states — **Reviewing…** while queued or running, **Re-run review** once
findings are reported — plus the skills line and the error line. It loses any
way back to the thread: the thread is on the other side of the split.

Re-running keeps today's merge rule. `startReview` deletes only `state =
'open'` findings, so posted comments stay as history and dismissals stay
decided.

### PRs and diffs are browser tabs

No new code. `GithubLink` wraps a real anchor and calls
`navigate.openUrl(href)`, falling through to normal anchor behavior when the
client declines, so modifier-clicks and copy-link keep working. Rendered from
inside the review tab, an activation opens a browser tab in that thread on
clients that prefer BB's own browser. Existing links stay as they are: the PR
button, the per-location "view in diff" file headers, and the blob links.

Because review threads spawn into the repo's project, the thread also offers
BB's own `git-diff` tab for the local checkout, at no cost to this plugin.

## Opening a review

One new RPC replaces the panel's internal navigation.

```ts
openReview: {
  input: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    skills: z.array(z.string()).optional(),
  }),
  output: z.object({ threadId: z.string(), review: reviewSchema }),
}
```

The handler does three things in order.

**1. Ensure a review and a live thread.**

- No review row for `owner/repo#number` → run today's `startReview`: fetch the
  PR snapshot server-side, insert the row, spawn the thread with the review
  prompt.
- A review row whose `thread_id` resolves through `bb.sdk.threads.get` → reuse
  it and run no agent. Opening yesterday's findings costs nothing.
- A review row whose thread has been deleted → `startReview` again, which
  re-spawns and resets the row while keeping acted-on findings.

**2. Install the review tab on that thread.**

```
tabs.get({ threadId })
  → already has a plugin-panel tab with our pluginId, actionId "review",
    and paramsJson matching this repo+number?  → done
  → otherwise append one and tabs.update({ threadId, expectedRevision, tabs })
```

A revision conflict (someone opened or closed a tab in between) re-reads and
retries once, then gives up with a logged warning. The review is open and
usable either way; a missing tab is cosmetic, and the user can open it from the
thread panel's **New tab → Actions** list, which resolves the review from the
thread id.

Tab ids are the plugin's to mint. Use a stable, derived id —
`review-<owner>-<repo>-<number>` — so a repeat install is recognisable even if
the params comparison changes shape later.

**3. Return the thread id**, and the frontend calls
`navigate.toThread(threadId)`.

### Why the tab is written server-side

`useBbNavigate().openThreadPanel({ actionId, params })` is the natural API for
opening a `threadPanelAction`, but it opens a tab *in the currently focused
thread* and returns false anywhere else — and home is a nav panel, not a
thread. The alternatives were:

- **Navigate first, then open from inside the thread.** Needs handoff state
  that outlives the navigation and a component mounted in the target thread to
  consume it. More moving parts, and the thread has no plugin component
  mounted until the tab exists.
- **Write the tab server-side, then navigate.** One RPC, no handoff, and the
  tab is durable, so returning to the thread later finds it still there.

The second is what this design does. `tabs.update` validates the whole list
against BB's own strict schema, so a malformed tab is a rejected write rather
than a broken panel.

## Discussing an issue

PR #8 already settled this the better way: `askAboutFinding(findingId,
question)` asks what you want to know, then sends it to the review thread,
which already holds the PR snapshot, the diff, and its own reasoning. It stays
exactly as it is. The first pass's bare-prompt `discussFinding` is dropped, and
so is the fixed Discussion pane it fed.

One guard is added. The `thread.idle` handler marks a *running* review failed
when its thread goes idle without submitting findings, so a question asked
mid-run would be read as the review giving up. `askAboutFinding` refuses while
the review is queued or running and says why.

## What changes, file by file

**`review-core.ts`**

- Add `reviewTabFor(pluginId, repo, number)` and `REVIEW_TAB_ACTION_ID` — the
  tab object as pure data, unit-tested without a server.
- Put `suggestedFix` back in the findings contract: parsed from the agent's
  report, carried on the DTO, and asked for in the review prompt.

**`server.ts`**

- `ensureColumn("findings", "suggested_fix", ...)` re-adds the column. The
  migration that dropped it has already run on real databases and
  `bb.storage.migrate` hashes statements by index, so editing that statement
  would refuse to load the plugin. `ensureColumn` checks the table instead.
- Add `openReview`, which refuses a PR with no live review thread rather than
  starting one, and `getReviewForThread` for a launcher-opened tab.
- Add `ensureReviewTab`, and call it from both `openReview` and `startReview`.
- Spawn review threads **visible**: drop `visibility: "hidden"`.
- Delete `archiveFinishedReviewThreads` and its call from the PR-list refresh.
  The `thread_archived_at` column stays; nothing reads it.
- Delete `getReviewThread`, `getPullRequestView` and `getPullRequestPatch`,
  which only the four-view side tab used, plus any helper they alone reach.
  Everything the `bb code-review` CLI and `getFindingCode` need stays.

**`app.tsx`**

- Delete the four-view side tab and everything only it used: `DiscussionPane`,
  `GithubPane`, `PrComment`, `PrFile`, `ChangedFiles`, `DiffPane`,
  `FilesPane`, `DiffSnapshotView`, `PullRequestPane`,
  `PullRequestSnapshotView`, `ReviewSideTab`, `reviewTabRef`,
  `withoutFragment`, `isSidePane`, `useOpenSidePane`, and the
  `lib/desktop-browser` imports. Delete the panel's `fixedTabs`.
- Delete `Route`, `parseSubPath` and `routeToSubPath`; the panel has one view.
- `PrRow` carries one explicit button — **Start review** or **Open review** —
  and its body is no longer a button, because a review costs an agent run.
- Add `ReviewTab`, a `threadPanelAction` wrapping PR #8's `ReviewControls`,
  `PrFindingsView` and `FindingDetailView` with local open-finding state.
- Add `ReviewThreadHeaderAction`, an `experimental_threadHeaderAction` that
  opens the review tab when the panel sends the user to that thread, and is
  the way back to a tab they closed.
- `LocationCard`'s "show diff" opened the side tab's diff pane; it becomes a
  link to that file's place in the PR diff on GitHub.
- `FindingDetailView` renders `suggestedFix` again, above the comment box.

**`lib/desktop-browser.ts`** — deleted.

**`README.md`** — rewrite the loop, and drop the side tab and the
`window.bbDesktop` section.

## Testing

**Server** (`server.test.ts`, `createFakePluginHost`):

- `openReview` on an unreviewed PR spawns a thread and records it.
- `openReview` on a reviewed PR with a live thread makes no `threads.spawn`
  call and returns the existing thread id.
- `openReview` on a review whose thread has been deleted re-spawns.
- The first `openReview` appends exactly one `plugin-panel` tab with the right
  `pluginId`, `actionId`, and `paramsJson`; the assertion reads
  `harness.inspection.sdk.callsTo("threads.tabs.update")`.
- A second `openReview` for the same PR writes no tab.
- A stubbed `tabs.update` that rejects on the first revision and accepts on the
  second leaves exactly one tab, and one that always rejects resolves anyway
  with a warning logged.
- `askAboutFinding` refuses while the review is queued or running, and sends
  nothing.
- `suggestedFix` survives a report round trip: parsed from the agent's JSON,
  stored, and returned on the DTO.
- A review thread is spawned visible, and no PR-list refresh archives it.

**Frontend** (`app.test.tsx`, `renderSlot`):

- The nav panel renders the PR list for `subPath: ""` and for a stale
  `subPath: "pr/o/r/12"`.
- Pressing a PR row calls `openReview` and then `navigate.toThread`, asserted
  through `inspection.rpcCalls` and `inspection.navigateCalls`.
- The review tab renders the issue groups from its params, walks into an issue
  and back out with the "All issues" button.
- The review tab with `params: null` resolves the review through
  `getReviewForThread`, and shows the "not a code review" empty state when that
  returns null.
- Ask calls `askAboutFinding` and opens no tab.
- The issue detail renders the suggested fix.
- `reviewTabFor` is unit-tested in `review-core.test.ts` for id stability and
  params shape.

`npm test` and `npm run typecheck` both pass before this is considered done.

## Risks

**A server-written `plugin-panel` tab may not render.** The tab union is public
in the plugin SDK and the tab-manager plugin round-trips these tabs
field-for-field, so a written tab should mount the registered action — but no
plugin in this repo has yet *created* one this way. Verify with `bb plugin dev`
against a real review thread as the first implementation step, before the UI
work depends on it.

*Fallback if it does not:* register an `experimental_threadHeaderAction` that
mounts on every thread, recognises a review thread through a cheap RPC, and
calls `openThreadPanel` once. That runs inside the thread, where
`openThreadPanel` is documented to work, at the cost of a component mounted on
threads that are not reviews.

**The new tab may not be focused.** Which tab is active is client panel state
and is not part of the tab list, so appending a tab does not necessarily select
it. A fresh review thread has no other content tab, so BB should land on it;
a thread that already has tabs may need a click. Confirm in the same live
check. If focus turns out to matter, `openThreadPanel` (from the fallback
above) does select the tab it opens.

**`openUrl`'s destination is the client's choice.** Whether a GitHub link lands
in a BB browser tab or an external browser follows the user's own preference,
per client. That is the intended behavior — "a regular browser tab" — and not
something this plugin should override.

## Out of scope

- Reordering or closing review tabs. The tab-manager plugin already does that
  for any thread.
- Any change to the findings contract, the review prompt, the GitHub posting
  paths, or the `bb code-review` CLI.
- Showing findings anywhere other than home's per-PR badge and the review tab.
