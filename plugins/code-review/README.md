# Code Review

Review GitHub pull requests with agents, then post each finding to GitHub
yourself — one comment at a time, edited how you want it.

## The loop

1. **Pick a PR.** The panel lists a repo's open pull requests, filtered by who
   was asked to review: **Asked me**, **Asked my team** (any of them, or one you
   pick), or **All open**.
2. **Review it.** Press *Review this PR*. A BB thread runs the review skills you
   configured against the change and writes structured findings to a JSON file,
   then submits them with `bb code-review submit`.
3. **Skim the issues.** The review screen is a plain list: severity, title, and
   a three-line gist. Nothing else, plus one button through to the PR on GitHub.
4. **Open an issue** and the comment is the first thing there, with every file
   it points at below, stacked, each showing just the cited lines with their
   real line numbers. There is no write-up above it: the comment is the
   finding's only prose, and the context that would have gone in a paragraph
   is the code itself, on screen. That includes files the finding
   only mentioned in passing: `src/thing.ts:42` in its prose becomes a snippet.
   Any file header links to that file's place in the PR diff on GitHub.

   Those snippets are the file at the reviewed commit rather than a patch,
   which is what makes the line numbers match the issue and lets you ask for
   more context. So that a reader can still tell what the change is
   responsible for, the pull request's own edits are marked on them in BB's
   diff colours: added lines green, lines it deleted folded back in red beside
   the code that replaced them, everything else plain.

   Every snippet also says where it stands, because an uncoloured one is
   otherwise ambiguous: **+2 −1 here** when the change is in the lines on show,
   **Changed elsewhere in this file** when the pull request touches the file
   but not this part of it, and **Not changed by this PR** for supporting code
   the change never goes near.
5. **Act on it**: **post the comment verbatim**, **edit it first**, **ask about
   it** (below), or **dismiss it**.

*Show pull request* opens the PR in the panel's own side tab rather than
linking out, and *diff* on a cited location opens the **Diff** view there —
GitHub's own diff, anchored at that file — so neither leaves a BB browser tab
behind. Asking for another file moves that view rather than reloading it.

The anchor is applied *after* the page has loaded rather than as part of the
URL it loads. A `#fragment` is honoured while the document is still growing,
and GitHub's diff page keeps growing well past that point — deferred diffs,
syntax highlighting — which leaves the view parked above or below the file you
asked for even though the right lines are highlighted. A
comment you have already posted still links out to GitHub, since it points at
somewhere the tab is not.

**Files** browses the repository at the commit the review read, so the code a
reviewer needs but the change does not touch — the caller of a function being
changed, the test meant to cover it — is one click away and is the same code
the findings were written against. It addresses the commit rather than the
branch, since a fork's branch does not exist under the base repository while
its commits do.

A review's GitHub views are views of one thing, so they all stay loaded while
you move between them; opening another review reclaims them together.

The panel remembers the repo and filter you were on, so re-opening the tab
resumes where you left off. Nothing reaches GitHub until you press *Post*.

## One conversation per review

*Discuss* on an issue asks what you want to know, then puts that question to
the thread that produced the review — not to a fresh thread of its own. That
thread already holds the pull request, the diff, and its reasoning for every
finding, so a question about a second issue continues the same conversation
instead of re-reading the PR from scratch.

The **Discussion** side tab follows the pull request you are looking at, so it
always shows that review's thread and never the previous one's. Re-running a
review starts a new thread, and the tab moves to it with the findings.

*Review thread* on a reviewed PR opens that same pane, so you can go on asking
the agent questions after the findings are in. The thread is spawned hidden:
the pane is the only way in, and it does not sit in the sidebar among the
threads you started yourself. It is archived once the
review is finished with — when GitHub stops asking you for the review, which is
what submitting one does, or when the pull request stops being open. Both are
only visible when a repo's list is refreshed, so the sweep runs then, and only
over the repo that was fetched: switching the picker to another repo says
nothing about the reviews in the one you left.

## A GitHub tab per review

The plugin contributes one side tab, **Code review**, with a selector at the
top choosing between the pull request, its diff, the repository's files, and
the review's conversation. One tab
rather than two because BB draws a plugin's fixed tabs icon-only *and* uses the
plugin's own branding icon for every one of them, so two tabs from this plugin
would be identical chips distinguishable only by hovering. The selector is
labelled, so it says which is which. Which half was last open is stored with
the rest of the panel's position, and pressing *Discuss* on an issue writes it
too — which is how that button reaches a tab that is closed, or showing the
other half, or open in another window.

The pull request half shows GitHub itself, in a view belonging to the
pull request you are looking at. Open another review and the previous view is
reclaimed, so a page opened for one review is never left behind for the next one
to trip over. Deselecting the tab only hides its view — re-selecting comes back
to the same page, at the same scroll position, wherever you had browsed to.

