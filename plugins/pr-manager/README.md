# PR Manager

A GitHub CLI-backed BB plugin for keeping ongoing pull requests visible and actionable.

- Lists open PRs authored by the authenticated GitHub user and recently merged PRs.
- Classifies each as FAILING, FEEDBACK, DRAFT, OPEN, APPROVED, PART_APPROVED, WAITING or MERGED, and sorts them in that order — what needs your attention first — with a green card and check badge on the ones you can merge.
- Counts a PR as approved once any reviewer has approved it, even where GitHub reports no review decision because the repository requires no review. PART_APPROVED means someone has approved but another reviewer is still requested.
- Treats a PR as needing a response when a reviewer has requested changes or commented and has not been re-requested, or when someone has left a PR comment you have not replied to since. Bots and your own activity never count.
- Lets you mute feedback that needs no response, such as “looks good, but wait for Bob”, from the ⋮ menu on each FEEDBACK pull request. A muted pull request shows as WAITING — or as APPROVED or PART_APPROVED if someone has approved it — until newer feedback arrives or you click Unmute.
- Shows only the newest run of each check and of each workflow, so a cancelled run that a later one replaced does not read as failing.
- Loads the last saved result immediately, then refreshes it from GitHub when the panel opens, every two minutes while its window is visible, and when Refresh is clicked. A refresh fetches full details only for pull requests that have changed since the last one.
- Shows one BB project at a time, choosing among the projects whose origin is on GitHub. Each project's list is saved separately, and Refresh fetches only the selected project's PRs.
- Filters by status, searches by keyword across title, repository, number, branch and status, and sorts by status, creation or last update. The selected project and sort order are remembered between sessions.
- Groups stacked PRs — one whose base branch is another PR's head branch — into a single collapsible unit named after its lowest unmerged PR, top of the stack first, sorted by its most pressing PR. Under a status filter or search, a stack shows only its matching PRs, with a "… N more in this stack" row that brings back the rest.
- Asks what the agent should do when you create a thread, and sends that as the thread's first message. The list stays on screen afterwards, and the PR's row gains an "Open thread" button.
- Finds existing BB threads by remembered PR links or matching project branches.
- Spawns a managed BB worktree/thread on the pull request's own branch when requested, so `git pull` and `git push` work there and BB shows the pull request under the thread. The worktree's branch takes the pull request's branch name. A local branch that already has the name is replaced when it holds no commits of its own; when it does, or is checked out in another worktree, the new branch keeps the name BB gave it: BB then shows no pull request, and pushing needs `git push origin HEAD:<branch>`.
- Starts the thread from a PR-specific Git ref instead, with no upstream, when the pull request comes from a fork or its branch has been deleted.
- Provides cached and explicit-refresh commands through `bb pr-manager list [--repo owner/name] [--json]` and `bb pr-manager refresh [--repo owner/name] [--json]`, which act on the selected project unless `--repo` names another.

Every open PR is listed. The merged-PR window and the number of merged PRs per project are configurable in BB’s plugin settings. A connected machine needs `gh` installed and authenticated.
