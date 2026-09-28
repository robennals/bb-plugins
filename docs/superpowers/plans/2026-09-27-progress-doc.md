# Progress Doc Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `progress-doc` BB plugin whose thread panel tab shows one markdown
file per thread, and can ask the agent to start keeping one.

**Architecture:** A host entry on the workspace's machine expands `~`, lists
markdown files and reads one file. The server turns panel RPCs into host calls,
stores the chosen path in thread plugin metadata, and sends the prompt with
`threads.send`. The panel polls the server every 3 s.

**Tech Stack:** TypeScript, React 19, zod 4, `@get-bb/plugin-sdk` 0.5.9,
vitest 3 (+ jsdom, Testing Library).

**Spec:** `docs/superpowers/specs/2026-09-27-progress-doc-design.md`

## Global Constraints

- Plugin directory `plugins/progress-doc`, indexed in `.bb/plugins.json`, listed in the root README.
- Engines: `bb >=0.43`, `bbPluginSdk >=0.5.9`.
- Default doc directory: `~/agent-progress`; file name `<title-slug>-<threadId>.md`.
- Max readable doc size: 1 MB (1,048,576 bytes).
- Poll interval: 3000 ms.
- The `prompt` setting must contain `{{path}}`.
- Metadata namespace value: `{ docPath: string, askedAgent: boolean }`.

## Review Focus

1. **A pasted path with surrounding whitespace or quotes** (copied from a terminal) should still open the file → `lib/paths.test.ts` "trims whitespace and matching quotes".
2. **A relative path** (`notes.md`) has no defined base, so it should be refused with a clear message rather than resolved against some directory → `lib/paths.test.ts` "rejects relative paths".
3. **A thread title that is empty, all emoji, or very long** should still give a valid, bounded file name → `lib/naming.test.ts`.
4. **Metadata written by someone else in a bad shape** (`docPath: 42`, a relative path) should read as "no doc chosen", not crash the tab → `server.test.ts` "treats malformed metadata as unchosen".
5. **The file is replaced while the tab is showing it** (same content, new mtime, or it is deleted) → `lib/view.test.ts` keeps the last content on `unchanged` and shows missing on `missing`.

---

### Task 1: Pure helpers (`lib/`)

**Files:**
- Create: `plugins/progress-doc/lib/paths.ts`, `lib/naming.ts`, `lib/prompt.ts`, `lib/view.ts`
- Test: matching `lib/*.test.ts`

**Interfaces (Produces):**
- `parsePathInput(raw: string): { ok: true; path: string } | { ok: false; reason: string }` — trims whitespace and one pair of matching quotes; accepts `~`, `~/…`, or absolute; rejects empty and relative.
- `expandHome(path: string, home: string): string` — `~` → home, `~/x` → `home/x`, else unchanged; result normalized with `path.posix.normalize` on POSIX.
- `sortNewestFirst<T extends { mtimeMs: number; name: string }>(files: T[]): T[]` — mtime desc, then name asc.
- `DOC_DIRECTORY = "~/agent-progress"`; `docFileName(title: string | null, threadId: string): string` — slug of title (lowercase, `[a-z0-9]+` joined by `-`, max 60 chars, trimmed dashes), fallback `thread`, then `-${threadId}.md`.
- `PATH_PLACEHOLDER = "{{path}}"`; `DEFAULT_PROMPT: string`; `fillPrompt(template: string, path: string): string` (replaces every occurrence).
- `type DocRead = {kind:"content";content:string;mtimeMs:number} | {kind:"unchanged"} | {kind:"missing"} | {kind:"too-large";bytes:number} | {kind:"not-a-file"} | {kind:"error";message:string}`
- `type DocView = {kind:"loading"} | {kind:"content";content:string;mtimeMs:number} | Exclude<DocRead, {kind:"content"}|{kind:"unchanged"}>`
- `nextView(prev: DocView, read: DocRead): DocView` — `unchanged` keeps `prev` (or `loading` when prev had no content); everything else replaces it.
- `knownMtime(view: DocView): number | null`.

- [ ] Write tests covering each bullet above plus Review Focus 1–3 and 5.
- [ ] Run `npx vitest run lib` → fail (modules missing).
- [ ] Implement.
- [ ] Run `npx vitest run lib` → pass.
- [ ] Commit "Add progress-doc path, naming, prompt and view helpers".

### Task 2: Host entry (`contract.ts`, `host.ts`)

