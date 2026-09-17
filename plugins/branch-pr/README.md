# Branch PR

Open the GitHub pull request for a thread's branch as a tab in the thread's
right-hand panel, in one click.

BB already knows which pull request belongs to an environment's branch — this
plugin is the button that acts on it. There is no `gh` plumbing here and no
re-rendering of GitHub's PR page: the tab is BB's own `browser` tab pointed at
`https://github.com/<owner>/<repo>/pull/<n>`, so you get the real conversation,
files, checks and review controls.

## Surfaces

- **Thread header button** ("Open this branch's pull request") — one click,
  answer in a toast.
- **Command palette** ("PR: open this branch's pull request").
- **Side-panel action** ("Open this branch's pull request") in the panel's
  new-tab Actions launcher.

## Behavior worth knowing

- **A failed lookup is never drawn as "no pull request".** BB reports "the
  branch has no PR" and "the lookup could not run" (gh missing, not signed in,
  host unreachable) as different answers, and so does this plugin — the second
  says what went wrong instead.
- **The launcher tab swaps itself out.** A command-palette `run` is a plain
  callback with no way to reach a plugin's RPC; its only power is to open one
  of the plugin's panel tabs. So the palette and the Actions list open a small
  tab that runs the lookup, and on success the server removes that tab and adds
  the browser tab **in the same write** — you end up with one tab, not two. It
  stays put only when there is something to tell you.
- **Pressing again does not duplicate the tab.** The tab id is derived from the
  pull request's url, so a second open recognises the tab it already wrote and
  reports "already open". BB exposes no way to focus an arbitrary panel tab, so
  it does not jump to it.
- **Concurrent edits are retried, then refused.** Every write carries the
  revision it read. If another client changed the tab list in between, the
  write is re-read and retried once; a second rejection fails loudly rather
  than leaving you pressing a dead button.
- **Unknown tab kinds survive.** BB does not export its panel-tab union, so the
  thread's other tabs are kept opaque and round-tripped field-for-field.

## Requirements

A connected BB machine with the GitHub CLI installed and authenticated
(`gh auth login`) — BB's own pull-request lookup uses it.

## Development

```sh
npm install          # once
npm test             # vitest: tab arithmetic, backend RPC, frontend slots
npm run typecheck
bb plugin install .
bb plugin dev        # rebuild + reload on save
```
