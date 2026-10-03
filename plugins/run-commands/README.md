# Run Commands

A button in the thread header that runs one of your saved commands — typically
"start the dev server" — in the thread's workspace, and a "Command output" tab
in the right-hand panel that shows what each run printed.

## Surfaces

- **Thread header button** ("Run a command") — a dropdown of the saved
  commands, then "Show output" and "Edit commands…". Picking a command runs it
  and brings up the output tab.
- **Command output tab** — one collapsible box per run, newest first and open,
  older ones closed. Each shows the command's status (running, finished,
  failed with its exit code, stopped) and a Stop button while it runs. Also in
  the panel's Actions list.
- **Settings section** ("Commands") on the plugin's page in Settings — the same
  editor the dropdown opens.

## A saved command

| Field | Meaning |
| --- | --- |
| Name | What the dropdown and the output box call it. |
| Command | A shell command line, run in the thread's workspace. |
| Address to open | Optional `http(s)` address, opened as a browser tab once the command is up. |

## Behavior worth knowing

- **Commands run in bb terminals nobody looks at.** A terminal is what puts
  the process on the machine that holds the workspace. A background loop
  copies what it prints into the plugin's storage once a second and tells the
  output tab, which fetches only the part it does not have yet.
- **The output is plain text.** Colour and cursor codes are dropped, and a line
  redrawn with carriage returns (a progress bar) shows only its last state.
  The output tab is read-only.
- **Output outlives the command.** When a command exits, its exit code is
  recorded and its terminal closed. Each run keeps its newest 40,000
  characters; the 20 newest runs per thread are kept, and "Clear finished"
  forgets the finished ones sooner.
- **Running a command that is still running restarts it.** The old run is
  stopped and keeps its output, and a new run starts — so a second click on a
  dev server never leaves two fighting over one port.
- **The address opens when the command prints it.** It opens once its host and
  port (for example `localhost:3000`) appear in the output. If they never do,
  it opens after 30 seconds anyway. It does not open for a command that exited
  with an error, or one that was stopped first.
- **Following survives a plugin reload.** Runs are stored, not held in memory,
  so a reloaded plugin carries on copying output where it left off.
- **The list is shared by every project and thread.** It lives in the plugin's
  own storage, not in any repository.

## Development

```sh
npm install --include=dev   # once
npm test                    # vitest: text handling, run storage, backend RPC, frontend slots
npm run typecheck
bb plugin install .
bb plugin dev               # rebuild + reload on save
```
