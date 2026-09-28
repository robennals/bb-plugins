# Progress Doc

A thread side-panel tab that shows the thread's **progress doc**: a markdown
file the agent keeps up to date as it works, so you can see what it's doing,
what's hard, and what it wants from you without reading the transcript.

## Using it

Open the thread's right-hand panel, choose new tab → Actions → **Progress
doc**. If the thread has no doc yet, the tab offers:

- **Ask the agent to keep a progress doc.** Sends the prompt from settings to
  the thread as an ordinary message, naming a new file
  `~/agent-progress/<thread-title>-<thread-id>.md`. The tab waits for the
  agent to create it.
- **Pick an existing doc** from `~/agent-progress`, newest first — for threads
  already keeping one.
- **Paste a path** to any markdown file, absolute or starting with `~/`.

Once chosen, the tab renders the file and re-reads it every 3 seconds.
**Change file** goes back to the choices.

## Behavior worth knowing

- **One doc per thread.** The choice is stored in the thread's plugin
  metadata, so closing the tab and adding it again shows the same doc.
- **Any markdown file works.** The seven-section structure is only what the
  default prompt suggests; the viewer does not care.
- **The file is read on the thread's machine**, through a host entry, so
  threads on a remote machine show that machine's file. A thread with no
  workspace has no machine, and the tab says so.
- **Polling is cheap when nothing changed.** Each poll sends the modification
  time it already has; an unchanged file comes back without its content.
- **Files over 1 MB are refused** rather than shipped every 3 seconds.
- **Asking the agent is a one-off message.** It is not re-sent after context
  compaction; if the agent stops updating the doc, ask again.

## Settings

- **Prompt** — the message sent by "Ask the agent to keep a progress doc".
  `{{path}}` is replaced with the doc's absolute path and must appear at least
  once.

## Sandboxed agents

Claude Code's sandbox only lets the agent write inside its workspace and a
few temp folders by default, so its writes to `~/agent-progress` can be
refused or prompt every time. Add `~/agent-progress` to the sandbox's writable
paths once (`/sandbox` in Claude Code), or paste a path inside the workspace
instead.

## Development

```sh
npm install          # once
npm test             # vitest: helpers, host file access, backend RPC, panel
npm run typecheck
bb plugin install .
bb plugin dev        # rebuild + reload on save
```
