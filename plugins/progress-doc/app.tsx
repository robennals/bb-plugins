// bb-plugin-progress-doc — frontend.
//
// One panel tab. With no doc chosen for the thread it offers three ways to get
// one; with a doc chosen it renders it and polls for changes, sending the
// modification time it already has so an unchanged file costs no content.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Markdown, definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { knownMtime, nextView, type DocView } from "./lib/view";
import {
  PANEL_ACTION_ID,
  type ChosenResult,
  type ListFilesResult,
  type LoadResult,
  type rpcContract,
} from "./rpc";

const POLL_MS = 3000;
const ICON = "FileText";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

type Choice =
  | { kind: "loading" }
  | { kind: "unchosen" }
  | { kind: "no-machine" }
  | { kind: "chosen"; docPath: string; askedAgent: boolean };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The thread's choice and its doc, re-read every few seconds. */
function useProgressDoc(rpc: Rpc, threadId: string) {
  const [choice, setChoice] = useState<Choice>({ kind: "loading" });
  const [view, setView] = useState<DocView>({ kind: "loading" });
  const viewRef = useRef<DocView>(view);
  const docPathRef = useRef<string | null>(null);

  const apply = useCallback((result: LoadResult) => {
    if (result.kind !== "chosen") {
      docPathRef.current = null;
      setChoice(result);
      return;
    }
    // A different file than last time: what we held belongs to the old one.
    const previous = docPathRef.current === result.docPath ? viewRef.current : { kind: "loading" as const };
    docPathRef.current = result.docPath;
    viewRef.current = nextView(previous, result.doc);
    setView(viewRef.current);
    setChoice({ kind: "chosen", docPath: result.docPath, askedAgent: result.askedAgent });
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await rpc.call("load", { threadId, knownMtimeMs: knownMtime(viewRef.current) }));
    } catch (cause) {
      viewRef.current = { kind: "error", message: messageOf(cause) };
      setView(viewRef.current);
    }
  }, [apply, rpc, threadId]);

  /** Drop what we hold and re-read, after the choice itself changed. */
  const reset = useCallback(() => {
    docPathRef.current = null;
    viewRef.current = { kind: "loading" };
    setView(viewRef.current);
    setChoice({ kind: "loading" });
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { choice, view, reset };
}

function Chooser({ rpc, threadId, onChosen }: { rpc: Rpc; threadId: string; onChosen: () => void }) {
  const [files, setFiles] = useState<ListFilesResult | null>(null);
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("listFiles", { threadId }).then(setFiles, (cause) =>
      setFiles({ kind: "error", message: messageOf(cause) }),
    );
  }, [rpc, threadId]);

  async function settle(request: Promise<ChosenResult>) {
    setPending(true);
    setError(null);
    try {
      const result = await request;
      if (result.ok) onChosen();
      else setError(result.message);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const choose = (chosenPath: string) => settle(rpc.call("choosePath", { threadId, path: chosenPath }));

  function submit(event: FormEvent) {
    event.preventDefault();
    void choose(path);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col items-start gap-2">
        <h2 className="text-sm font-medium">Ask the agent</h2>
        <p className="text-sm text-muted-foreground">
          Sends the prompt from this plugin's settings, asking the agent to keep a progress doc as it
          works.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void settle(rpc.call("askAgent", { threadId }))}
        >
          <Icon name={ICON} className="size-4" />
          Ask the agent to keep a progress doc
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Pick an existing doc</h2>
        <FileList files={files} disabled={pending} onPick={(filePath) => void choose(filePath)} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Or paste a path</h2>
        <form className="flex gap-2" onSubmit={submit}>
          <Input
            aria-label="Path to a markdown file"
            placeholder="~/agent-progress/my-work.md"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={pending}>
            Open
          </Button>
        </form>
      </section>

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function FileList({
  files,
  disabled,
  onPick,
}: {
  files: ListFilesResult | null;
  disabled: boolean;
  onPick: (path: string) => void;
}) {
  if (files === null) return <p className="text-sm text-muted-foreground">Looking for docs…</p>;
  if (files.kind === "error") {
    return <p className="text-sm text-destructive">Could not list docs: {files.message}</p>;
  }
  if (files.kind === "missing" || files.files.length === 0) {
    return <p className="text-sm text-muted-foreground">No docs in {files.dir} yet.</p>;
  }
  return (
    <ul className="flex flex-col">
      {files.files.map((file) => (
        <li key={file.path} title={file.path}>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-mono text-xs"
            disabled={disabled}
            onClick={() => onPick(file.path)}
          >
            {file.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function DocBody({ view, askedAgent }: { view: DocView; askedAgent: boolean }) {
  switch (view.kind) {
    case "loading":
      return <p className="text-sm text-muted-foreground">Loading…</p>;
    case "content":
      return <Markdown content={view.content} />;
    case "missing":
      return (
        <p className="text-sm text-muted-foreground">
          {askedAgent
            ? "Waiting for the agent to create this file. It will appear here once it does."
            : "This file doesn't exist. Change file to pick another."}
        </p>
      );
    case "too-large":
      return (
        <p className="text-sm text-destructive">
          This file is {Math.round(view.bytes / 1024)} KB, too large to show here (the limit is 1 MB).
        </p>
      );
    case "not-a-file":
      return <p className="text-sm text-destructive">This path is a folder, not a file.</p>;
    case "error":
      return <p className="text-sm text-destructive">Could not read the doc: {view.message}</p>;
  }
}

function ProgressDocPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { choice, view, reset } = useProgressDoc(rpc, threadId);

  switch (choice.kind) {
    case "loading":
      return <p className="text-sm text-muted-foreground">Loading…</p>;
    case "no-machine":
      return (
        <p className="text-sm text-muted-foreground">
          This thread has no workspace yet, so there is no machine to read a progress doc from.
        </p>
      );
    case "unchosen":
      return <Chooser rpc={rpc} threadId={threadId} onChosen={reset} />;
    case "chosen":
      return (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2 border-b pb-2">
            <span className="truncate font-mono text-xs text-muted-foreground" title={choice.docPath}>
              {choice.docPath}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                rpc.call("forget", { threadId }).then(reset, reset);
              }}
            >
              Change file
            </Button>
          </div>
          <DocBody view={view} askedAgent={choice.askedAgent} />
        </div>
      );
  }
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Progress doc",
    icon: ICON,
    layout: "padded",
    component: ({ threadId }) => <ProgressDocPanel threadId={threadId} />,
  });
});
