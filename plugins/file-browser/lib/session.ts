/**
 * What the browser remembers about a workspace between visits: the file you had
 * open and the folders you had unfolded to reach it. Leaving the Files page and
 * coming back should put you where you were, not at a collapsed tree with an
 * empty pane.
 *
 * Everything lives under ONE localStorage key, as a map of workspace to
 * session, with a most-recent-first order beside it. A key per workspace would
 * grow without limit — a thread worktree is created, browsed and thrown away —
 * and there is no way to evict the old ones without scanning every key another
 * script has ever written. One record makes eviction a slice.
 */

import { isScopeKind, type ScopeRef } from "./route.js";
import { isViewMode, type ViewMode } from "./view-mode.js";

export interface WorkspaceSession {
  /** The file that was open; null when none has been opened yet. */
  filePath: string | null;
  /** How that file was being read; null when no file has been opened yet. */
  mode: ViewMode | null;
  /** Unfolded directories, as workspace-relative paths. */
  expanded: readonly string[];
}

export interface SessionStore {
  /** Workspace keys, most recently used first. Eviction cuts the tail. */
  order: readonly string[];
  sessions: Readonly<Record<string, WorkspaceSession>>;
}

export const EMPTY_STORE: SessionStore = { order: [], sessions: {} };

const STORAGE_KEY = "file-browser:sessions";

/** Workspaces remembered at once. Past this, the least recent is dropped. */
const MAX_WORKSPACES = 24;

/**
 * Unfolded directories remembered per workspace. A deep checkout browsed for a
 * while can accumulate hundreds; a cap keeps the record small enough that
 * writing it on every click stays cheap.
 */
const MAX_EXPANDED = 500;

export function scopeKey(scope: ScopeRef): string {
  return `${scope.kind}:${scope.id}`;
}

/** The inverse of {@link scopeKey}; null for a key that is not one. */
export function parseScopeKey(key: string): ScopeRef | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!isScopeKind(kind) || id === "") return null;
  return { kind, id };
}

/**
 * The workspace used most recently — what a visit with no workspace in the
 * route falls back to. It is the head of the order, so remembering it costs
 * nothing beyond the sessions already being kept.
 */
export function lastScope(store: SessionStore): ScopeRef | null {
  for (const key of store.order) {
    const scope = parseScopeKey(key);
    if (scope !== null) return scope;
  }
  return null;
}

export function sessionFor(
  store: SessionStore,
  key: string,
): WorkspaceSession | null {
  return store.sessions[key] ?? null;
}

/**
 * Fold one workspace's session into the store, as the most recent.
 *
 * A null `filePath` or `mode` KEEPS whatever was remembered rather than clearing
 * it: nothing in this UI closes a file, so the only way to see null is a
 * workspace whose route has not been restored yet — and letting that overwrite
 * the record would erase the very thing the restore is about to read.
 */
export function withSession(
  store: SessionStore,
  key: string,
  session: WorkspaceSession,
): SessionStore {
  const previous = sessionFor(store, key);
  const merged: WorkspaceSession = {
    filePath: session.filePath ?? previous?.filePath ?? null,
    mode: session.mode ?? previous?.mode ?? null,
    expanded: session.expanded.slice(0, MAX_EXPANDED),
  };

  const order = [key, ...store.order.filter((other) => other !== key)].slice(
    0,
    MAX_WORKSPACES,
  );
  const kept = new Set(order);
  const sessions: Record<string, WorkspaceSession> = { [key]: merged };
  for (const [otherKey, otherSession] of Object.entries(store.sessions)) {
    if (otherKey !== key && kept.has(otherKey)) sessions[otherKey] = otherSession;
  }

  return { order, sessions };
}

/**
 * Anything can be in localStorage — a record this plugin wrote two versions
 * ago, or something another script put under the key — so it is narrowed field
 * by field rather than trusted, and a record that does not narrow is discarded
 * rather than allowed to throw out of a render.
 */
export function parseStore(raw: string | null): SessionStore {
  if (raw === null) return EMPTY_STORE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STORE;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_STORE;

  const record: Record<string, unknown> = { ...parsed };
  const sessions: Record<string, WorkspaceSession> = {};
  if (typeof record.sessions === "object" && record.sessions !== null) {
    for (const [key, value] of Object.entries(record.sessions)) {
      const session = narrowSession(value);
      if (session !== null) sessions[key] = session;
    }
  }

  const order = Array.isArray(record.order)
    ? record.order.filter(
        (key): key is string =>
          typeof key === "string" && Object.hasOwn(sessions, key),
      )
    : [];
  // Keys present but missing from the order would never be evicted; put them
  // at the tail so they are the first to go.
  const ordered = new Set(order);
  for (const key of Object.keys(sessions)) {
    if (!ordered.has(key)) order.push(key);
  }

  return { order: order.slice(0, MAX_WORKSPACES), sessions };
}

function narrowSession(value: unknown): WorkspaceSession | null {
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const filePath =
    typeof record.filePath === "string" && record.filePath !== ""
      ? record.filePath
      : null;
  const expanded = Array.isArray(record.expanded)
    ? record.expanded
        .filter((path): path is string => typeof path === "string" && path !== "")
        .slice(0, MAX_EXPANDED)
    : [];
  // A mode this version does not have — or one a future version adds and this
  // one does not know — falls back to being decided from the file itself.
  const mode = isViewMode(record.mode) ? record.mode : null;
  return { filePath, mode, expanded };
}

export function readStore(): SessionStore {
  try {
    return parseStore(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be unavailable (private mode, an embedded webview); the
    // browser simply starts from a collapsed tree.
    return EMPTY_STORE;
  }
}

export function readLastScope(): ScopeRef | null {
  return lastScope(readStore());
}

export function readSession(scope: ScopeRef | null): WorkspaceSession | null {
  if (scope === null) return null;
  return sessionFor(readStore(), scopeKey(scope));
}

export function saveSession(scope: ScopeRef, session: WorkspaceSession): void {
  try {
    const next = withSession(readStore(), scopeKey(scope), session);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The preference simply does not persist.
  }
}
