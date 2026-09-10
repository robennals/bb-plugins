# PR Manager

A GitHub CLI-backed BB plugin for keeping ongoing pull requests visible and actionable.

- Lists open PRs authored by the authenticated GitHub user and recently merged PRs.
- Classifies each as FAILING, FEEDBACK, DRAFT, OPEN, APPROVED, PART_APPROVED, WAITING or MERGED, and sorts them in that order — what needs your attention first — with a green card and check badge on the ones you can merge.
- Counts a PR as approved once any reviewer has approved it, even where GitHub reports no review decision because the repository requires no review. PART_APPROVED means someone has approved but another reviewer is still requested.
- Treats a PR as needing a response when a reviewer has requested changes or commented and has not been re-requested, or when someone has left a PR comment you have not replied to since. Bots and your own activity never count.
- Shows only the newest run of each check, so a cancelled run that a later re-run superseded no longer reads as failing.
- Loads the last saved result immediately and only contacts GitHub when Refresh is clicked.
- Filters the list and status counts by repository, searches by keyword across title, repository, number, branch and status, and sorts by status, creation or last update — all remembered between sessions.
- Asks what the agent should do when you create a thread, and sends that as the thread's first message.
- Finds existing BB threads by remembered PR links or matching project branches.
- Fetches a PR-specific Git ref and spawns a managed BB worktree/thread when requested.
- Provides cached and explicit-refresh commands through `bb pr-manager list [--json]` and `bb pr-manager refresh [--json]`.

The merged-PR window and list limit are configurable in BB’s plugin settings. A connected machine needs `gh` installed and authenticated.
