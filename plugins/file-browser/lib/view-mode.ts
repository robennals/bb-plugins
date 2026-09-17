/**
 * Which of the three views a file can be shown in, and which one to land on.
 *
 * Not every view fits every file: only markdown has a rendered preview, and
 * only a file git reports as changed has a diff. The rules live here, away from
 * the component, because they are asked the same question twice — when a file
 * is opened, and again when the file already open changes underneath the
 * current mode (a new file in the same pane, or a refreshed git answer).
 */

import { isMarkdownPath } from "./file-kind.js";

export type ViewMode = "preview" | "source" | "diff";

const VIEW_MODES: readonly ViewMode[] = ["preview", "source", "diff"];

/** For narrowing a mode read back out of storage. */
export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

export interface ViewModes {
  /** Markdown, rendered the way BB renders a chat message. */
  canPreview: boolean;
  /** There is a fork point to compare against AND git reported a change. */
  canDiff: boolean;
}

export function availableModes({
  path,
  isChanged,
  hasFork,
}: {
  path: string | null;
  isChanged: boolean;
  hasFork: boolean;
}): ViewModes {
  return {
    canPreview: path !== null && isMarkdownPath(path),
    canDiff: hasFork && isChanged,
  };
}

/** Source is always available, so this always answers. */
export function isModeAvailable(mode: ViewMode, modes: ViewModes): boolean {
  if (mode === "diff") return modes.canDiff;
  if (mode === "preview") return modes.canPreview;
  return true;
}

/**
 * Where to land. A changed file is nearly always opened to see WHAT changed, so
 * the diff wins; failing that, markdown reads better rendered than as source.
 */
export function preferredMode(modes: ViewModes): ViewMode {
  if (modes.canDiff) return "diff";
  if (modes.canPreview) return "preview";
  return "source";
}

/** Keep the mode the user chose while it still fits; otherwise fall back. */
export function resolveMode(mode: ViewMode, modes: ViewModes): ViewMode {
  return isModeAvailable(mode, modes) ? mode : preferredMode(modes);
}