That is the whole reason it exists. BB's own Browser tabs are shared across the
plugin page and persist, and they are host-owned, so the plugin cannot scope
them — but it can own a view of its own.

### How it embeds GitHub

GitHub cannot be put in an iframe: it serves `x-frame-options: deny` and
`frame-ancestors 'none'`. BB's own browser tab is not an iframe — it is a
main-process Electron `WebContentsView`, a *top-level* frame, which those
headers do not govern. The renderer drives it over `window.bbDesktop.browser`,
and plugin frontends are imported into that same realm, so this plugin can
drive one too. Views share the `persist:bb-browser` session, so the tab is
already signed in to GitHub.

**This reaches outside the plugin SDK.** `window.bbDesktop` is a BB internal
with no stability guarantee — BB's own declaration marks several of its methods
"optional for version skew" — so `lib/desktop-browser.ts` feature-detects every
method it uses and reports no browser at all if any is missing. The right home
for this is BB itself, as a fixed tab a plugin can declare as a browser view;
until then, this is the version that works.

### Planned

**A decision on an issue should survive the agent rewriting its findings.**
Re-running a review keeps the rows for issues that were posted or dismissed,
but every finding in the incoming JSON is imported as a *new* open issue, so an
issue you already dealt with comes straight back the next time the agent writes
the file. Identity is currently the row's own UUID, which nothing in the JSON
carries.

Match on the **title alone** — not title plus file, and no new "raised again"
state. In practice the agent is only rewriting issues that are already being
discussed, so a title is enough to recognise one, and anything stricter buys
accuracy that is not needed at the cost of a rule nobody can predict. An
incoming finding whose title matches one already posted or dismissed keeps that
decision instead of being re-raised.

### What BB could do better

Four changes to BB would let this be done properly, with this plugin as the
motivating case:

- **A plugin-controlled web view.** A fixed tab declarable as a browser view,
  so BB owns the overlay's bounds, visibility, focus and teardown the way it
  already does for its own Browser tabs, and no plugin has to reach for
  `window.bbDesktop`.
- **A plugin-specified tab icon.** Honour a fixed tab's declared `icon` instead
  of overriding every one of a plugin's tabs with its branding icon, and do not
  force icon-only chips when a plugin contributes more than one tab. Then the
  selector above is unnecessary.
- **`threads.tabs` for plugin nav panels.** `bb.sdk.threads.tabs.get/update`
  already reads and rewrites a panel's tab list, browser tabs included
  (`{ kind: "browser", id, url, title }`), with a `revision` for safe
  concurrent writes. It is keyed by `threadId`, and a plugin nav panel is not a
  thread — BB's own tab hook is called with `syncThreadId: null` for these
  panels, so their tabs stay in client-side panel state. Keying that API by
  panel state id as well would let a plugin keep a set of browser tabs per
  pull request and swap them on switch, with no web view of its own.
- **A right panel scoped by plugin sub-path.** BB's own Browser and Terminal
  tabs are shared across the whole plugin page and persist, so a GitHub page
  opened for one review is still there while you read another. Keying panel tab
  state to the plugin's route would fix that for every plugin at once, rather
  than each one hand-rolling a view it owns.

### The fallback

Where there is no in-app browser to drive — the web build, where
`window.bbDesktop` is undefined, or a desktop build whose API has moved — the
tab renders the pull request from the snapshot the plugin already stores:
description, conversation and inline review comments, and the changed files,
each expanding to BB's diff viewer.

A reviewed pull request is served from the snapshot the review ran against, at
no cost to GitHub, and cannot be refreshed: the findings' line numbers are
resolved against that exact diff, so replacing it would move the code out from
under comments already written about it. Re-run the review to move to a newer
commit. A pull request you have not reviewed is fetched on demand and can be
refreshed freely. Patches load per file, when you open the file, so opening a
pull request never ships its whole diff to the panel.

## Sharing a review with the GitHub UI

Reviewing happens across both surfaces — some comments here, some in GitHub's
own diff view — so they go into the same pending review:

- **A review already open on GitHub**: the button reads *Add to my review* and
  the comment joins it as a draft, beside the ones you wrote there. GitHub
  allows only one pending review per person per PR, and refuses standalone
  comments while one is open, so this is also the only thing that *can* work.
- **No review open**: *Post comment* publishes immediately, and *Start a
  review* opens the shared draft instead — the same split GitHub's own UI
  offers. Later comments, from either surface, join it.

A draft is labelled *Draft comment* and says to submit the review on GitHub to
publish, because nobody else can see it until you do.

GitHub only anchors an inline comment to a line inside the diff. A finding
whose range overhangs one is narrowed to the part that is in it, and the panel
says so; a finding entirely outside the diff can only be a general pull request
comment, and the panel says that too — before you press the button. The review agent is told
in as many words not to post, approve, request changes, or touch the PR.

