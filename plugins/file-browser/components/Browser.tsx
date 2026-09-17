import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  type DiffViewMode,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import { EMPTY_CHANGE_INDEX, indexChanges, type ChangeIndex } from "@/lib/changes";
import type { FlatEntry } from "@/lib/tree";
import type { ScopeRef } from "@/lib/route";
import { readSession, saveSession } from "@/lib/session";
import type { ResolvedScope, rpcContract } from "../server.js";
import { Explorer } from "./Explorer";
import { QuickOpen } from "./QuickOpen";
import {
  availableModes,
  preferredMode,
  resolveMode,
  type ViewMode,
  type ViewModes,
} from "@/lib/view-mode";
import { Viewer } from "./Viewer";
import { WorkspacePicker } from "./WorkspacePicker";

interface TreeState {
  status: "idle" | "loading" | "ready" | "error";
  scope: ResolvedScope | null;
  entries: FlatEntry[];
  truncated: boolean;
  listing: "local" | "remote";
  excluded: string[];
  changes: ChangeIndex;
  error: string | null;
}

const EMPTY_TREE: TreeState = {
  status: "idle",
  scope: null,
  entries: [],
  truncated: false,
  listing: "local",
  excluded: [],
  changes: EMPTY_CHANGE_INDEX,
  error: null,
};

const MIN_EXPLORER_PX = 180;
const MAX_EXPLORER_PX = 560;
const DEFAULT_EXPLORER_PX = 260;

const WIDTH_KEY = "file-browser:explorer-width";
const HIDDEN_KEY = "file-browser:include-hidden";
const CHANGED_ONLY_KEY = "file-browser:changed-only";
const DIFF_VIEW_KEY = "file-browser:diff-view";

export interface BrowserProps {
  scope: ScopeRef | null;
  filePath: string | null;
  /** Called when the open file changes, so a routed surface can mirror it. */
  onOpenPath: (path: string | null) => void;
  /** Omit to pin the surface to one workspace (the thread panel does). */
  onChangeScope?: (scope: ScopeRef) => void;
  variant: "page" | "panel";
}

