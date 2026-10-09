import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown as BbMarkdown,
  experimental_Diff as BbDiff,
  experimental_SourceCode as BbSourceCode,
  useRpc,
  type DiffViewMode,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ChangedPath } from "../contract.js";
import type { ScopeRef } from "@/lib/route";
import { lineEndingOf, withLineEnding, type LineEnding } from "@/lib/line-endings";
import { splitFrontmatter } from "@/lib/markdown";
import type { ViewMode } from "@/lib/view-mode";
import type { rpcContract } from "../server.js";
import { Editor } from "./Editor";

type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: string; sha256: string }
  | { status: "image"; dataUrl: string }
  | { status: "binary"; reason: string };

type DiffState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "unchanged" }
  | { status: "binary" }
  | {
      status: "patch";
      patch: string;
      oldContent: string | null;
      newContent: string | null;
      oldPath: string;
      newPath: string;
    };

/** The edit view's text. It outlives a trip to the other views. */
interface Draft {
  /** The editor's text, whose line breaks are all `\n`. */
  text: string;
  /** The editor's text as of the last save, for telling whether there is anything to save. */
  savedText: string;
  /**
   * The hash of the file this edit was made against. Held here, not read from
   * the latest fetch: the pane re-reads the file when it comes back from the
   * diff, and checking a save against THAT hash would overwrite whatever
   * changed on disk while the edit was open.
   */
  baseSha256: string;
  lineEnding: LineEnding;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  /** The file is no longer the one the edit started from; null = deleted. */
  | { status: "conflict"; currentSha256: string | null };

export interface ViewerProps {
  scope: ScopeRef;
  path: string;
  mode: ViewMode;
  diffView: DiffViewMode;
  /** Wrap long lines instead of scrolling sideways; not used by the preview. */
  wrapLines: boolean;
  /** The file's standing on this branch; null when git reported no change. */
  change: ChangedPath | null;
  baseCommit: string | null;
  /** Called after a save, so the tree can re-ask git what changed. */
  onSaved: () => void;
  /** Whether the pane holds an edit that has not been saved. */
  onUnsavedChange: (hasUnsaved: boolean) => void;
}

/**
 * The file pane. All three renderers are BB's own — the source viewer, the diff
 * viewer, and the chat-message markdown renderer the rest of the app uses — so
 * highlighting, the code theme, the diff's expand-context controls and the
 * prose typography come for free and stay consistent with it.
 */
export function Viewer({
  scope,
  path,
  mode,
  diffView,
  wrapLines,
  change,
  baseCommit,
  onSaved,
  onUnsavedChange,
}: ViewerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { file, setSavedText, reload } = useFileContents(
    scope,
    path,
    mode !== "diff",
  );
  const diff = useDiff(scope, path, change, baseCommit, mode === "diff");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const hasUnsaved = draft !== null && draft.text !== draft.savedText;

  useEffect(() => {
    onUnsavedChange(hasUnsaved);
  }, [hasUnsaved, onUnsavedChange]);
  // The pane is remounted per file, so going away is the edit going away.
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange]);

  // Closing the tab or reloading the app would drop the edit without a word.
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved]);

  const lineEnding = file.status === "text" ? lineEndingOf(file.content) : null;

  // The edit view starts from the file as read. A draft with nothing unsaved
  // follows the file when a re-read finds it changed; one with unsaved changes
  // is left alone, and the save's hash check is what notices the difference.
  useEffect(() => {
    if (mode !== "edit" || file.status !== "text") return;
    if (lineEnding === null || lineEnding === "mixed") return;
    if (draft !== null && (hasUnsaved || draft.baseSha256 === file.sha256)) return;
    const text = file.content.replace(/\r\n/g, "\n");
    setDraft({ text, savedText: text, baseSha256: file.sha256, lineEnding });
    setSave({ status: "idle" });
  }, [draft, file, hasUnsaved, lineEnding, mode]);

  /** `expectedSha256` is what the file must still be for the save to go ahead. */
  const saveDraft = useCallback(
    (editing: Draft, expectedSha256: string | null) => {
      const content = withLineEnding(editing.text, editing.lineEnding);
      setSave({ status: "saving" });
      void rpc
        .call("write", { scope, path, content, expectedSha256 })
        .then((result) => {
          if (result.kind === "conflict") {
            setSave({ status: "conflict", currentSha256: result.currentSha256 });
            return;
          }
          setSave({ status: "idle" });
          // Typing can carry on while the save is in flight, so only the text
          // that was sent is marked saved.
          setDraft((current) =>
            current === null
              ? null
              : { ...current, savedText: editing.text, baseSha256: result.sha256 },
          );
          setSavedText(content, result.sha256);
          onSaved();
        })
        .catch((error: unknown) => {
          setSave({ status: "idle" });
          toast.error(`Could not save ${path}: ${describe(error)}`);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSaved, path, rpc, scope.kind, scope.id, setSavedText],
  );

  if (mode === "edit" && draft !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
          {save.status === "conflict" ? (
            <>
              <span className="min-w-0 flex-1 truncate text-destructive-text">
                {save.currentSha256 === null
                  ? "This file was deleted while you were editing it."
                  : "This file changed on disk while you were editing it."}
              </span>
              <EditButton
                label="Discard my edit"
                onClick={() => {
                  setDraft(null);
                  setSave({ status: "idle" });
                  reload();
                }}
              />
              <EditButton
                label={save.currentSha256 === null ? "Save anyway" : "Overwrite"}
                isPrimary
                onClick={() => saveDraft(draft, save.currentSha256)}
              />
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {save.status === "saving"
                  ? "Saving…"
                  : hasUnsaved
                    ? "Unsaved changes"
                    : "No unsaved changes"}
              </span>
              <EditButton
                label="Discard"
                isDisabled={!hasUnsaved || save.status === "saving"}
                onClick={() =>
                  setDraft((current) =>
                    current === null ? null : { ...current, text: current.savedText },
                  )
                }
              />
              <EditButton
                label="Save"
                title="Save (⌘S)"
                isPrimary
                isDisabled={!hasUnsaved || save.status === "saving"}
                onClick={() => saveDraft(draft, draft.baseSha256)}
              />
            </>
          )}
        </div>
        <Editor
          path={path}
          value={draft.text}
          wrapLines={wrapLines}
          onChange={(text) =>
            setDraft((current) => (current === null ? null : { ...current, text }))
          }
          onSave={() => {
            if (hasUnsaved && save.status === "idle") {
              saveDraft(draft, draft.baseSha256);
            }
          }}
        />
      </div>
    );
  }

  if (mode === "diff") {
    return (
      <Scroll>
        {diff.status === "loading" ? (
          <Notice>Reading the diff…</Notice>
        ) : diff.status === "error" ? (
          <Notice tone="error">{diff.message}</Notice>
        ) : diff.status === "binary" ? (
          <Notice>This file is binary, so there is no text diff to show.</Notice>
        ) : diff.status === "unchanged" ? (
          <Notice>This file is unchanged since the branch forked.</Notice>
        ) : (
          <BbDiff
            patch={diff.patch}
            path={diff.newPath}
            view={diffView}
            overflow={wrapLines ? "wrap" : "scroll"}
            // Both sides in full let BB draw the expand-context controls between
            // hunks; it verifies they agree with the patch before trusting them.
            {...(diff.oldContent !== null && diff.newContent !== null
              ? {
                  experimental_fullFileContents: {
                    old: { path: diff.oldPath, content: diff.oldContent },
                    new: { path: diff.newPath, content: diff.newContent },
                  },
                }
              : {})}
            className="min-h-full text-[13px]"
          />
        )}
      </Scroll>
    );
  }

  return (
    <Scroll>
      {file.status === "loading" ? (
        <Notice>Reading {path}…</Notice>
      ) : file.status === "error" ? (
        <Notice tone="error">{file.message}</Notice>
      ) : file.status === "binary" ? (
        <Notice>{file.reason}</Notice>
      ) : file.status === "image" && mode === "edit" ? (
        <Notice>This file is an image, so it cannot be edited here.</Notice>
      ) : file.status === "image" ? (
        <div className="flex min-h-full items-center justify-center p-6">
          <img
            src={file.dataUrl}
            alt={path}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : mode === "edit" ? (
        // A file that can be edited has a draft by now, and was drawn above.
        <Notice>
          {lineEnding === "mixed"
            ? "This file mixes Windows and Unix line endings, so it cannot be edited here without rewriting them."
            : "Reading " + path + "…"}
        </Notice>
      ) : mode === "preview" ? (
        // An edit in progress is what the document is about to be, so the
        // preview shows that rather than the copy on disk.
        <MarkdownPreview content={draft?.text ?? file.content} />
      ) : (
        <BbSourceCode
          content={file.content}
          path={path}
          overflow={wrapLines ? "wrap" : "scroll"}
          className="min-h-full text-[13px]"
        />
      )}
    </Scroll>
  );
}

function EditButton({
  label,
  title,
  onClick,
  isPrimary,
  isDisabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  isPrimary?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      className={cn(
        "shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default text-muted-foreground opacity-40"
          : isPrimary === true
            ? "cursor-pointer bg-surface-selected text-foreground"
            : "cursor-pointer text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * A markdown file read as prose. The width is capped at a reading measure and
 * centred, because a rendered document at the full width of a wide pane is the
 * one thing that makes a preview worse than the source it replaced.
 */
function MarkdownPreview({ content }: { content: string }) {
  const { frontmatter, body } = useMemo(
    () => splitFrontmatter(content),
    [content],
  );

  return (
    <div className="mx-auto w-full max-w-[52rem] px-6 py-5">
      {frontmatter === null ? null : (
        <pre className="mb-5 overflow-x-auto rounded-md border border-border bg-surface-recessed px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-muted-foreground">
          {frontmatter}
        </pre>
      )}
      {body.trim() === "" ? (
        <p className="text-sm text-muted-foreground">
          {frontmatter === null
            ? "This file is empty."
            : "This file is frontmatter only."}
        </p>
      ) : (
        <BbMarkdown content={body} />
      )}
    </div>
  );
}

/**
 * The pane's single scroll container. It is the one thing that has to be right
 * for a tall file to be readable: a definite height from the flex parent
 * (`min-h-0 flex-1`) and `overflow-auto` here, so the file scrolls inside the
 * pane instead of stretching it past the bottom of the window.
 */
function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto">{children}</div>;
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <p
      className={cn(
        "p-6 text-sm",
        tone === "error" ? "text-destructive-text" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** Fetch a file's bytes, ignoring every response but the newest request's. */
function useFileContents(
  scope: ScopeRef,
  path: string,
  enabled: boolean,
): {
  file: FileState;
  /** Record what a save just wrote, without a round trip to read it back. */
  setSavedText: (content: string, sha256: string) => void;
  reload: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FileState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const mine = (generation.current += 1);
    setState({ status: "loading" });

    void rpc
      .call("read", { scope, path })
      .then((result) => {
        if (generation.current !== mine) return;
        if (result.kind === "text") {
          setState({
            status: "text",
            content: result.content,
            sha256: result.sha256,
          });
        } else if (result.kind === "image") {
          setState({ status: "image", dataUrl: result.dataUrl });
        } else {
          setState({ status: "binary", reason: result.reason });
        }
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        setState({ status: "error", message: describe(error) });
      });
    // `scope` is rebuilt every render by its callers; its VALUE is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, path, reloads, rpc, scope.kind, scope.id]);

  const setSavedText = useCallback((content: string, sha256: string) => {
    // Anything still in flight was read before the save, so it is out of date.
    generation.current += 1;
    setState({ status: "text", content, sha256 });
  }, []);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  return { file: state, setSavedText, reload };
}

function useDiff(
  scope: ScopeRef,
  path: string,
  change: ChangedPath | null,
  baseCommit: string | null,
  enabled: boolean,
): DiffState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (baseCommit === null) {
      setState({
        status: "error",
        message: "This workspace has no fork point to compare against.",
      });
      return;
    }
    // Git reported no change for this path, so there is nothing to ask git for.
    if (change === null) {
      setState({ status: "unchanged" });
      return;
    }

    const mine = (generation.current += 1);
    setState({ status: "loading" });

    void rpc
      .call("diff", {
        scope,
        path,
        baseCommit,
        status: change.status,
        from: change.from,
      })
      .then((result) => {
        if (generation.current !== mine) return;
        if (result.kind === "patch") setState({ ...result, status: "patch" });
        else if (result.kind === "error")
          setState({ status: "error", message: result.reason });
        else setState({ status: result.kind });
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        setState({ status: "error", message: describe(error) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCommit, change?.from, change?.status, enabled, path, rpc, scope.kind, scope.id]);

  return state;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
