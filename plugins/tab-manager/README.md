# Tab Manager

Edit the list of tabs in a BB thread's right-hand panel: close them one at a
time, close them in bulk, and reorder them.

BB's tab strip has no close-all or close-to-the-right affordance, and its
context menu is host-rendered chrome with no plugin contribution point. This
plugin adds the behavior on the surfaces plugins *can* reach.

## Surfaces

- **Thread header button** ("Manage panel tabs") — opens a popover listing the
  thread's tabs. Each row moves up or down, closes the tabs below it, or closes
  itself; the footer closes everything.
- **Side-panel action** ("Manage panel tabs") — the same list with more room,
  in the panel's new-tab Actions launcher.
- **Command palette** ("Tabs: manage panel tabs in this thread") — opens the
  side-panel action. A palette `run` is a plain callback with no access to the
  `useRpc` hook, so it opens the manager rather than closing tabs blind.
- **CLI** — `bb tabs list [threadId]` and `bb tabs close-all [threadId]`, both
  defaulting to the calling thread.

## Behavior worth knowing

- **Closing a terminal tab kills its session.** The tab strip entry is the only
  handle you have on that shell, so leaving it running would strand it. If the
  session refuses to die the tabs still close and you get a warning toast.
- **Concurrent edits are refused, not merged.** Every write carries the
  revision it read. If a tab was opened or closed in between, the write is
  rejected and the list redraws with BB's current tabs.
- **Unknown tab kinds survive.** BB does not export its panel-tab union, so
  tabs are kept opaque and round-tripped field-for-field. A tab kind this
  plugin has never heard of still reorders and closes correctly; it just gets a
  generic label.

## Development

```sh
npm install          # once
npm test             # vitest: pure logic, backend RPC + CLI, frontend slots
npm run typecheck
bb plugin install .
bb plugin dev        # rebuild + reload on save
```
