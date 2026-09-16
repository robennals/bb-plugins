import { useEffect, useRef, useState } from "react";
import {
  experimental_Diff as BbDiff,
  experimental_SourceCode as BbSourceCode,
  useRpc,
  type DiffViewMode,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { ChangedPath } from "../contract.js";
import type { ScopeRef } from "@/lib/route";
import type { rpcContract } from "../server.js";

/** What the middle pane is showing. */
export type ViewMode = "source" | "diff";

type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: string }
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

export interface ViewerProps {
  scope: ScopeRef;
  path: string;
  mode: ViewMode;
  diffView: DiffViewMode;
  /** The file's standing on this branch; null when git reported no change. */
  change: ChangedPath | null;
  baseCommit: string | null;
}

/**
 * The file pane. Both renderers are BB's own — the source viewer and the diff
 * viewer the rest of the app uses — so highlighting, the code theme, and the
 * diff's expand-context controls come for free and stay consistent with it.
 */
export function Viewer({
  scope,
  path,
  mode,
  diffView,
  change,
  baseCommit,
}: ViewerProps) {
  const file = useFileContents(scope, path, mode === "source");
  const diff = useDiff(scope, path, change, baseCommit, mode === "diff");

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
      ) : file.status === "image" ? (
        <div className="flex min-h-full items-center justify-center p-6">
          <img
            src={file.dataUrl}
            alt={path}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : (
        <BbSourceCode
          content={file.content}
          path={path}
          overflow="scroll"
          className="min-h-full text-[13px]"
        />
      )}
    </Scroll>
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
): FileState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FileState>({ status: "loading" });
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
          setState({ status: "text", content: result.content });
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
  }, [enabled, path, rpc, scope.kind, scope.id]);

  return state;
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
