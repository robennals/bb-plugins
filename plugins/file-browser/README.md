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
- **A File / Edit / Diff toggle** per file, which becomes **Preview / Source /
  Edit / Diff** for markdown. A file arriving in the pane lands on the preview when it is
  markdown, else on the diff when the branch changed it, else on the source;
  from then on it keeps the view you picked for as long as that view still
  fits. The diff has a second toggle for inline vs side-by-side, and BB's
  expand-context controls between hunks.
- **Markdown opens as a document**, changed or not: headings, lists, tables,
  links and fenced code rendered with BB's own chat typography, at a capped
  reading width. YAML frontmatter is lifted out of the prose and shown as a
  small metadata block above it, so a skill or agent file reads as the document
  it is rather than opening on a horizontal rule. `.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mkdn` and `.mdx` all get the preview.
- **Edit and save.** The **Edit** view opens a text file in Monaco, the editor
  inside VS Code, coloured with your BB code theme; **Save** (or ⌘S) writes it to the workspace, on whichever machine
  holds it, and **Discard** puts back the last saved text. Unsaved text
  survives a look at the other views. A save is refused
  when the file changed on disk since you opened it — an agent got there first
  — and offers to overwrite or to drop your edit, rather than silently
  replacing the other change. A Windows-style file keeps its line endings.
  Opening another file with unsaved changes asks before discarding them.
- **A changed-files filter** in the explorer toolbar, which narrows the tree to
  what the branch touched, folders opened.
- **Deleted files still appear** in the tree, greyed and struck through, so you
  can read the diff of something the branch removed.
- **⌘P go-to-file**, a search box that prunes the tree, a dotfile toggle, and a
  resizable explorer.
- **It remembers where you were.** Leaving the Files page or closing the thread
  tab and coming back restores the file you had open, the view you were reading
  it in, and the folders you had unfolded, per workspace — so switching between
  two worktrees keeps a separate place in each. The search box is deliberately
  not remembered: it is a way of finding something, not a place to come back to.
- **`bb file-browser`** gives an agent the same two answers from the CLI.

All three viewers are BB's own — the source renderer, the diff renderer and the
chat-message markdown renderer the rest of the app uses — so syntax
highlighting, your BB code theme and the prose typography come from the host
rather than from viewers this plugin would have to maintain.

Two things follow from the preview being the chat renderer: images and links
that point at other files in the workspace are relative to a chat message, not
to the file, so they will not resolve; and MDX's JSX shows up as literal text.
The source view is one click away in both cases.

A file that mixes Windows and Unix line endings cannot be edited — the Edit
view says so — because saving it would rewrite its line endings.

## The editor

Monaco is several megabytes, so it is not part of the plugin's own frontend
bundle. `scripts/build-monaco.mjs` bundles it into `monaco-bundle/` (not
checked in), the server hands those files out through a BB file preview, and
the page loads them the first time an Edit view opens. The server runs the
script itself when the bundle is missing, so the first edit after a fresh
install takes a few seconds longer; `npm run build:monaco` does it ahead of
time. When Monaco cannot be loaded at all, the Edit view falls back to a plain
text box, so a file can still be edited and saved.

Monaco's colouring only: its TypeScript, JSON, CSS and HTML language services
are left out, since they check one file without the project around it and
would underline every import as an error.

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

Per workspace: the open file, the view it was open in, and the unfolded
folders. Globally: the explorer width, the dotfile toggle, the changed-files
filter, and inline vs side-by-side. All of it is browser-local — one
`localStorage` record holding the 24 most recently browsed workspaces, so the
worktrees you have finished with fall off the end rather than accumulating for
ever.

The remembered view stands over the landing rule — coming back to a markdown
file whose source you were reading puts you back on its source rather than on
the preview it would otherwise open in. It is still checked for fit: a
remembered diff of a file that is no longer changed falls back like any other.
A remembered file that has since been deleted opens on the viewer's "could not
read" notice.

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
highlighting, the diff view and the CLI are new here. That plugin's editor is
not carried over. The way Monaco is bundled, served and themed here follows
BB's own built-in File Editor plugin (MIT).

## Install

```sh
bb plugin install git:https://github.com/robennals/bb-plugins.git@main --plugin file-browser
```
