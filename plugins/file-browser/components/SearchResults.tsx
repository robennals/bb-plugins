import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { matchRanges, type SearchFile, type SearchResult } from "@/lib/content-search";
import { basename, dirname } from "@/lib/tree";
import { FileGlyph } from "./FileGlyph";

/** Where a search result points: a file, and the line the match is on. */
export interface SearchHit {
  path: string;
  line: number;
}

/** The explorer's search, as of the last query it was asked. */
export interface ContentSearch {
  /** The query `result` answers; it trails what is typed while a search runs. */
  query: string;
  result: SearchResult | null;
  isSearching: boolean;
  error: string | null;
}

export const IDLE_SEARCH: ContentSearch = {
  query: "",
  result: null,
  isSearching: false,
  error: null,
};

/**
 * What a content search found, grouped by file: each file once, with a
 * preview of every matching line under it. Clicking the file opens it at its
 * first match; clicking a line opens it at that line.
 */
export function SearchResults({
  files,
  query,
  activeHit,
  onOpenHit,
}: {
  files: readonly SearchFile[];
  query: string;
  activeHit: SearchHit | null;
  onOpenHit: (hit: SearchHit) => void;
}) {
  return (
    <ul aria-label="Search results" className="min-w-0">
      {files.map((file) => (
        <SearchResultFile
          key={file.path}
          file={file}
          query={query}
          activeLine={activeHit?.path === file.path ? activeHit.line : null}
          onOpenHit={onOpenHit}
        />
      ))}
    </ul>
  );
}

function SearchResultFile({
  file,
  query,
  activeLine,
  onOpenHit,
}: {
  file: SearchFile;
  query: string;
  activeLine: number | null;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const directory = dirname(file.path);
  const hidden = file.matchCount - file.lines.length;
  const firstLine = file.lines[0]?.line ?? 1;

  return (
    <li>
      <button
        type="button"
        title={file.path}
        onClick={() => onOpenHit({ path: file.path, line: firstLine })}
        className={cn(
          "flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 text-left text-[13px]",
          "text-foreground/90 hover:bg-state-hover",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
        )}
      >
        <FileGlyph path={file.path} kind="file" isExpanded={false} />
        <span className="shrink-0">{basename(file.path)}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{directory}</span>
        <span className="ml-auto shrink-0 rounded-full bg-surface-selected px-1.5 text-[10px] leading-4 text-muted-foreground">
          {file.matchCount}
        </span>
      </button>
      <ul>
        {file.lines.map((entry) => (
          <li key={entry.line}>
            <button
              type="button"
              aria-current={entry.line === activeLine ? "true" : undefined}
              title={`${file.path}:${entry.line}`}
              onClick={() => onOpenHit({ path: file.path, line: entry.line })}
              className={cn(
                "flex h-5 w-full min-w-0 cursor-pointer items-baseline gap-2 pr-2 pl-7 text-left font-mono text-[11px]",
                "text-muted-foreground hover:bg-state-hover",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
                entry.line === activeLine && "bg-surface-selected text-foreground",
              )}
            >
              <span className="w-7 shrink-0 text-right opacity-60">{entry.line}</span>
              <span className="min-w-0 truncate whitespace-pre">
                <MarkedText text={entry.text} query={query} />
              </span>
            </button>
          </li>
        ))}
        {hidden > 0 ? (
          <li className="py-0.5 pr-2 pl-16 text-[11px] text-muted-foreground">
            {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"} in this file
          </li>
        ) : null}
      </ul>
    </li>
  );
}

/** `text` with every occurrence of `query` marked. */
function MarkedText({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const pieces: Array<{ text: string; isMatch: boolean }> = [];
    let cursor = 0;
    for (const range of matchRanges(text, query)) {
      if (range.start > cursor) pieces.push({ text: text.slice(cursor, range.start), isMatch: false });
      pieces.push({ text: text.slice(range.start, range.end), isMatch: true });
      cursor = range.end;
    }
    if (cursor < text.length) pieces.push({ text: text.slice(cursor), isMatch: false });
    return pieces;
  }, [text, query]);

  return (
    <>
      {parts.map((part, index) =>
        part.isMatch ? (
          <mark
            // eslint-disable-next-line react/no-array-index-key -- position IS the part's identity
            key={index}
            className="rounded-sm bg-primary/20 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
