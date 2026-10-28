# Code Review

Review GitHub pull requests with agents, then post each finding to GitHub
yourself — one comment at a time, edited how you want it.

## The loop

1. **Pick a PR.** The Code Review panel lists a repo's open pull requests,
   filtered by who was asked to review: **Asked me**, **Asked my team** (any of
   them, or one you pick), or **All open**. Each row carries the state of this
   plugin's review of it — *reviewing*, the open and posted issue counts, or
   *review failed*.
2. **Start or open the review.** Each row has one button, because a review
   costs an agent run and should never happen by accident. **Start review**
   spawns a BB thread that runs the review skills you configured, writes
   structured findings to a JSON file, and submits them with
   `bb code-review submit`. The list stays on screen while it runs, so you can
   start the next one, and the row's button becomes **Open review**. That goes
   straight to the review's thread and spends nothing; a **Code review** tab
   opens beside the thread, and **Re-run review** inside it asks for a fresh
   pass.
3. **See where to look, then skim the issues.** The tab opens with **Worth a
   look**: the parts of the change the review thinks deserve a careful read —
   the heart of it, a design decision, a behaviour that shifts — each a title,
   a short summary and the files involved. Opening one shows that summary over
   the code doing it, as the same snippets an issue gets (below). These are
   never posted; they are a map for the reviewer. Under them, the issues are a
   plain list: severity, title, and a three-line gist, plus one link through to
   the PR on GitHub.
4. **Open an issue** and the comment is the first thing there, under the
   suggested fix, with every file it points at below, stacked, each showing
   just the cited lines with their real line numbers. There is no write-up
   above it beyond that fix: the comment is the finding's prose for the author,
   and the context that would have gone in a paragraph is the code itself, on
   screen. That includes files the finding only mentioned in passing:
   `src/thing.ts:42` in its prose becomes a snippet. Any file header links to
   that file's place in the PR diff on GitHub.

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

## One review, one thread, one tab

A review is a BB thread like any other, and its issues live in a **Code
review** tab in that thread's right-hand panel. Two reviews are two threads
with a tab each, so opening one never disturbs the other.

Opening a review from the panel writes that tab onto the thread server-side,
with `bb.sdk.threads.tabs.update` under a compare-and-swap, then navigates to
the thread. Writing the tab makes it *exist*; it does not open it, because
which tab is showing is client panel state that only
`useBbNavigate().openThreadPanel` reaches — and that call works only from
inside the thread surface, which the panel is not. So the panel leaves a
one-shot note naming the thread it is navigating to, and a thread header slot
picks it up when BB mounts that thread, opening the tab with the same params
the server wrote so it focuses that tab rather than opening a second one. The
note is consumed on use, so coming back later respects a tab you have since
closed; the header's **Code review** button is how you get it back.

Failing to write the tab never fails the open — a missing tab is cosmetic, and
the review is still reachable from the thread panel's own **New tab →
Actions** list, which resolves it from the thread id.

**Viewing the pull request or a diff is an ordinary browser tab**, opened from
any link — on a row, on an issue, or on a cited file's header. The plugin used
to embed GitHub in a side tab of its own, driving BB's in-app browser through
`window.bbDesktop` because GitHub refuses to be iframed. That is gone: it was
a BB internal, it only worked on the desktop build, and a browser tab in the
review's own thread is both simpler and already what BB does well.

## One conversation per review

Questions about a finding go to the thread that produced the review, which
already holds the pull request, the diff and its own reasoning. **Ask** puts
the question to it rather than firing a bare prompt.

**The answer lands on the issue.** The thread records it with
`bb code-review answer`, and it appears under the comment in a **Questions**
box — the conversation in the chat is still there, but you do not have to read
it. While an answer is on its way the box says so, and the issue's row in the
list shows *answering*.

- **An answer can correct the issue.** When it changes what the title,
  summary, suggested fix or comment should say, the issue is rewritten in
  place, and the answer says which parts changed.
- **Ask about several issues at once.** Each question is queued behind any
  answer already being written rather than steered into it, so each gets a
  turn of its own, and carries an id, so its answer reaches the right issue
  whatever order they finish in.
- **An agent that only answers in the chat** still shows up: once the thread
  has nothing left to do, a question left without an answer is marked so, with
  the thread's last reply when it can only have been about that question. An
  answer recorded after that still lands.