**Files:** Create `contract.ts`, `host.ts`; test `host.test.ts` (runs handlers against a temp dir).

**Interfaces (Produces):** `hostContract` with:
- `resolvePath({ path: string })` → `{ path: string }` (expands `~` with `os.homedir()`; input is already validated `~`/absolute).
- `listMarkdown({ dir: string })` → `{ kind: "ok"; dir: string; files: {path,name,mtimeMs}[] } | { kind: "missing"; dir: string }` — only `*.md`/`*.markdown` regular files, newest first.
- `readDoc({ path: string; knownMtimeMs: number | null })` → `DocRead` minus `error` (1 MB cap; `unchanged` when mtime equals known).
- Handlers exported as plain functions `resolvePath`, `listMarkdown`, `readDoc` taking a `home` argument, so tests pass a temp dir; `host.ts` default-exports `experimental_defineHostEntry` wiring them with `os.homedir()`.

- [ ] Tests: list ignores non-markdown and directories, sorts newest first, missing dir → `missing`; read → content, unchanged, missing, too-large, directory → `not-a-file`; resolve expands `~`.
- [ ] Fail → implement → pass → commit "Add progress-doc host entry".

### Task 3: Server (`server.ts`)

**Interfaces:** Consumes Task 1 and 2. Produces `rpcContract`:
- `load({ threadId, knownMtimeMs: number|null })` → `{kind:"unchosen"} | {kind:"no-machine"} | {kind:"chosen"; docPath; askedAgent; doc: DocRead}`
- `listFiles({ threadId })` → `{kind:"ok";dir;files} | {kind:"missing";dir} | {kind:"error";message}`
- `choosePath({ threadId, path })` → `{ok:true;docPath} | {ok:false;message}`
- `askAgent({ threadId })` → `{ok:true;docPath} | {ok:false;message}`
- `forget({ threadId })` → `{ok:true}`
- Setting `prompt` (multiline, default `DEFAULT_PROMPT`, schema requires `{{path}}`).

Machine resolution: `threads.get` → `environmentId` (null → no machine) → `environments.get` → `hostId`. Host call failures become `{kind:"error"}` / `{ok:false}` with the message.

`askAgent`: resolve `DOC_DIRECTORY/docFileName(title ?? titleFallback, threadId)` on the host, `threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] })`, then record metadata `{docPath, askedAgent:true}`. If send fails nothing is recorded.

- [ ] Tests with `createFakePluginHost` + `experimental_callHostRpc`: unchosen; malformed metadata (Review Focus 4); chosen reads via host with known mtime; no environment → no-machine; choosePath validates and stores `askedAgent:false`; choosePath rejects relative; askAgent sends filled prompt and records; askAgent send failure records nothing; custom prompt setting used; forget removes key; listFiles passes `~/agent-progress`.
- [ ] Fail → implement → pass → commit "Add progress-doc server".

### Task 4: Panel (`app.tsx`)

**Interfaces:** Consumes `rpcContract` type. Registers `threadPanelAction { id: "progress-doc", title: "Progress doc", icon: "FileText", layout: "padded", component }`.

- Unchosen → chooser: "Ask the agent to keep one" button; list of files from `listFiles` (buttons, name + relative time omitted, name only); paste-path form.
- Chosen → header (path, Change file) + body by `DocView`: content → `<Markdown>`; missing → waiting text if `askedAgent` else "not found"; too-large/not-a-file/error → message.
- Polls `load` every 3000 ms with `knownMtime(view)`; clears the timer on unmount.

- [ ] Tests (`app.test.tsx`, jsdom, `loadPluginApp`/`renderSlot`, fake timers not needed — assert first load): chooser shows files; clicking a file calls `choosePath`; paste form calls `choosePath` with typed text; ask button calls `askAgent`; chosen content renders markdown text; missing + askedAgent shows waiting text; Change file calls `forget`.
- [ ] Fail → implement → pass → commit "Add progress-doc panel".

### Task 5: Package, docs, index, live check

**Files:** `package.json` (name, description, host entry, scripts, icon), `tsconfig.json` includes, `vitest.config.ts`, `README.md`, `PLUGIN_OVERVIEW.md`, delete scaffold example skill, `.bb/plugins.json`, root `README.md`.

- [ ] `npm run typecheck`, `npm test`, `bb plugin build` all clean.
- [ ] `bb plugin install path:<repo> --plugin progress-doc`; confirm `bb plugin list` shows it running.
- [ ] Commit "Add a progress-doc plugin".
