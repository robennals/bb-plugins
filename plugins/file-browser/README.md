# file-browser

Browse every file in a workspace, see at a glance what the current branch
changed, and read any file as source, as formatted markdown, or as a diff
against the commit the branch forked from.

## What it gives you

- **A Files page in the sidebar** (`/plugins/file-browser/files`) with a
  workspace picker covering every project checkout and every thread worktree,
  and **a Files tab beside a thread** (right panel → new tab → *Project files*)
  pinned to that thread's workspace.
- **Changed files are coloured in the tree** — green for added and untracked,
  amber for modified and renamed, red and struck through for deleted, with
  git's own one-letter badge on the right. A folder gets a dot when anything
  beneath it changed, at any depth, so a collapsed tree still shows where the
  work is. The colours are BB's own diff theme tokens, so the tree agrees with
  the diff beside it in light and dark.
- **A File / Diff toggle** per file, which becomes **Preview / Source / Diff**
  for markdown. A file arriving in the pane lands on the diff when the branch
  changed it, else on the preview when it is markdown, else on the source; from
  then on it keeps the view you picked for as long as that view still fits. The
  diff has a second toggle for inline vs side-by-side, and BB's expand-context
  controls between hunks.
- **Markdown reads as a document**, not as source: headings, lists, tables,
  links and fenced code rendered with BB's own chat typography, at a capped
  reading width. YAML frontmatter is lifted out of the prose and shown as a
  small metadata block above it, so a skill or agent file reads as the document
  it is rather than opening on a horizontal rule. `.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mkdn` and `.mdx` all get the preview.
- **A changed-files filter** in the explorer toolbar, which narrows the tree to
  what the branch touched, folders opened.
- **Deleted files still appear** in the tree, greyed and struck through, so you
  can read the diff of something the branch removed.
- **⌘P go-to-file**, a search box that prunes the tree, a dotfile toggle, and a
  resizable explorer.
- **It remembers where you were.** Leaving the Files page or closing the thread
  tab and coming back restores the file you had open and the folders you had
  unfolded, per workspace — so switching between two worktrees keeps a separate
  place in each. The search box is deliberately not remembered: it is a way of
  finding something, not a place to come back to.
- **`bb file-browser`** gives an agent the same two answers from the CLI.

All three viewers are BB's own — the source renderer, the diff renderer and the
chat-message markdown renderer the rest of the app uses — so syntax
highlighting, your BB code theme and the prose typography come from the host
rather than from viewers this plugin would have to maintain.

Two things follow from the preview being the chat renderer: images and links
that point at other files in the workspace are relative to a chat message, not
to the file, so they will not resolve; and MDX's JSX shows up as literal text.
The source view is one click away in both cases.

## What "changed" means

The fork point, not the branch tip: `git merge-base HEAD <base>`, where `<base>`
is `origin/HEAD` when the clone has it, and otherwise the first of
`origin/main`, `origin/master`, `origin/develop`, `main`, `master` that exists.
Commits that landed on the base branch after you forked are therefore **not**
reported as changes to your branch.

The comparison is against the **working tree**, not `HEAD`: uncommitted edits
and untracked files count as changed too, which is usually what you want when
an agent is part-way through a task.

Git runs on the machine holding the workspace, not on the machine running BB's
server, so this works on a connected machine's checkout. A workspace that is
not a git repository still browses; the explorer says why nothing is
highlighted.

## The CLI

```
bb file-browser changes          # what this branch changed, and against what
bb file-browser diff <path>      # one file's patch against the fork point
```

Both resolve against the thread the command runs in — its worktree when it has
one, otherwise the project's default checkout.

## Settings

**Excluded directories** — one name per line, matched against any path segment.
Defaults to `.git`, `node_modules`, and `vendor`. Applies to the tree, the
palette, and the CLI.

**Branch to diff against** — blank detects the default branch as described
above. Set it to `develop`, `trunk`, or whatever your repository uses when
detection gets it wrong; a name that does not exist is reported rather than
silently replaced.

## What is remembered, and where

Per workspace: the open file and the unfolded folders. Globally: the explorer
width, the dotfile toggle, the changed-files filter, and inline vs
side-by-side. All of it is browser-local — one `localStorage` record holding
the 24 most recently browsed workspaces, so the worktrees you have finished
with fall off the end rather than accumulating for ever.

The view mode is *not* remembered; each file lands on its preferred view as
described above. A remembered file that has since been deleted opens on the
viewer's "could not read" notice.

## Dotfiles

BB's own recursive listing drops every name starting with `.`. For a workspace
on the machine BB's server runs on, this plugin walks the directory itself and
shows them; the eye toggle turns them off. A workspace on a *connected* machine
has to go through BB's listing, so dotfiles are not available there and the
toggle is hidden.

## Credit

The workspace walk, path resolution, tree model, routing, and the explorer,
quick-open and workspace-picker components are derived from
[bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor)
by AbdElrahman Telb, under the MIT licence. The git comparison, the change
highlighting, the diff view and the CLI are new here, and the editor is not
carried over — this is a viewer.

## Install

```sh
bb plugin install git:https://github.com/robennals/bb-plugins.git@main --plugin file-browser
```
