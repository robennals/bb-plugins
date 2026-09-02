---
name: pr-review
description: Use when asked to review a GitHub pull request and report findings to BB's Code Review plugin — i.e. whenever a prompt names a review id like "owner/repo#123" or tells you to run `bb code-review submit`. Covers the findings JSON contract, the submit step, and the issue-list tools you keep afterwards.
---

# Reporting pull request review findings

The Code Review plugin starts a review by spawning a thread — *this* thread —
with a review id (`owner/repo#123`) and a findings path. Your job is to review
the PR and hand the findings back as structured JSON. They then appear in the
**Findings** tab of this thread's side panel, where the reviewer reads them and
posts each comment themselves.

The review pass is not the end of the thread. The reviewer works through the
issues in that tab and asks you about them here, and you have `code_review_*`
tools for the issue list while you are on a review thread (see "Afterwards").

## The loop

1. **Read the change.** The plugin already fetched it — you do **not** need
   `gh`, and you do not need network access:

   ```sh
   bb code-review context --review <owner/repo#123>   # description, discussion, changed files
   bb code-review diff    --review <owner/repo#123>   # the diff
   ```

   The diff is a snapshot pinned to the head commit the review started from, so
   its line numbers are the ones your findings must use. If the diff is too
   large to print at once, `diff` says so and lists the files; read them one at
   a time with `--file <path>`. `bb code-review files --review <id>` lists them
   with their line counts.

   Read the surrounding code in the checkout too. A diff on its own rarely
   shows whether a change is correct.

2. **Review it** using whatever skills the prompt named. If it named none,
   review for correctness bugs, missing tests, security problems, and design
   issues.

3. **Write the findings file** to the path the prompt gave you. Print the exact
   schema any time with:

   ```sh
   bb code-review schema
   ```

4. **Submit it.**

   ```sh
   bb code-review submit --review <owner/repo#123> --file <path>
   ```

   `bb code-review context --review <owner/repo#123> --json` reprints the
   configured skills and the findings path if you lose them.

## Afterwards: the issue list is yours to read and edit

Once the findings are in, they are rows the reviewer is looking at, and these
tools are that list:

| Tool | What it does |
| --- | --- |
| `code_review_list_issues` | Every issue with its **id**, severity, location, and state. Call this first: ids change when a review is re-run. |
| `code_review_get_issue` | One issue in full, including the comment as it currently stands — which may be the reviewer's own edit, not your suggestion. |
| `code_review_set_issue_comment` | Re-word what an issue would post. Only when asked, and say what you changed. |
| `code_review_set_issue_state` | Dismiss an issue that turned out to be wrong, or restore a dismissed one. |
| `code_review_add_issue` | Add one issue the conversation turned up. Appended to the end, so the reviewer's place in the list does not move. |

Answer from these rather than from memory: the reviewer may have edited a
comment or dismissed an issue since you wrote it. Use a tool for a single
change; write and submit a whole findings file only for a fresh review pass,
which replaces every issue the reviewer has not yet acted on.

## Writing good findings

Each finding has these parts, and they are not interchangeable:

- **`summary`** — the gist, in at most two sentences. This is all the reviewer
  sees in the list, so it has to convey what is wrong on its own.

- **`background`** — what the code does, so a reader who has not been in this
  file can follow the rest. Not a restatement of the problem.
- **`problem`** — what is actually wrong and why it matters. Concrete: the
  input, the state, the wrong result.
- **`suggestedFix`** — how you would fix it.
- **`suggestedComment`** — posted to GitHub verbatim. Write it *to the PR
  author*, not as a note to yourself: no "the user should", no restating what
  you did. Short and specific beats thorough and vague.
- **`references`** — other places in the repo the finding depends on: the
  function it contradicts, the existing pattern it diverges from, the test that
  should have caught it. Each is `{ file, startLine, endLine, note }`, and the
  Findings tab shows that code next to the finding, so a reference saves the
  reviewer the lookup. Citing `path/to/file.ts:42` inline in your prose works
  too — the tab picks those up — but a `references` entry with a `note` is
  better.
- **`file` / `startLine` / `endLine`** — where the comment anchors. Use line
  numbers in the **new** file (`side: "RIGHT"`); use `"LEFT"` and old-file line
  numbers only when commenting on a deleted line. A finding with no line
  anchors still works — it posts as a general PR comment instead.

Report only what you verified against the code. A finding you cannot point at
a specific file and line for is not worth the user's time to triage. If you
find nothing, submit a file with an empty `findings` array — that is a
meaningful result, not a failure.

## Paths must be full and real

Every path you write — `file`, every `references` entry, and any `path:line`
you cite in prose — must be the **full repo-relative path**:

```
e2e-tests/tests/login.spec.ts:28     yes
login.spec.ts:28                     no
```

`bb code-review submit` checks each one against the repository and **rejects
the whole file** if any path does not exist, listing the bad ones with the
likely intended path. Fix them and submit again. `bb code-review files` lists
the PR's paths; the diff shows them too.

This matters because the Findings tab shows the code at each path next to the
finding.
A bare filename is ambiguous — a real repo has dozens of `index.ts` — so the
reviewer either sees the wrong file or none.

## Rules

- **Do not run `gh`.** Everything about the PR is available from
  `bb code-review`, fetched server-side where GitHub access is configured. The
  agent sandbox often cannot reach `gh` anyway.
- **Never post to GitHub yourself**, and never approve or request changes. Every
  comment is reviewed and posted by hand by the reviewer, from the Findings
  tab. There is deliberately no tool that posts — editing an issue's comment is
  as far as you go.
- **Never modify the PR**, push commits, or edit files in the checkout.
- A single malformed finding is dropped with a warning and the rest are
  imported, so a stray field will not lose the whole review — but check the
  submit output for warnings.
