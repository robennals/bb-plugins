# Design notes: one thread per review

Why the surfaces are arranged the way they are. Reading the code tells you
what it does; two of these choices look arbitrary until you know what was
ruled out.

## The shape

A review is an ordinary BB thread. The plugin contributes:

| Surface | Slot | Holds |
| --- | --- | --- |
| Code Review | `navPanel` | The PR inbox. One sidebar row for the plugin, not one per review. |
| Findings | `threadPanelAction` | A review's issue list and issue detail. |
| Header control | `experimental_threadHeaderAction` | The open-issue count — and the auto-open (below). |

Before this, every review was a route inside the one nav panel
(`/plugins/code-review/code-review/pr/<owner>/<repo>/<n>`). All reviews shared
one sidebar entry and one history stack, two could not be open at once, and a
running review was invisible unless you went looking. Making the thread the
review's home fixes all three for free, because BB already gives threads a
sidebar row, a title, unread state, and split placement.

## Why the header control exists

**It is the auto-open mechanism, not a nicer button.** Landing on a review
thread with the panel shut, needing a click to see the issues, is worse than
the dedicated screen it replaced — so something has to open the panel on
arrival.

`useBbNavigate().openThreadPanel` is the documented way to do that, and it
only works from a component mounted on the thread route. The header action's
component is mounted on *every* thread, which makes it the plugin's one
reliable foothold there. So it renders `null` on anything that is not a
review, and on a review it opens the Findings tab once on mount and shows the
count.

### Why the server does not seed the tab instead

`bb.sdk.threads.tabs.update` accepts a `plugin-panel` tab
(`{ id, kind: "plugin-panel", pluginId, actionId, title, paramsJson }`), so the
server could attach the Findings tab at spawn time and make it durable. That
was the original plan, and it was dropped for two reasons found while building
it:

1. **The tab id is not part of the contract.** The app computes it as
   `["plugin-panel", encodeURIComponent(`${pluginId}:${actionId}:${paramsJson ?? ""}`),
   encodeURIComponent("none")].join(":")` — read out of the minified renderer
   bundle, not documented anywhere. Writing that format server-side means a
   duplicate tab the day it changes.
2. **It would not have opened the panel anyway.** In the same bundle, panel
   layout — `{ tabs, activeTabId, isOpen }` — is per-client state keyed by
   thread whose constructed default is `{ tabs: [], activeTabId: null,
   isOpen: false }`. `isOpen` does not exist in the server-side tabs schema,
   the one reconcile function touching both only ever *closes* the panel, and
   there is a deliberate "add this tab without changing `isOpen`" reducer
   beside the "add and open" one. A server-written tab shows in the strip; it
   does not force the panel open.

So durability was buying an undocumented id format, and the thing that
actually matters — the panel being open — needed the client call regardless.
The header control does both.

## Why discussing an issue is a composer quote

The thread already *is* the conversation. A second `ThreadChat` in the same
thread's side panel would be a copy of the surface it sits inside, and a child
thread per issue (what this used to do) fragments one review into a dozen
conversations with no shared context.

So **Ask about this** calls `useComposer().addQuote(...)` — BB's own "reference
this selection in chat" primitive, which also focuses the composer — and leaves
the question to be typed. Nothing is spawned or persisted. This deleted
`discussFinding`, `buildDiscussionPrompt`, and the child-thread bookkeeping.
`findings.discussion_thread_id` is still on the table, unread, because
`bb.storage.migrate` applies statements by index and the `CREATE TABLE` that
made it cannot be rewritten.

## Why the agent gets tools rather than more CLI

`bb.agents.configure` returns `{ tools, skills, instructions }` per thread, so
the review thread's agent gets the `code_review_*` tools and the `pr-review`
skill and no other thread does. Native tools beat more `bb code-review`
subcommands here because the operations are small and typed, and because the
tools and the panel go through the same server functions — so an agent
dismissing an issue reaches the open tab over the existing
`code-review-changed` realtime signal, with no new plumbing.

Two things to know:

- **The selection fails closed as a unit.** An unknown skill or tool name
  rejects the whole selection, tools included. `server.test.ts` declares
  `agentSkillIds: ["pr-review"]` for that reason — without it the tools test
  fails with an empty tool list and no other explanation.
- **Tools are scoped by the calling thread, never by a review id parameter.**
  `reviewOfThread(ctx.threadId)` is the only way in, so an agent cannot reach
  another pull request's issues even with a valid id from one.

There is deliberately no tool that posts to GitHub. That invariant is the whole
premise of the plugin, and it is stated in the tool descriptions, the dynamic
instructions, the review prompt, and the skill.

## What was given up

- **Browser back no longer steps issue → list.** A panel tab has no route
  segment, so the tab's navigation is `useState` and the view's own back button
  is the only back. This is the one real regression from `toPluginPanel`'s
  panel-internal history.
- **Pressing a PR row with no review starts an agent.** The row says *Review*
  precisely so the click's meaning is visible before it happens.
