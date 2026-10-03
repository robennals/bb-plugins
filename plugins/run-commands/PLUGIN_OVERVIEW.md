Start your dev server — or any other command you run all the time — from the
top of a thread, and watch what it prints without opening a terminal.

## What you get

- A **Run button in the thread header** with a dropdown of your saved commands.
  Pick one and it runs in that thread's workspace.
- A **Command output tab** in the right-hand panel that opens every time you
  run something. Each run gets a collapsible box with its output, live while
  it runs and kept after it finishes, plus a Stop button.
- A **browser tab for what the command serves.** Give a command an address
  such as `http://localhost:3000` and it opens in the side panel once the
  command is up.

## How it works

Each command runs in a bb terminal on the machine that holds the thread's
workspace. The plugin copies what that terminal prints into its own storage
once a second, so the output tab can show it as plain text and keep it after
the command has exited. The list of commands is edited from "Edit commands…"
in the dropdown, or on this plugin's page in Settings, and is shared by every
thread.

## Requirements

A thread with a workspace on a connected machine. Nothing else to install.