## The report stays editable

The review thread is told, when it starts, that submitting is not the end:
whatever you discuss with it afterwards — through **Ask**, or by typing in the
thread — it should keep the report in step. It can add findings, revise them
(any field, including severity and location), and withdraw them:

```sh
bb code-review findings --review owner/repo#123          # current findings, with ids
bb code-review edit     --review owner/repo#123 --file <path>
```

An edit file holds `add`, `update` and `remove` lists, and is applied all or
nothing, with the same path checks as `submit`.

- **Every change says so on the issue.** A revised issue shows what changed,
  when, and the thread's one-line reason. A withdrawn one is dismissed rather
  than deleted, with the reason, so your edits and questions on it survive and
  **Restore** undoes it.
- **Your edits win.** The comment is only rewritten while it is still the
  agent's own. Once you have edited or posted it, the revised comment is shown
  under yours instead, with **Use this comment** and **Keep mine**.
- **Posted comments are history.** The thread cannot move or withdraw one; it
  can add a new finding instead.

Asking is refused while a review is still running. A review thread that goes
idle without submitting findings is marked failed, so a question asked mid-run
would be read as the review giving up.

The panel remembers the repo and filter you were on, so re-opening it resumes
where you left off. Nothing reaches GitHub until you press *Post*.

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

## Choosing the model

A model picker sits beside **Refresh** on the pull request list, and beside
**Re-run review** in a review's tab. It is BB's own picker, so it offers the
same providers, models and reasoning levels as the composer.

- **The choice sticks.** It is stored on the server and every review started
  after it runs with it, until you pick another.
- **Until you choose**, the picker shows the default of the BB project the repo
  belongs to, and reviews are started without naming a model, which leaves BB to
  apply that default.
- **A running review is not affected.** The model is set when the review thread
  is spawned; re-run the review to use a different one.

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
bb code-review findings --review owner/repo#123          # the current findings, with ids
bb code-review edit    --review owner/repo#123 --file <path>  # add, revise, withdraw
bb code-review answer  --question <id> --file <path>       # an answer to a question
```

A diff too large for one CLI response (the host caps a result at 1 MiB and
rejects an over-large one outright) makes `diff` list the files instead, to be
read one at a time with `--file`.

## How findings get in

The review agent writes a JSON file and submits it. That contract is
documented for agents in `skills/pr-review/SKILL.md`.

Each finding carries five things, deliberately kept apart:

| Field | Purpose |
| --- | --- |
| `file`, `startLine`, `endLine`, `side` | Where the comment anchors. No line anchor still works — it posts as a general PR comment. |
| `summary` | The gist, for the list view. |
| `suggestedFix` | How the agent would fix it — for the reviewer, not the author. Empty when it has no concrete fix, which beats a padded one. |
| `suggestedComment` | Posted to GitHub verbatim, unless you edit it first. The only field the author sees. |
| `references` | The code that backs the finding up, each with a one-line note on what to look at. The panel shows it beside the issue. |

The comment is the finding's only prose for the author — there is no write-up
besides the fix — so it has to stand on its own: two or three sentences saying what is wrong and what you want
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

Alongside `findings`, the file carries `highlights`: what a reviewer should
look at, as opposed to what is wrong. Each is a `title`, a one- or two-sentence
`summary`, and `locations` — the code doing it, in the same shape as
`references` and checked against the repository the same way. They are
optional, so a report without them is still whole, and a re-run replaces all
of them, since nothing about one is ever acted on.

A single malformed finding or highlight is dropped with a warning and the rest
are imported; `submit` reports the warnings but still succeeds.

Re-running a review replaces the findings you have not acted on and keeps the
ones you have — posted comments are history, and a dismissal is a decision you
should not have to make twice. Questions about a replaced finding go with it.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild + reload on save
```

The pure logic — the findings contract, the prompt, PR filtering, patch
splitting, the review tab's own JSON, and the `gh api` argv for posting a
comment — lives in `review-core.ts` and is unit-tested without a server.
`server.ts` is the registrations and the gh plumbing; `app.tsx` is the home
screen, the review tab, and the thread header control that opens it.

`suggested_fix` was dropped by a shipped migration and comes back through
`ensureColumn` rather than by editing that statement: `bb.storage.migrate`
applies statements by index and hashes their text, so editing one that has
already run makes the plugin refuse to load.
