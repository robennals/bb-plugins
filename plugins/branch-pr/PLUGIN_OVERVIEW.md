Put the pull request for the branch you are working on into the side panel,
without leaving bb to go looking for it.

## What you get

- A **thread header button** that opens the GitHub pull request for this
  thread's branch as a tab in the right-hand panel.
- The same action in the **command palette** and in the panel's **Actions**
  list.
- The real GitHub page — conversation, files, checks, review — not a
  reconstruction of it.

## How it works

bb already resolves which pull request belongs to an environment's branch. This
plugin asks it, then adds a browser tab for the answer. Pressing the button
again recognises the tab it already opened instead of adding a second one.

When the branch has no pull request, it says so and names the branch. When the
lookup itself could not run — the GitHub CLI is missing, not signed in, or the
machine is unreachable — it says that instead, so "no pull request" always
means the branch really has none.

## Requirements

A connected machine with the GitHub CLI installed and signed in
(`gh auth login`). The plugin uses bb's own lookup and stores no tokens.
