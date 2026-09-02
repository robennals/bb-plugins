# Code Review

Review GitHub pull requests with agents, then post each finding to GitHub
yourself — one comment at a time, edited how you want it.

## A review is a thread

Each review is an ordinary BB thread, with its own sidebar row, its own title,
and its own unread state. Two reviews can be open at once, side by side in a
split. The plugin adds three things:

| Surface | What it is |
| --- | --- |
| **Code Review** in the sidebar | The inbox: a repo's open pull requests, filtered by who was asked to review. |
| **Findings**, in a review thread's side panel | That review's issue list, and an issue with the code it points at. |
| A control in a review thread's header | The open-issue count, and what opens the Findings tab on arrival. |

## The loop

1. **Pick a PR** from the inbox, filtered by who was asked to review: **Asked
   me**, **Asked my team** (any of them, or one you pick), **All open**, or
   **Mine**. The panel remembers the repo and filter you were on, so re-opening
   the tab resumes where you left off.
2. **Press the row.** With no review yet the row says *Review*, and pressing it
   starts one: a thread runs the review skills you configured against the
   change, writes structured findings to a JSON file, and submits them with
   `bb code-review submit`. With a review already there, the row opens its
   thread. Either way you land on the thread with **Findings** open.
3. **Skim the issues.** The tab is a plain list: severity, title, and a
   three-line gist. Nothing else, plus one button through to the PR on GitHub.
4. **Open an issue** for the detail — background, problem, suggested fix — and
   below it, every file the issue points at, stacked, each showing just the
   cited lines with their real line numbers. That includes files the finding
   only mentioned in passing: `src/thing.ts:42` in its prose becomes a snippet.
   Any file header links to that file's place in the PR diff on GitHub.
5. **Act on it**: **post the comment verbatim**, **edit it first**, **dismiss
   it**, or **ask about it** — which quotes the issue into the thread's
   composer for you to type your question under.

Nothing reaches GitHub until you press *Post*.

## Talking to the review

The thread is the conversation, so there is no separate discussion surface —
you ask in the chat you are already looking at. While a thread is a review, its
agent also gets tools for the issue list, so the answers come from what was
actually recorded rather than from the transcript, and what you decide lands in
the list:

| Tool | |
| --- | --- |
| `code_review_list_issues` | the issues, with the ids the other tools take |
| `code_review_get_issue` | one issue in full, including your own edit of its comment |
| `code_review_set_issue_comment` | re-word what an issue would post |
| `code_review_set_issue_state` | dismiss an issue that turned out to be wrong, or restore one |
| `code_review_add_issue` | add an issue the conversation turned up, appended so your place in the list does not move |

There is deliberately **no tool that posts to GitHub**. Editing an issue's
comment is as far as the agent goes; publishing is always yours.

Any other thread gets none of these — `bb.agents.configure` withholds the tools
and the `pr-review` skill on a thread that is not a review.

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
whose range overhangs one is narrowed to the part that is in it, and the tab
says so; a finding entirely outside the diff can only be a general pull request
comment, and the tab says that too — before you press the button. The review agent is told
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

Each finding carries five things, deliberately kept apart:

| Field | Purpose |
| --- | --- |
| `file`, `startLine`, `endLine`, `side` | Where the comment anchors. No line anchor still works — it posts as a general PR comment. |
| `background` | What the code does, for a reader who has not been in this file. |
| `problem` | What is actually wrong and why it matters. |
| `suggestedFix` | How the agent would fix it. |
| `suggestedComment` | Posted to GitHub verbatim, unless you edit it first. |

A single malformed finding is dropped with a warning and the rest are imported;
`submit` reports the warnings but still succeeds.

Re-running a review replaces the findings you have not acted on and keeps the
ones you have — posted comments are history, and a dismissal is a decision you
should not have to make twice. A single change asked for in the thread goes
through a tool instead, which leaves the rest of the list alone.

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
registrations and the gh plumbing; `app.tsx` is the three frontend surfaces.
`docs/thread-per-review.md` records why the thread-header control exists, which
is not obvious from reading it.