export function Browser({
  scope,
  filePath,
  onOpenPath,
  onChangeScope,
  variant,
}: BrowserProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [includeHidden, setIncludeHidden] = useState(() => readFlag(HIDDEN_KEY, true));
  const [changedOnly, setChangedOnly] = useState(() => readFlag(CHANGED_ONLY_KEY, false));
  const [explorerWidth, setExplorerWidth] = useState(readStoredWidth);
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  // The last visit to THIS workspace, read once. The page variant is keyed on
  // the workspace by its caller, so a fresh workspace remounts and re-reads.
  const [restored] = useState(() => readSession(scope));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(restored?.expanded ?? []),
  );
  const [mode, setMode] = useState<ViewMode>(restored?.mode ?? "source");
  const [diffView, setDiffView] = useState<DiffViewMode>(() =>
    readFlag(DIFF_VIEW_KEY, false) ? "split" : "unified",
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const loadTree = useCallback(
    (target: ScopeRef | null, hidden: boolean) => {
      if (target === null) {
        setTree(EMPTY_TREE);
        return;
      }
      const generation = (requestRef.current += 1);
      setTree((current) => ({ ...current, status: "loading", error: null }));

      void rpc
        .call("tree", { scope: target, includeHidden: hidden })
        .then((result) => {
          if (requestRef.current !== generation) return;
          setTree({
            status: "ready",
            scope: result.scope,
            entries: result.entries,
            truncated: result.truncated,
            listing: result.listing,
            excluded: result.excluded,
            changes: indexChanges(result.changes),
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (requestRef.current !== generation) return;
          setTree({
            ...EMPTY_TREE,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Could not read this workspace.",
          });
        });
    },
    [rpc],
  );

  // Keyed on the scope's VALUE, not the object: callers build the ref during
  // render, so a fresh identity every render would re-walk the whole workspace
  // and re-run git on every keystroke and every file click.
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope?.id ?? null;
  // Which file is open, in which workspace: the same README in another worktree
  // is another file, and it deserves its own landing view.
  const openKeyFor = (path: string) => `${scopeKind}:${scopeId}:${path}`;
  useEffect(() => {
    loadTree(
      scopeKind === null || scopeId === null ? null : { kind: scopeKind, id: scopeId },
      includeHidden,
    );
  }, [includeHidden, loadTree, scopeId, scopeKind]);

  const change = filePath === null ? null : tree.changes.byPath.get(filePath) ?? null;
  const hasFork = tree.changes.baseCommit !== null;
  const { canPreview, canDiff } = availableModes({
    path: filePath,
    isChanged: change !== null,
    hasFork,
  });
  // Rebuilt every render, so hold it steady on its VALUES for the effect below.
  const modes = useMemo<ViewModes>(
    () => ({ canPreview, canDiff }),
    [canDiff, canPreview],
  );

  // One rule for what the pane shows, applied wherever the file came from — an
  // explorer click, ⌘P, or a link pasted into the address bar:
  //
  // - A file arriving in the pane lands on its preferred view: the preview when
  //   it is markdown, else the diff when the branch changed it, else source.
  // - The file already open keeps the view YOU chose for as long as it fits,
  //   and falls back only when it stops fitting (git's answer was refreshed and
  //   the diff went away).
  //
  // Nothing is decided until the tree has answered, because "changed" is not
  // known before that and a file would otherwise never land on its diff.
  //
  // The file that came back from the remembered session counts as already
  // landed: it is not arriving in the pane, it is the one you were reading, so
  // the view it was in stands rather than being decided afresh. It is still
  // checked for fit, so a remembered diff of a file that is no longer changed
  // falls back like any other.
  const defaultedFor = useRef<string | null>(
    restored === null || restored.filePath === null || restored.mode === null
      ? null
      : openKeyFor(restored.filePath),
  );
  const areChangesKnown = tree.status === "ready";
  const openKey = filePath === null ? null : openKeyFor(filePath);
  useEffect(() => {
    if (openKey === null || !areChangesKnown) return;
    if (defaultedFor.current !== openKey) {
      defaultedFor.current = openKey;
      setMode(preferredMode(modes));
      return;
    }
    setMode((current) => resolveMode(current, modes));
  }, [areChangesKnown, modes, openKey]);

  const openFile = useCallback(
    (path: string) => {
      onOpenPath(path);
      if (variant === "panel") setIsExplorerOpen(false);
      requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
    },
    [onOpenPath, variant],
  );

  // Remember where you were, so leaving and coming back does not land you on a
  // collapsed tree with an empty pane. Written on every change rather than on
  // unmount, because a panel can be torn down without one.
  useEffect(() => {
    if (scopeKind === null || scopeId === null) return;
    saveSession(
      { kind: scopeKind, id: scopeId },
      {
        filePath,
        // Only once a file is open is the view a fact about anything; before
        // that it is this component's initial state, and recording it would
        // overwrite the remembered view with a default.
        mode: filePath === null ? null : mode,
        expanded: [...expanded],
      },
    );
  }, [expanded, filePath, mode, scopeId, scopeKind]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const isAccel = event.metaKey || event.ctrlKey;
    if (isAccel && event.key.toLowerCase() === "p" && !event.shiftKey) {
      event.preventDefault();
      setIsQuickOpen(true);
      return;
    }
    if (event.key === "Escape" && isQuickOpen) {
      event.preventDefault();
      setIsQuickOpen(false);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setExplorerWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    };
    const stop = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      setExplorerWidth((width) => {
        store(WIDTH_KEY, String(width));
        return width;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  };

  const resolved = tree.scope;

  const explorerHeader = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        {onChangeScope === undefined ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs">
            <Icon
              name={resolved?.environmentId === null ? "Folder" : "GitBranch"}
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium text-foreground">
              {resolved?.label ?? "Workspace"}
            </span>
            <span className="truncate text-muted-foreground">
              {resolved?.sublabel ?? ""}
            </span>
          </div>
        ) : (
          <WorkspacePicker
            current={resolved}
            onSelect={(next) => {
              onChangeScope(next);
              setIsQuickOpen(false);
            }}
          />
        )}
      </div>
    ),
    [onChangeScope, resolved],
  );

  return (
    // The one layout rule the whole surface depends on: this element takes a
    // DEFINITE height from the host — `h-full` for a block parent, `flex-1
    // min-h-0` for a flex column — and `overflow-hidden` stops any child
    // growing it. Every scroll region inside then sizes against it, which is
    // what keeps a long tree and a tall file scrolling in place rather than
    // running off the bottom of the window.
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      // Focusable and focused on mount so ⌘P works before anything inside has
      // been clicked.
      tabIndex={-1}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-background focus:outline-none"
    >
      {isExplorerOpen ? (
        <>
          <div
            style={{ width: explorerWidth }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          >
            <Explorer
              entries={tree.entries}
              changes={tree.changes}
              changedOnly={changedOnly}
              onToggleChangedOnly={(next) => {
                setChangedOnly(next);
                store(CHANGED_ONLY_KEY, next ? "true" : "false");
              }}
              activePath={filePath}
              expanded={expanded}
              setExpanded={setExpanded}
              isLoading={tree.status === "loading"}
              error={tree.error}
              truncated={tree.truncated}
              hiddenSupported={tree.listing === "local"}
              includeHidden={includeHidden}
              onToggleHidden={(next) => {
                setIncludeHidden(next);
                store(HIDDEN_KEY, next ? "true" : "false");
              }}
              onOpenFile={openFile}
              onRefresh={() => loadTree(scope, includeHidden)}
              onQuickOpen={() => setIsQuickOpen(true)}
              header={explorerHeader}
            />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file explorer"
            onPointerDown={startResize}
            onDoubleClick={() => {
              setExplorerWidth(DEFAULT_EXPLORER_PX);
              store(WIDTH_KEY, String(DEFAULT_EXPLORER_PX));
            }}
            className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring"
          />
        </>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <ToolbarButton
            icon="PanelLeft"
            label={isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            isActive={isExplorerOpen}
            onClick={() => setIsExplorerOpen((open) => !open)}
          />

          <Breadcrumb
            root={resolved?.root ?? null}
            path={filePath}
            hostName={resolved?.hostName ?? null}
            isLocal={resolved?.isLocal ?? true}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {filePath === null ? null : (
              <>
                <ModeToggle
                  mode={mode}
                  onChange={setMode}
                  modes={modes}
                  // Nothing to diff: no fork point, or git says this file is
                  // the same as it was there.
                  noDiffReason={
                    tree.changes.unavailable ??
                    (change === null
                      ? "This file is unchanged on this branch."
                      : null)
                  }
                />
                {mode === "diff" ? (
                  <ToolbarButton
                    icon={diffView === "split" ? "Columns2" : "Rows2"}
                    label={
                      diffView === "split"
                        ? "Show the diff inline"
                        : "Show the diff side by side"
                    }
                    onClick={() => {
                      const next = diffView === "split" ? "unified" : "split";
                      setDiffView(next);
                      store(DIFF_VIEW_KEY, next === "split" ? "true" : "false");
                    }}
                  />
                ) : null}
                {resolved === null ? null : (
                  <ToolbarButton
                    icon="ExternalLink"
                    label="Open in BB's file preview"
                    onClick={() => {
                      const opened = navigate.experimental_openFilePreview({
                        target:
                          resolved.environmentId === null
                            ? {
                                kind: "host",
                                hostId: resolved.hostId,
                                path: absolutePathFor(resolved.root, filePath),
                              }
                            : {
                                kind: "workspace",
                                environmentId: resolved.environmentId,
                                path: filePath,
                              },
                        location: null,
                      });
                      if (!opened) {
                        toast.error("This surface has no file preview panel.");
                      }
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {scope === null || filePath === null ? (
          <Empty
            hasWorkspace={resolved !== null}
            error={tree.error}
            listing={tree.listing}
            truncated={tree.truncated}
            excluded={tree.excluded}
            changes={tree.changes}
            onQuickOpen={() => setIsQuickOpen(true)}
          />
        ) : (
          <Viewer
            // Remount on every file: the viewer's fetches are keyed on the path,
            // and a stale frame of the previous file would otherwise paint first.
            key={`${scope.kind}:${scope.id}:${filePath}`}
            scope={scope}
            path={filePath}
            mode={mode}
            diffView={diffView}
            change={change}
            baseCommit={tree.changes.baseCommit}
          />
        )}
      </div>

      {isQuickOpen ? (
        <QuickOpen
          entries={tree.entries}
          onOpenFile={openFile}
          onClose={() => setIsQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
  modes,
  noDiffReason,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  modes: ViewModes;
  noDiffReason: string | null;
}) {
  return (
    <div
      role="group"
      aria-label="How to show this file"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {/* Only markdown has anything to render, so the button is absent rather
          than disabled for every other file — a permanently dead third button
          on the toolbar reads as broken. */}
      {modes.canPreview ? (
        <ModeButton
          label="Preview"
          title="Show the markdown as formatted text"
          isActive={mode === "preview"}
          onClick={() => onChange("preview")}
        />
      ) : null}
      <ModeButton
        label={modes.canPreview ? "Source" : "File"}
        title="Show the file as it is now"
        isActive={mode === "source"}
        onClick={() => onChange("source")}
      />
      <ModeButton
        label="Diff"
        title={
          modes.canDiff
            ? "Show what this branch changed"
            : noDiffReason ?? "No diff available."
        }
        isActive={mode === "diff"}
        isDisabled={!modes.canDiff}
        onClick={() => onChange("diff")}
      />
    </div>
  );
}

function ModeButton({
  label,
  title,
  isActive,
  isDisabled,
  onClick,
}: {
  label: string;
  title: string;
  isActive: boolean;
  isDisabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      aria-pressed={isActive}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default text-muted-foreground opacity-40"
          : isActive
            ? "cursor-pointer bg-surface-selected text-foreground"
            : "cursor-pointer text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function Breadcrumb({
  root,
  path,
  hostName,
  isLocal,
}: {
  root: string | null;
  path: string | null;
  hostName: string | null;
  isLocal: boolean;
}) {
  if (root === null) {
    return <span className="truncate text-xs text-muted-foreground">No workspace</span>;
  }
  const segments = path === null ? [] : path.split("/");
  const rootLabel =
    formatHomePathForDisplay(root).split(/[/\\]/).filter(Boolean).at(-1) ?? root;

  return (
    <nav
      aria-label="File location"
      title={path === null ? root : `${root}/${path}`}
      className="flex min-w-0 items-center gap-1 overflow-hidden text-xs"
    >
      {isLocal ? null : (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <Icon name="Laptop" aria-hidden className="size-3" />
          {hostName}
          <Icon name="ChevronRight" aria-hidden className="size-3" />
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">{rootLabel}</span>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          <Icon
            name="ChevronRight"
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
          <span
            className={cn(
              "truncate",
              index === segments.length - 1 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {segment}
          </span>
        </span>
      ))}
    </nav>
  );
}

function Empty({
  hasWorkspace,
  error,
  listing,
  truncated,
  excluded,
  changes,
  onQuickOpen,
}: {
  hasWorkspace: boolean;
  error: string | null;
  listing: "local" | "remote";
  truncated: boolean;
  excluded: readonly string[];
  changes: ChangeIndex;
  onQuickOpen: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-8 text-center">
      <Icon name="Code" aria-hidden className="size-8 text-muted-foreground/60" />
      {error !== null ? (
        <p className="max-w-sm text-sm text-destructive-text">{error}</p>
      ) : !hasWorkspace ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a workspace to browse its files.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Select a file to open it, or{" "}
            <button
              type="button"
              onClick={onQuickOpen}
              className="cursor-pointer font-medium text-foreground underline underline-offset-2"
            >
              go to file
            </button>
            .
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {changes.unavailable !== null
              ? changes.unavailable
              : changes.byPath.size === 0
                ? `Nothing has changed since this branch forked from ${changes.baseRef}.`
                : `${changes.byPath.size.toLocaleString()} file${
                    changes.byPath.size === 1 ? "" : "s"
                  } changed since this branch forked from ${changes.baseRef}.`}
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {listing === "remote"
              ? "This workspace is on another machine, so BB lists it — dotfiles are not included."
              : excluded.length === 0
                ? "Every file in the workspace is listed."
                : `Excluding ${excluded.join(", ")}.`}
            {truncated ? " The listing hit its size limit." : ""}
          </p>
        </>
      )}
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  isActive,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isActive === true && "text-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}

function absolutePathFor(root: string, relativePath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const trimmed = root.endsWith(separator) ? root.slice(0, -1) : root;
  const tail = separator === "\\" ? relativePath.replace(/\//g, "\\") : relativePath;
  return `${trimmed}${separator}${tail}`;
}

function clampWidth(value: number): number {
  return Math.min(MAX_EXPLORER_PX, Math.max(MIN_EXPLORER_PX, Math.round(value)));
}

function readStoredWidth(): number {
  const stored = read(WIDTH_KEY);
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_EXPLORER_PX;
}

function readFlag(key: string, fallback: boolean): boolean {
  const stored = read(key);
  return stored === null ? fallback : stored === "true";
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, embedded webview); the
    // preference simply does not persist.
  }
}
