# Progress doc plugin — design

**Summary.** A `progress-doc` plugin adds a **Progress doc** entry to a thread's
right-panel Actions list. The tab it opens shows one markdown file for that
thread, re-reading it as it changes. If the thread has no doc yet, the tab
offers three ways to get one: ask the agent to start keeping one, pick an
existing file from `~/agent-progress`, or paste a path.

## Intent

Long-running agent threads should keep moving without blocking on the human,
while leaving a doc the human can skim at any time: what's in flight, what's
hard, what's done, what the agent wants to ask, and which decisions it made on
the human's behalf. The plugin is the viewer plus an optional one-click way to
ask the agent to keep such a doc. Some threads already keep one, so asking the
agent is optional, and the viewer shows any markdown file, not only ones in
the suggested format.

## User flow

- **Open the tab.** Right panel → new tab → Actions → **Progress doc**.
- **No doc chosen yet.** The tab shows three choices:
  - **Ask the agent.** The plugin names a file
    `~/agent-progress/<thread-title-slug>-<threadId>.md`, fills that absolute
    path into the prompt from settings, sends the prompt to the thread as an
    ordinary message, and records the path. Until the file exists the tab
    says it is waiting for the agent to create it.
  - **Pick a file.** Markdown files in `~/agent-progress`, newest first.
  - **Paste a path.** Absolute, or starting with `~/`.
- **Doc chosen.** The tab renders the file with BB's own `Markdown` component,
  under a header that shows the path and a **Change file** button. Change file
  forgets the choice and shows the three choices again.
- **Live updates.** While the tab is mounted it asks for the file every 3
  seconds, passing the last modification time it saw, so an unchanged file
  costs no content transfer.

## Components

- **`app.tsx`** — the `threadPanelAction` registration and its React panel:
  chooser, viewer, polling.
- **`server.ts`** — the RPC surface the panel calls. It resolves the thread's
  machine, reads and writes the thread's plugin metadata, builds the prompt,
  and sends it with `threads.send`.
- **`host.ts` + `contract.ts`** — a host entry that runs on the machine
  holding the thread's workspace. It expands `~`, lists a directory's markdown
  files, and reads one file (capped at 1 MB). The file lives on that machine,
  which is not always the machine BB's server runs on.
- **`lib/`** — pure helpers with unit tests: file naming, prompt substitution,
  path parsing, listing order.

## State

- **One progress doc per thread**, stored as `{ docPath }` in the thread's
  metadata namespace for this plugin. A panel tab's params are fixed when it
  opens, so they cannot hold a choice made inside the tab. Metadata also means
  re-adding the tab shows the same doc.
- Metadata is writable by anyone, including the thread's own agent, so the
  server validates it (a non-empty absolute path) before use. The worst a bad
  value can do is display a different file on the user's own machine.

## Settings

- **`prompt`** (multi-line string). Must contain `{{path}}`; every occurrence
  is replaced with the doc's absolute path. The default asks the agent to keep
  the doc with these sections: Active PRs, Things that are hard, Progress, Spec
  links, Open Questions, Notable Decisions, Archive. It also tells the agent to
  keep working rather than block, stop only for a question it truly needs the
  human for, and move items into Archive once the human says they've reviewed
  them.

## Errors

- **Thread has no workspace:** the tab says there is no machine to read from.
- **File missing:** after Ask the agent, "waiting for the agent to create it";
  otherwise "file not found", with Change file available.
- **File over 1 MB, or unreadable:** the tab says so, naming the path.
- **Host unreachable:** the error is shown, and polling keeps retrying.

## Testing

- Unit tests for `lib/` helpers.
- Server tests with `createFakePluginHost` and a fake host client.
- Panel tests with `loadPluginApp` / `renderSlot`.
- A live check: build, install, open the tab in a real thread.

## Decisions

1. **The plugin tab renders the markdown itself.** The alternative was swapping
   in BB's built-in `host-file-preview` tab. Rejected because the chooser, the
   Change file button and the waiting state have to share one tab, and it is
   not confirmed the built-in preview refreshes on change.
2. **Poll every 3 s instead of a native file watcher.** A watcher updates
   instantly but needs a host signal, a server relay and a realtime channel.
   It can be added later without changing the UI.
3. **Kickoff message only, no standing per-thread instructions.** Asking is
   optional and the prompt is customisable. The cost is that after context
   compaction the agent may forget, and the user asks again.
4. **The agent creates the file; the plugin writes no template.** The
   suggested structure lives in one place: the prompt setting.
5. **The `~/agent-progress` sandbox restriction is documented, not worked
   around.** Claude Code's sandbox does not allow writes there by default. The
   README says to add it to the sandbox write allowlist once.
