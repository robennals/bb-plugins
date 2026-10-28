import { useEffect, useMemo, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  buildTree,
  visibleRows,
  type FlatEntry,
  type TreeRow,
} from "@/lib/tree";
import type { ChangeStatus } from "../contract.js";
import {
  statusForRow,
  statusLabel,
  statusLetter,
  statusTextClass,
  type ChangeIndex,
} from "@/lib/changes";
import { FileGlyph } from "./FileGlyph";
import { SearchResults, type ContentSearch, type SearchHit } from "./SearchResults";

export interface ExplorerProps {
  entries: readonly FlatEntry[];
  /** What this branch changed, for the per-row highlighting. */
  changes: ChangeIndex;
  /** Narrow the tree to changed files only. */
  changedOnly: boolean;
  onToggleChangedOnly: (next: boolean) => void;
  activePath: string | null;
  /**
   * Unfolded directories. Owned by the caller so that they survive leaving the
   * browser and coming back, which this component cannot do on its own — it is
   * unmounted along with everything else.
   */
  expanded: ReadonlySet<string>;
  setExpanded: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  /** BB's remote listing cannot return dotfiles, so the toggle is disabled. */
  hiddenSupported: boolean;
  includeHidden: boolean;
  onToggleHidden: (next: boolean) => void;
  onOpenFile: (path: string) => void;
  /** What is typed in the search box. Text in it swaps the tree for results. */
  query: string;
  onQueryChange: (query: string) => void;
  search: ContentSearch;
  /** The search result open in the viewer, if one is. */
  activeHit: SearchHit | null;
  onOpenHit: (hit: SearchHit) => void;
  onRefresh: () => void;
  onQuickOpen: () => void;
  header: React.ReactNode;
}

const INDENT_PER_LEVEL_PX = 10;

/** Rows mounted at once. Beyond this the footer says how many were held back. */
const ROW_LIMIT = 600;

