/**
 * Searching INSIDE files: the rules shared by the host, which finds the
 * matches, and the page, which marks them up. Both sides ask "where does this
 * query occur in this text" the same way — plain text, case ignored — so a line
 * the host reported is always a line the page can highlight.
 */

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchLine {
  /** 1-based, as git and the source viewer both count. */
  line: number;
  /** The line, clipped to keep the match in view. */
  text: string;
}

export interface SearchFile {
  path: string;
  /** Every matching line in the file, not just the ones in `lines`. */
  matchCount: number;
  lines: SearchLine[];
}

export interface SearchResult {
  files: SearchFile[];
  /** More files matched than were returned. */
  truncated: boolean;
}

/** Longest preview the explorer is handed; it truncates further to fit. */
const PREVIEW_CHARS = 160;
/** How much of the line before the match a clipped preview keeps. */
const PREVIEW_LEAD_CHARS = 40;

function queryPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

/** Every place `query` occurs in `text`, ignoring case. */
export function matchRanges(text: string, query: string): MatchRange[] {
  if (query === "") return [];
  return [...text.matchAll(queryPattern(query))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** The 1-based numbers of the lines in `content` that contain `query`. */
export function matchingLines(content: string, query: string): number[] {
  if (query === "") return [];
  const pattern = queryPattern(query);
  const lines: number[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) lines.push(index + 1);
  }
  return lines;
}

/**
 * A line as the explorer shows it: indentation dropped, and a long line —
 * minified code, a data file — cut down to the stretch around its first match.
 */
export function clipPreview(text: string, query: string): string {
  const trimmed = text.replace(/\r$/, "").trimStart();
  if (trimmed.length <= PREVIEW_CHARS) return trimmed;
  const first = matchRanges(trimmed, query)[0];
  const start = Math.max(0, (first?.start ?? 0) - PREVIEW_LEAD_CHARS);
  const end = Math.min(trimmed.length, start + PREVIEW_CHARS);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

/**
 * The same rule the explorer's listing applies, so a search never turns up a
 * file the tree beside it would not show.
 */
export function isSearchablePath(
  path: string,
  excludedNames: ReadonlySet<string>,
  includeHidden: boolean,
): boolean {
  return path
    .split("/")
    .every(
      (segment) =>
        !excludedNames.has(segment) && (includeHidden || !segment.startsWith(".")),
    );
}

export interface CollectorOptions {
  query: string;
  excludedNames: ReadonlySet<string>;
  includeHidden: boolean;
  maxFiles: number;
  maxLinesPerFile: number;
}

/**
 * Gathers matches into per-file results, from `git grep -n -z` output fed in
 * whatever chunks the pipe delivers, or line by line from a direct scan.
 * `push` returns false once a file past `maxFiles` turns up, so the caller can
 * stop searching: a one-letter query in a large checkout matches nearly every
 * line, and reading all of that only to throw it away is the slow part.
 */
export function createGrepCollector(options: CollectorOptions) {
  const files: SearchFile[] = [];
  const byPath = new Map<string, SearchFile>();
  let truncated = false;
  let pending = "";

  const add = (path: string, line: number, text: string): boolean => {
    if (!isSearchablePath(path, options.excludedNames, options.includeHidden)) {
      return true;
    }
    let file = byPath.get(path);
    if (file === undefined) {
      if (files.length >= options.maxFiles) {
        truncated = true;
        return false;
      }
      file = { path, matchCount: 0, lines: [] };
      byPath.set(path, file);
      files.push(file);
    }
    file.matchCount += 1;
    if (file.lines.length < options.maxLinesPerFile) {
      file.lines.push({ line, text: clipPreview(text, options.query) });
    }
    return true;
  };

  return {
    add,
    /** One chunk of `git grep -n -z` output: `path NUL line NUL text LF`. */
    push(chunk: string): boolean {
      pending += chunk;
      const records = pending.split("\n");
      pending = records.pop() ?? "";
      for (const record of records) {
        const pathEnd = record.indexOf("\0");
        const lineEnd = record.indexOf("\0", pathEnd + 1);
        if (pathEnd === -1 || lineEnd === -1) continue;
        const line = Number.parseInt(record.slice(pathEnd + 1, lineEnd), 10);
        if (!Number.isFinite(line)) continue;
        if (!add(record.slice(0, pathEnd), line, record.slice(lineEnd + 1))) {
          return false;
        }
      }
      return true;
    },
    finish(): SearchResult {
      return { files, truncated };
    },
  };
}