## Setup

The GitHub CLI is the only transport, and it runs server-side, so whatever
`gh auth` can see on this machine, the plugin can:

```sh
gh auth login
gh auth refresh -s read:org   # so `Asked my team` can list your teams
```

Then, in **Settings → Plugins → Code Review**:

| Setting | What it does |
| --- | --- |
| **Repositories** | Extra `owner/repo` lines to track. Repos whose checkouts are BB project sources are discovered automatically from their `origin` remote. |
| **Review skills** | Skill names the review agent runs, one per line. Defaults to `code-review`. Empty means a generic review. |
| **Extra review instructions** | Appended to every review prompt — house rules, things to always check, things to never comment on. |
| **Findings directory** | Where the agent writes its findings JSON, relative to the checkout. Defaults to `.bb/code-review`. |
| **Default BB project** | Where review threads spawn for repos not attached to a BB project. |
| **Teams** | `org/team` lines, if you would rather not grant `read:org`. |

Settings do not auto-reload: run `bb plugin reload code-review` after changing
one.

## Filters

GitHub's own `review-requested:@me` quietly folds in requests made to teams you
belong to, so it cannot tell "someone asked *me*" apart from "someone asked a
team I'm in". This plugin reads each PR's actual review requests and filters
them itself, so the two are separate:

- **Asked me** — a review request naming you.
- **Asked my team** — a request naming one of your teams, with a picker to
  narrow to a specific one.
- **All open** — every open PR in the repo.

## The review agent never touches GitHub

When a review starts, the plugin fetches the PR — description, discussion,
inline review comments, changed files, and the full diff — and stores it. The
review agent reads that snapshot over the `bb code-review` CLI instead of
running `gh` itself. Three reasons:

- **The agent sandbox usually cannot reach `gh`.** Its filtering proxy
  terminates TLS, and `gh` (a Go binary) rejects the interception with
  `x509: OSStatus -26276`. `curl` and `git` trust it; `gh` does not. The plugin
  runs in the BB server, which is not sandboxed, so its `gh` always works — and
  the CLI reaches it over loopback, which the sandbox permits.
- **The agent's environment may have no `gh` auth at all**, even where the
  server does.
- **The snapshot is pinned** to the head commit the review started from, so the
  line numbers in the findings match the diff the agent actually read, even if
  the PR moves underneath it.

```sh
bb code-review context --review owner/repo#123 [--json]  # description, discussion, files
bb code-review diff    --review owner/repo#123 [--file <path>]
bb code-review files   --review owner/repo#123
bb code-review schema                                    # the findings schema
bb code-review submit  --review owner/repo#123 --file <path>
```

A diff too large for one CLI response (the host caps a result at 1 MiB and
rejects an over-large one outright) makes `diff` list the files instead, to be
read one at a time with `--file`.

## How findings get in

The review agent writes a JSON file and submits it. That contract is
documented for agents in `skills/pr-review/SKILL.md`.

Each finding carries four things, deliberately kept apart:

| Field | Purpose |
| --- | --- |
| `file`, `startLine`, `endLine`, `side` | Where the comment anchors. No line anchor still works — it posts as a general PR comment. |
| `summary` | The gist, for the list view. |
| `suggestedComment` | Posted to GitHub verbatim, unless you edit it first. The finding's only prose. |
| `references` | The code that backs the finding up, each with a one-line note on what to look at. The panel shows it beside the issue. |

The comment is the finding's only prose — there is no separate write-up — so it
has to stand on its own: two or three sentences saying what is wrong and what you want
answered, with a numbered path only where the reader could not follow the chain
from the diff. Real symbol names are kept — they are precise and greppable —
while unnamed abstractions ("the instance snapshot") are not. That style is
written into `buildReviewPrompt`, so it travels with **every** review the
plugin starts, on every repo, whatever `Review skills` is set to; it is
repeated in `skills/pr-review/SKILL.md` for agents that read the contract
directly.

Context goes in `references`, not prose: a place in the repository and one line
on what to look at there. The panel puts that code on screen beside the issue,
which is both cheaper to write and more use than a paragraph describing it.

A single malformed finding is dropped with a warning and the rest are imported;
`submit` reports the warnings but still succeeds.

Re-running a review replaces the findings you have not acted on and keeps the
ones you have — posted comments are history, and a dismissal is a decision you
should not have to make twice.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild + reload on save
```

The pure logic — the findings contract, the prompt, PR filtering, patch
splitting, and the `gh api` argv for posting a comment — lives in
`review-core.ts` and is unit-tested without a server. `server.ts` is the
registrations and the gh plumbing; `app.tsx` is the panel.