export function Explorer({
  entries,
  changes,
  changedOnly,
  onToggleChangedOnly,
  activePath,
  expanded,
  setExpanded,
  isLoading,
  error,
  truncated,
  hiddenSupported,
  includeHidden,
  onToggleHidden,
  onOpenFile,
  query,
  onQueryChange,
  search,
  activeHit,
  onOpenHit,
  onRefresh,
  onQuickOpen,
  header,
}: ExplorerProps) {
  const isSearching = query.trim() !== "";
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Deleted files are not on disk, so the listing cannot contain them. Add them
  // back as rows: "what did this branch change" is a question a file that no
  // longer exists is still part of the answer to.
  const withDeletions = useMemo(() => {
    if (changes.deletedPaths.length === 0) return entries;
    const known = new Set(entries.map((entry) => entry.path));
    const missing = changes.deletedPaths
      .filter((change) => !known.has(change.path))
      .map((change) => ({ path: change.path, kind: "file" as const }));
    return missing.length === 0 ? entries : [...entries, ...missing];
  }, [changes.deletedPaths, entries]);

  const shown = useMemo(() => {
    if (!changedOnly) return withDeletions;
    return withDeletions.filter(
      (entry) =>
        entry.kind === "file" && changes.byPath.has(entry.path),
    );
  }, [changedOnly, changes.byPath, withDeletions]);

  const tree = useMemo(() => buildTree(shown), [shown]);

  // Changed-only narrows the search the same way it narrows the tree.
  const foundFiles = useMemo(() => {
    const files = search.result?.files ?? [];
    return changedOnly ? files.filter((file) => changes.byPath.has(file.path)) : files;
  }, [changedOnly, changes.byPath, search.result]);
  const foundLines = foundFiles.reduce((total, file) => total + file.matchCount, 0);

  // Reveal the active file by opening every directory above it.
  useEffect(() => {
    if (activePath === null) return;
    setExpanded((current) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of ancestors) next.add(ancestor);
      return next;
    });
  }, [activePath, setExpanded]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath, shown.length]);

  const effectiveExpanded = useMemo(() => {
    // Changed-only is already a short list, and every row in it is the point —
    // leaving its directories collapsed would hide the answer behind a click.
    if (changedOnly) {
      return new Set(shown.flatMap((entry) => ancestorsOf(entry.path)));
    }
    return expanded;
  }, [changedOnly, expanded, shown]);

  const allRows = useMemo(
    () => visibleRows(tree, effectiveExpanded),
    [tree, effectiveExpanded],
  );
  // A large checkout with its directories unfolded is tens of thousands of
  // rows. Cap what is mounted rather than building them all synchronously.
  const rows = useMemo(() => {
    if (allRows.length <= ROW_LIMIT) return allRows;
    const capped = allRows.slice(0, ROW_LIMIT);
    // A blind head slice can cut the row for the file that is actually open,
    // leaving the tree with no selection and the scroll-into-view a no-op.
    // Keep it, at the cost of one row from the head.
    const activeIndex = allRows.findIndex((row) => row.node.path === activePath);
    if (activeIndex >= ROW_LIMIT) capped[ROW_LIMIT - 1] = allRows[activeIndex]!;
    return capped;
  }, [activePath, allRows]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const fileCount = useMemo(
    () => shown.reduce((total, entry) => total + (entry.kind === "file" ? 1 : 0), 0),
    [shown],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-recessed">
      {header}

      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                onQueryChange("");
              }
            }}
            placeholder="Search in files"
            aria-label="Search in files"
            spellCheck={false}
            className={cn(
              "h-7 w-full min-w-0 rounded-md border border-border bg-background pr-2 pl-7 text-sm",
              "text-foreground placeholder:text-muted-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
        </div>
        <ExplorerAction
          icon="Search"
          label="Quick open (⌘P)"
          onClick={onQuickOpen}
        />
        <ExplorerAction
          icon="FileDiff"
          label={
            changedOnly ? "Show every file" : "Show only files this branch changed"
          }
          isActive={changedOnly}
          isDisabled={changes.unavailable !== null}
          onClick={() => onToggleChangedOnly(!changedOnly)}
        />
        {hiddenSupported ? (
          <ExplorerAction
            icon={includeHidden ? "Eye" : "EyeOff"}
            label={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
            isActive={includeHidden}
            onClick={() => onToggleHidden(!includeHidden)}
          />
        ) : null}
        <ExplorerAction
          icon="ArrowReloadHorizontal"
          label="Refresh files"
          isSpinning={isLoading}
          onClick={onRefresh}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {error !== null ? (
          <p className="px-3 py-2 text-xs text-destructive">{error}</p>
        ) : isSearching ? (
          search.error !== null ? (
            <p className="px-3 py-2 text-xs text-destructive">{search.error}</p>
          ) : search.result === null ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
          ) : foundFiles.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {search.isSearching
                ? "Searching…"
                : changedOnly
                  ? `No changed file contains “${search.query}”.`
                  : `No file contains “${search.query}”.`}
            </p>
          ) : (
            <SearchResults
              files={foundFiles}
              query={search.query}
              activeHit={activeHit}
              onOpenHit={onOpenHit}
            />
          )
        ) : isLoading && shown.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Reading the workspace…</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {changedOnly
              ? "This branch has not changed any file yet."
              : "This workspace has no files yet."}
          </p>
        ) : (
          <ul role="tree" aria-label="Workspace files" className="min-w-max">
            {rows.map((row) => (
              <ExplorerRow
                key={row.node.path}
                row={row}
                status={statusForRow(changes, row.node.path, row.node.kind)}
                isActive={row.node.path === activePath}
                activeRef={row.node.path === activePath ? activeRowRef : undefined}
                onToggle={toggle}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {!isSearching
          ? `${fileCount.toLocaleString()} files`
          : search.result === null
            ? "Searching…"
            : `${foundLines.toLocaleString()} ${foundLines === 1 ? "line" : "lines"} in ${foundFiles.length.toLocaleString()} ${foundFiles.length === 1 ? "file" : "files"}${search.result.truncated ? " · stopped at the first matches" : ""}`}
        {!isSearching && allRows.length > rows.length
          ? ` · showing first ${ROW_LIMIT.toLocaleString()}`
          : ""}
        {truncated ? " · listing truncated" : ""}
        {changes.baseRef === null
          ? ""
          : ` · vs ${changes.baseRef}`}
      </div>
    </div>
  );
}

function ExplorerRow({
  row,
  status,
  isActive,
  activeRef,
  onToggle,
  onOpenFile,
}: {
  row: TreeRow;
  status: ChangeStatus | null;
  isActive: boolean;
  activeRef?: React.RefObject<HTMLButtonElement | null>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { node, depth, isExpanded } = row;
  const isDirectory = node.kind === "directory";

  return (
    <li role="none">
      <button
        ref={activeRef}
        type="button"
        role="treeitem"
        aria-selected={isActive}
        aria-expanded={isDirectory ? isExpanded : undefined}
        title={status === null ? node.path : `${node.path} — ${statusLabel(status)}`}
        onClick={() =>
          isDirectory ? onToggle(node.path) : onOpenFile(node.path)
        }
        style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
        className={cn(
          "flex h-6 w-full min-w-full cursor-pointer items-center gap-1.5 pr-3 text-left text-[13px]",
          "text-foreground/90 hover:bg-state-hover",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
          isActive && "bg-surface-selected text-foreground",
        )}
      >
        {isDirectory ? (
          <Icon
            name={isExpanded ? "ChevronDown" : "ChevronRight"}
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : (
          <span aria-hidden className="w-3 shrink-0" />
        )}
        <FileGlyph path={node.path} kind={node.kind} isExpanded={isExpanded} />
        <span
          className={cn(
            "truncate",
            // A changed file is named in the diff colour; an unchanged one keeps
            // the ordinary foreground, so the colour means something.
            status !== null && statusTextClass(status),
            status === "deleted" && "line-through",
          )}
        >
          {node.name}
        </span>
        {status === null ? null : (
          <span
            aria-hidden
            className={cn(
              "ml-auto shrink-0 pl-1 font-mono text-[10px] leading-none",
              statusTextClass(status),
              // A directory's badge only rolls up what is inside it; dimming it
              // keeps the file that actually changed the loudest thing on screen.
              isDirectory && "opacity-60",
            )}
          >
            {isDirectory ? "•" : statusLetter(status)}
          </span>
        )}
      </button>
    </li>
  );
}

function ExplorerAction({
  icon,
  label,
  onClick,
  isActive,
  isDisabled,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isDisabled?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
        isDisabled === true
          ? "cursor-default text-muted-foreground opacity-40"
          : "cursor-pointer text-muted-foreground hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isActive === true && "text-foreground",
      )}
    >
      <Icon
        name={icon}
        aria-hidden
        className={cn("size-3.5", isSpinning === true && "animate-spin")}
      />
    </button>
  );
}
