// bb-plugin-code-review — frontend.
//
// Three views, one nav panel:
//   - the PR list, filtered by who was asked to review;
//   - a PR's issue list: one compact row per finding, plus a way into GitHub;
//   - an issue, with its detail on top and the code it points at below.
//
// The panel remembers the repo and filter server-side, so re-opening the tab
// resumes where it left off instead of asking again.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_Diff as BbDiff,
  experimental_useAppPanel,
  Markdown,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { FindingDto, PullRequestDto, ReviewDto, rpcContract } from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  BOUNDS_SYNC_EVENT,
  getDesktopBrowser,
  hideView,
  measureBounds,
  navigateView,
  sameBounds,
  showView,
  type DesktopBrowser,
  type DesktopBrowserBounds,
  type DesktopBrowserState,
} from "@/lib/desktop-browser";
import { cn } from "@/lib/utils";

const PANEL_ID = "code-review";
/** Panel position only; the broad "changed" signal is for review data. */
const PANEL_STATE_CHANGED = "code-review-panel-state-changed";
const PANEL_PATH = "code-review";
const ANY_TEAM = "__any__";
/** Context ladder for the snippet "more context" control. */
const CONTEXT_STEPS = [3, 25, 100] as const;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type PrFilter =
  // "mine" is a review requested from you; "authored" is a PR you opened.
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "my-teams" }
  | { kind: "team"; teamSlug: string }
  | { kind: "authored" };

/** One place a finding points at, with its code. Mirrors the RPC output. */
interface LocationDto {
  file: string;
  startLine: number | null;
  endLine: number | null;
  note: string;
  isPrimary: boolean;
  diffUrl: string;
  blobUrl: string;
  /** Markdown quoting this location, for a comment that cannot be anchored. */
  contextBlock: string;
  firstLine: number;
  lines: string[];
  inDiff: boolean;
  addedLines: number[];
  removals: Array<{ afterLine: number; lines: string[] }>;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Routing — the nav panel owns /plugins/code-review/code-review/*
// ---------------------------------------------------------------------------

type Route =
  | { kind: "list" }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "finding"; repo: string; number: number; findingId: string };

function parseSubPath(subPath: string): Route {
  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments[0] === "pr" && segments.length >= 4) {
    const number = Number(segments[3]);
    const repo = `${segments[1]}/${segments[2]}`;
    if (Number.isInteger(number) && number > 0) {
      if (segments[4] === "f" && segments[5] !== undefined) {
        return { kind: "finding", repo, number, findingId: segments[5] };
      }
      return { kind: "pr", repo, number };
    }
  }
  return { kind: "list" };
}

function routeToSubPath(route: Route): string {
  switch (route.kind) {
    case "list":
      return "";
    case "pr":
      return `pr/${route.repo}/${route.number}`;
    case "finding":
      return `pr/${route.repo}/${route.number}/f/${route.findingId}`;
  }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function reportError(cause: unknown): void {
  toast.error(cause instanceof Error ? cause.message : String(cause));
}

const SEVERITY_STYLES: Record<string, string> = {
  blocker: "border-destructive/50 text-destructive",
  high: "border-destructive/40 text-destructive",
  medium: "border-border text-foreground",
  low: "border-border text-muted-foreground",
  nit: "border-border text-muted-foreground",
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 font-medium", SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.medium)}
    >
      {severity}
    </Badge>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: IconName;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Icon name={icon} className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {detail === undefined ? null : (
        <div className="max-w-md text-xs text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}

/**
 * A link out to GitHub. Opens through BB's own URL routing — the in-app
 * browser when this client prefers it — but stays a real anchor so copy-link
 * and modifier-clicks still behave, which matters when you want to paste a
 * file link into a review.
 */
function GithubLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const navigate = useBbNavigate();
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(event) => {
        // Leave "open in a new tab" and friends to the browser.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        // A false return means this client will not handle the URL, so fall
        // through to the anchor rather than swallowing the click.
        if (navigate.openUrl(href)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

/** "just now" / "12m ago" / "3h ago" / "2d ago". */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function locationLabel(target: {
  file: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (target.startLine === null) return target.file;
  const range =
    target.endLine !== null && target.endLine !== target.startLine
      ? `${target.startLine}-${target.endLine}`
      : `${target.startLine}`;
  return `${target.file}:${range}`;
}

/**
 * Where posting this finding actually puts the comment. GitHub anchors a
 * multi-line comment at the end of the range, and a finding with no line
 * anchor can only become a general PR comment — so say which it will be
 * rather than leaving the reviewer to find out after pressing the button.
 */
function postTargetLabel(finding: FindingDto): { text: string; note: string | null } {
  const anchor = finding.postAnchor;
  if (anchor.kind === "pull-request") {
    return {
      text: "as a comment on the pull request",
      note: "This pull request does not touch that file, so the comment cannot be attached to it.",
    };
  }
  if (anchor.kind === "file") {
    return {
      text: `on the file ${finding.file}`,
      note:
        finding.startLine === null
          ? "This issue names no line, so the comment attaches to the file."
          : `GitHub anchors comments only to lines inside the diff, and ${locationLabel(finding)} ` +
            "is not one, so the comment attaches to the file instead.",
    };
  }
  const range =
    anchor.startLine !== null ? `lines ${anchor.startLine}–${anchor.line}` : `line ${anchor.line}`;
  const side = finding.side === "LEFT" ? " of the old file" : "";
  return {
    text: `on ${finding.file}, ${range}${side}`,
    note: anchor.adjusted
      ? `Narrowed from ${locationLabel(finding)}: the rest of that range is not in the diff, ` +
        "and GitHub only anchors comments inside it."
      : null,
  };
}

/**
 * Grow a textarea to fit its content. A suggested comment is usually one long
 * wrapped paragraph, so counting newlines under-sizes it and clips the text
 * the reviewer is about to publish.
 */
function useAutoSizedTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);
  return ref;
}

/**
 * The panel's stored position, following a change made anywhere — the selector
 * here, "Discuss" or "diff" on an issue, or another window.
 */
function usePanelState(rpc: Rpc) {
  const query = useLiveQuery(() => rpc.call("getPanelState"), [rpc]);
  useRealtime(PANEL_STATE_CHANGED, query.refetch);
  return query;
}

/** Refetches on mount and on every server "code-review-changed" signal. */
function useLiveQuery<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A slow gh call must not overwrite a newer result that already landed.
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setIsLoading(true);
    load().then(
      (result) => {
        if (mine !== generation.current) return;
        setData(result);
        setError(null);
        setIsLoading(false);
      },
      (cause: unknown) => {
        if (mine !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(refetch, [refetch]);
  useRealtime("code-review-changed", refetch);
  return { data, error, isLoading, refetch };
}

// ---------------------------------------------------------------------------
// The discussion tab
// ---------------------------------------------------------------------------

/**
 * The pane follows the route rather than remembering the last thread it was
 * handed. There is one conversation per review, and moving to another pull
 * request moves the pane with it — so a question is never read against, or
 * asked of, the wrong review.
 */
function DiscussionPane({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const pr = route.kind === "list" ? null : { repo: route.repo, number: route.number };
  const thread = useLiveQuery(
    () => (pr === null ? Promise.resolve(null) : rpc.call("getReviewThread", pr)),
    [rpc, pr?.repo, pr?.number],
  );

  if (pr === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="SideChat"
          title="No pull request open"
          detail="Open a pull request to see the thread that reviewed it."
        />
      </div>
    );
  }
  const threadId = thread.data?.threadId ?? null;
  if (threadId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="SideChat"
          title="No review thread yet"
          detail={`Review ${pr.repo}#${pr.number} and its thread appears here, ready for questions.`}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        key={threadId}
        threadId={threadId}
        variant="compact"
        layout="contained"
        className="min-h-0 flex-1"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pull request tab
// ---------------------------------------------------------------------------

/**
 * One tab, not two.
 *
 * BB draws a plugin's fixed tabs icon-only, and uses the plugin's own branding
 * icon for every one of them, so two tabs from this plugin are identical
 * chips telling you nothing apart from their order. Until BB can be asked for
 * a per-tab icon (see the README), the plugin contributes a single tab and
 * labels the halves itself.
 */
const reviewTabRef = { panelId: PANEL_ID, id: "review" } as const;

type SidePane = "github" | "diff" | "files" | "discussion";

/**
 * GitHub itself, in a view keyed to one pull request.
 *
 * The view is a native overlay BB's main process owns, so this component
 * renders an empty box and spends its life telling the shell where that box
 * is. Its `tabId` is the pull request, and the caller remounts on a different
 * one, so moving to another review reclaims this one's view instead of leaving
 * a GitHub page behind for the next review to trip over.
 *
 * The view itself is not tied to this component — see `showView`. Deselecting
 * the tab only hides it, so re-selecting comes back to the same page.
 */
function GithubPane({
  browser,
  tabId,
  group,
  url,
}: {
  browser: DesktopBrowser;
  tabId: string;
  /** What this view belongs to; views in one group outlive each other. */
  group: string;
  url: string;
}) {
  const navigate = useBbNavigate();
  const slot = useRef<HTMLDivElement | null>(null);
  const lastBounds = useRef<DesktopBrowserBounds | null>(null);
  // The last page this pane asked for, so browsing away from it is not undone
  // on the next render — only a new request from the panel moves the view.
  const requested = useRef(url);
  // Whether that page's anchor still needs applying. See `applyAnchor`.
  const anchorPending = useRef(url !== withoutFragment(url));
  const [state, setState] = useState<DesktopBrowserState | null>(null);

  const syncBounds = useCallback(() => {
    const element = slot.current;
    if (element === null) return;
    const bounds = measureBounds(element);
    // An unchanged rectangle is not worth an IPC round trip, and the sync
    // event fires for every layout change, most of which do not move this box.
    if (lastBounds.current !== null && sameBounds(lastBounds.current, bounds)) return;
    lastBounds.current = bounds;
    browser.setBounds({ tabId, bounds });
  }, [browser, tabId]);

  useEffect(() => {
    const element = slot.current;
    if (element === null) return;
    const bounds = measureBounds(element);
    lastBounds.current = bounds;
    // Loaded without its anchor on purpose: a fragment applied during load
    // scrolls to where the target is *then*, and GitHub's page keeps growing
    // afterwards — deferred diffs, highlighting — which leaves the view parked
    // somewhere else. The anchor goes on once the page has settled, below.
    showView(browser, { tabId, url: withoutFragment(url), bounds, group });
    const stopListening = browser.onState((next) => {
      if (next.tabId !== tabId) return;
      setState(next);
      if (!next.isLoading && anchorPending.current && next.url !== requested.current) {
        // Once only: the reader is free to scroll away afterwards, and every
        // page they load from here is theirs, not ours to re-aim.
        anchorPending.current = false;
        navigateView(browser, tabId, requested.current);
      }
    });
    return () => {
      stopListening();
      // Hidden, not destroyed: this unmounts on every deselect, and tearing
      // the view down here would reload the page each time the tab came back.
      // `showView` reclaims it once another pull request needs a view.
      hideView(browser, tabId);
      lastBounds.current = null;
    };
    // `url` is only this view's *starting* page; a later change navigates it,
    // below, rather than tearing the view down and loading it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, tabId, group]);

  useEffect(() => {
    // Skipped on the first run, where `showView` has just loaded this page.
    if (requested.current === url) return;
    requested.current = url;
    // The document is already up, so its anchor lands on settled layout.
    anchorPending.current = false;
    navigateView(browser, tabId, url);
  }, [browser, tabId, url]);

  useEffect(() => {
    const element = slot.current;
    if (element === null) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(element);
    window.addEventListener("resize", syncBounds);
    window.addEventListener(BOUNDS_SYNC_EVENT, syncBounds);
    // The overlay is positioned in window coordinates, so anything that moves
    // the box under it — including a scroll in an ancestor — has to re-measure.
    window.addEventListener("scroll", syncBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener(BOUNDS_SYNC_EVENT, syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
    };
  }, [browser, syncBounds]);

  const error = state?.errorText ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
        <IconButton
          icon="ChevronLeft"
          label="Go back"
          disabled={!(state?.canGoBack ?? false)}
          onClick={() => browser.goBack(tabId)}
        />
        <IconButton
          icon="ChevronRight"
          label="Go forward"
          disabled={!(state?.canGoForward ?? false)}
          onClick={() => browser.goForward(tabId)}
        />
        <IconButton icon="RotateCcw" label="Reload" onClick={() => browser.reload(tabId)} />
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {state?.title ?? url}
        </span>
        <IconButton
          icon="ExternalLink"
          label="Open in an external browser"
          onClick={() => navigate.openUrl(state?.url === undefined || state.url === "" ? url : state.url)}
        />
      </div>
      {error === "" ? null : <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
      {/* The native view is placed over this box; it is deliberately empty. */}
      <div ref={slot} data-testid="github-view" className="min-h-0 flex-1" />
    </div>
  );
}

function IconButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="size-7 shrink-0 p-0"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

/** One conversation or inline review comment. Mirrors the RPC output. */
interface PrCommentDto {
  author: string;
  body: string;
  createdAt: string;
  file: string | null;
  line: number | null;
}

function PrComment({ comment }: { comment: PrCommentDto }) {
  const anchor =
    comment.file === null
      ? null
      : comment.line === null
        ? comment.file
        : `${comment.file}:${comment.line}`;
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-medium">{comment.author}</span>
        {anchor === null ? null : (
          <span className="font-mono text-[11px] text-muted-foreground/80">{anchor}</span>
        )}
        <span className="text-[11px] text-muted-foreground">{relativeTime(comment.createdAt)}</span>
      </div>
      <Markdown content={comment.body} className="mt-1 text-sm" />
    </div>
  );
}

/**
 * One changed file, its patch loaded only when opened.
 *
 * A pull request's whole diff is far more than a reader needs at once, and
 * BB's diff viewer is not cheap to mount, so the list stays closed until a
 * file is asked for.
 */
function PrFile({
  rpc,
  repo,
  number,
  file,
  hasPatch,
  isTarget = false,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  file: { path: string; additions: number; deletions: number };
  hasPatch: boolean;
  /** The file the reader asked for: opens itself and scrolls into view. */
  isTarget?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(isTarget && hasPatch);
  const row = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isTarget) return;
    // Optional call: not every environment this renders in implements it, and
    // failing to scroll must not take the diff down with it.
    row.current?.scrollIntoView?.({ block: "start" });
  }, [isTarget]);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || patch !== null) return;
    let cancelled = false;
    rpc.call("getPullRequestPatch", { repo, number, file: file.path }).then(
      (result) => {
        if (!cancelled) setPatch(result.patch);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, patch, rpc, repo, number, file.path]);

  return (
    <div
      ref={row}
      className={cn("rounded-md border", isTarget ? "border-foreground/30" : "border-border")}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
        onClick={() => setIsOpen((open) => !open)}
        disabled={!hasPatch}
      >
        <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          +{file.additions} −{file.deletions}
        </span>
      </button>
      {!isOpen ? null : error !== null ? (
        <p className="px-2 pb-2 text-xs text-destructive">{error}</p>
      ) : patch === null ? (
        <Skeleton className="mx-2 mb-2 h-24" />
      ) : (
        <BbDiff patch={patch} path={file.path} className="border-t border-border" />
      )}
    </div>
  );
}

/** The pull request's changed files, each expanding to its diff. */
function ChangedFiles({
  rpc,
  pr,
  files,
  filesWithPatch,
  targetFile = null,
}: {
  rpc: Rpc;
  pr: { repo: string; number: number };
  files: Array<{ path: string; additions: number; deletions: number }>;
  filesWithPatch: string[];
  targetFile?: string | null;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {files.length === 1 ? "1 file changed" : `${files.length} files changed`}
      </h3>
      {files.map((file) => (
        <PrFile
          key={file.path}
          rpc={rpc}
          repo={pr.repo}
          number={pr.number}
          file={file}
          hasPatch={filesWithPatch.includes(file.path)}
          isTarget={file.path === targetFile}
        />
      ))}
    </section>
  );
}

/**
 * GitHub's own diff, opened on the file the reader asked for.
 *
 * Pressing "diff" on a cited location lands here rather than in a browser tab,
 * anchored at that file — the same page GitHub would have shown, in a view
 * that belongs to this review. Where there is no in-app browser to drive, the
 * pull request's files are rendered from the stored patch instead.
 */
function DiffPane({ subPath }: { subPath: string }) {
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const browser = useMemo(() => getDesktopBrowser(), []);
  const rpc = useRpc<typeof rpcContract>();
  const state = usePanelState(rpc);

  if (route.kind === "list") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="Code"
          title="No pull request open"
          detail="Open a pull request to read its diff here."
        />
      </div>
    );
  }
  if (browser !== null) {
    // Waiting for the stored request: attaching first and navigating after
    // would load the whole files page only to replace it a tick later.
    if (state.data === null) return <Skeleton className="m-3 h-40" />;
    const files = `https://github.com/${route.repo}/pull/${route.number}/files`;
    return (
      <GithubPane
        key={`${route.repo}#${route.number}`}
        browser={browser}
        tabId={`code-review:diff:${route.repo}#${route.number}`}
        group={`${route.repo}#${route.number}`}
        // The anchored URL when a location asked for one, the whole diff
        // otherwise. Changing it moves this view rather than reloading it.
        url={state.data?.diffUrl ?? files}
      />
    );
  }
  return <DiffSnapshotView repo={route.repo} number={route.number} />;
}

/**
 * The repository as the pull request sees it, at the commit under review.
 *
 * The diff only has the files the change touches, and a reviewer regularly
 * needs the ones it does not — the caller of a function being changed, the
 * test that is meant to cover it. This browses those at the reviewed commit,
 * so what is read is what the findings were written against.
 */
function FilesPane({ subPath }: { subPath: string }) {
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const browser = useMemo(() => getDesktopBrowser(), []);
  const rpc = useRpc<typeof rpcContract>();
  const pr = route.kind === "list" ? null : { repo: route.repo, number: route.number };
  const view = useLiveQuery(
    () => (pr === null ? Promise.resolve(null) : rpc.call("getPullRequestView", pr)),
    [rpc, pr?.repo, pr?.number],
  );

  if (pr === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="FolderOpen"
          title="No pull request open"
          detail="Open a pull request to browse the repository at its commit."
        />
      </div>
    );
  }
  if (view.error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon="FolderOpen" title="Could not read this pull request" detail={view.error} />
      </div>
    );
  }
  if (view.data === null) return <Skeleton className="m-3 h-40" />;

  const sha = view.data.snapshot.headSha;
  if (sha === "") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="FolderOpen"
          title="No commit to browse"
          detail="This review has no recorded commit; re-run it to browse the code it read."
        />
      </div>
    );
  }
  // The commit rather than the branch: a fork's branch does not exist under
  // this repository, but GitHub serves the pull request's commits from it.
  const tree = `https://github.com/${pr.repo}/tree/${sha}`;
  if (browser === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="FolderOpen"
          title="No in-app browser here"
          detail={
            <GithubLink href={tree} className="underline underline-offset-4">
              Browse this commit on GitHub
            </GithubLink>
          }
        />
      </div>
    );
  }
  return (
    <GithubPane
      key={`${pr.repo}#${pr.number}`}
      browser={browser}
      tabId={`code-review:files:${pr.repo}#${pr.number}`}
      group={`${pr.repo}#${pr.number}`}
      url={tree}
    />
  );
}

/** The pull request's files from the stored patch, for a client with no browser. */
function DiffSnapshotView({ repo, number }: { repo: string; number: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const pr = useMemo(() => ({ repo, number }), [repo, number]);
  const view = useLiveQuery(() => rpc.call("getPullRequestView", pr), [rpc, pr]);
  const state = usePanelState(rpc);

  if (view.error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon="Code" title="Could not read this diff" detail={view.error} />
      </div>
    );
  }
  if (view.data === null) return <Skeleton className="m-3 h-40" />;

  const files = view.data.snapshot.files;
  // A file from another review's request is not in this pull request, so it
  // would silently open nothing; ignoring it opens the list instead.
  const requested = state.data?.diffFile ?? null;
  const targetFile = files.some((file) => file.path === requested) ? requested : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {files.length === 0 ? (
        <EmptyState icon="Code" title="No files changed" detail="This pull request is empty." />
      ) : (
        <ChangedFiles
          rpc={rpc}
          pr={pr}
          files={files}
          filesWithPatch={view.data.filesWithPatch}
          targetFile={targetFile}
        />
      )}
    </div>
  );
}

/**
 * The pull request, in a tab this plugin owns.
 *
 * BB's own Browser tabs are shared across the whole panel, so a GitHub page
 * opened for one review stays open while you read another. This follows the
 * route instead, the way the discussion pane does, so what it shows is always
 * the pull request in front of you.
 *
 * On the desktop it is GitHub itself. Where BB has no in-app browser to drive
 * — the web build — it falls back to rendering the pull request from the
 * snapshot the plugin already stores.
 */
function PullRequestPane({ subPath }: { subPath: string }) {
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const browser = useMemo(() => getDesktopBrowser(), []);

  if (route.kind === "list") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="Github"
          title="No pull request open"
          detail="Open a pull request to read it here."
        />
      </div>
    );
  }
  if (browser !== null) {
    return (
      <GithubPane
        key={`${route.repo}#${route.number}`}
        browser={browser}
        tabId={`code-review:${route.repo}#${route.number}`}
        group={`${route.repo}#${route.number}`}
        url={`https://github.com/${route.repo}/pull/${route.number}`}
      />
    );
  }
  return <PullRequestSnapshotView repo={route.repo} number={route.number} />;
}

/**
 * The stored pull request, for a client with no in-app browser to drive.
 *
 * Takes the pull request rather than the route: the tab has already decided
 * there is one, so this never has to answer for the case where there is not.
 */
function PullRequestSnapshotView({ repo, number }: { repo: string; number: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const pr = useMemo(() => ({ repo, number }), [repo, number]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const view = useLiveQuery(() => rpc.call("getPullRequestView", pr), [rpc, pr]);

  if (view.error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="GitPullRequest"
          title="Could not read this pull request"
          detail={view.error}
        />
      </div>
    );
  }
  if (view.data === null) {
    return <Skeleton className="m-3 h-40" />;
  }

  const { snapshot, filesWithPatch, url, isReviewedCommit } = view.data;
  const refresh = () => {
    setIsRefreshing(true);
    rpc
      .call("getPullRequestView", { ...pr, refresh: true })
      .then(() => view.refetch(), reportError)
      .finally(() => setIsRefreshing(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium">{snapshot.title}</h2>
          <GithubLink
            href={url}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            <Icon name="ExternalLink" className="size-3.5" />#{pr.number}
          </GithubLink>
        </div>
        <p className="text-xs text-muted-foreground">
          {snapshot.author} wants to merge{" "}
          <span className="font-mono">{snapshot.headRefName}</span> into{" "}
          <span className="font-mono">{snapshot.baseRefName}</span>
          {snapshot.isDraft ? " · draft" : ""}
        </p>
        {/* A reviewed PR is pinned to the commit its findings were written
            against, so refreshing it would move the code out from under them. */}
        {isReviewedCommit ? (
          <p className="text-[11px] text-muted-foreground/80">
            As reviewed, at <span className="font-mono">{snapshot.headSha.slice(0, 7)}</span>. Re-run
            the review to see a newer commit.
          </p>
        ) : (
          <button
            type="button"
            className="self-start text-[11px] text-muted-foreground underline-offset-4 hover:underline"
            disabled={isRefreshing}
            onClick={refresh}
          >
            {isRefreshing ? "Refreshing…" : "Refresh from GitHub"}
          </button>
        )}
      </div>

      {snapshot.body.trim() === "" ? null : (
        <Markdown content={snapshot.body} className="text-sm" />
      )}

      {snapshot.comments.length + snapshot.reviewComments.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Conversation
          </h3>
          {[...snapshot.comments, ...snapshot.reviewComments].map((comment, index) => (
            <PrComment key={index} comment={comment} />
          ))}
        </section>
      )}

      <ChangedFiles rpc={rpc} pr={pr} files={snapshot.files} filesWithPatch={filesWithPatch} />
    </div>
  );
}

/**
 * The plugin's side tab: GitHub or the review's conversation, chosen here
 * because BB's own tab chips cannot tell two of this plugin's tabs apart.
 *
 * The choice is stored with the rest of the panel's position, so it survives
 * the tab being deselected — which unmounts this component every time.
 */
function ReviewSideTab({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const state = usePanelState(rpc);
  // Shown immediately on a click, so the pane does not wait for the round trip.
  const [chosen, setChosen] = useState<SidePane | null>(null);
  const isLoaded = state.data !== null || state.error !== null;
  // Null until the stored choice lands. Guessing "github" in the meantime
  // would flash the wrong view — and attach a browser view only to tear it
  // straight back down — every time the tab is opened on another one.
  const pane = chosen ?? state.data?.sidePane ?? (isLoaded ? "github" : null);

  // A stored choice that has caught up with the click is no longer an override.
  useEffect(() => {
    if (chosen !== null && state.data?.sidePane === chosen) setChosen(null);
  }, [chosen, state.data?.sidePane]);

  const choose = useCallback(
    (next: SidePane) => {
      setChosen(next);
      rpc.call("setPanelState", { sidePane: next }).catch(ignore);
    },
    [rpc],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={pane ?? "github"}
        onValueChange={(value) => choose(isSidePane(value) ? value : "github")}
        className="shrink-0 border-b border-border px-2 py-1.5"
      >
        <TabsList className="h-7">
          <TabsTrigger value="github" className="h-6 gap-1.5 px-2 text-xs">
            <Icon name="Github" className="size-3.5" />
            Pull request
          </TabsTrigger>
          <TabsTrigger value="diff" className="h-6 gap-1.5 px-2 text-xs">
            <Icon name="Code" className="size-3.5" />
            Diff
          </TabsTrigger>
          <TabsTrigger value="files" className="h-6 gap-1.5 px-2 text-xs">
            <Icon name="FolderOpen" className="size-3.5" />
            Files
          </TabsTrigger>
          <TabsTrigger value="discussion" className="h-6 gap-1.5 px-2 text-xs">
            <Icon name="SideChat" className="size-3.5" />
            Discussion
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex min-h-0 flex-1 flex-col">
        {pane === null ? null : pane === "github" ? (
          <PullRequestPane subPath={subPath} />
        ) : pane === "diff" ? (
          <DiffPane subPath={subPath} />
        ) : pane === "files" ? (
          <FilesPane subPath={subPath} />
        ) : (
          <DiscussionPane subPath={subPath} />
        )}
      </div>
    </div>
  );
}

/** A URL with any `#fragment` removed. */
function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function isSidePane(value: string): value is SidePane {
  return value === "github" || value === "diff" || value === "files" || value === "discussion";
}

function ignore(): void {}

/**
 * Bring one half of the review's side pane forward.
 *
 * The half is written to the panel's stored position rather than passed to the
 * tab, so it lands whether the tab is closed, showing the other half, or open
 * in another window.
 */
function useOpenSidePane(
  rpc: Rpc,
): (pane: SidePane, target?: { file: string; url: string }) => void {
  const panel = experimental_useAppPanel();
  return useCallback(
    (pane: SidePane, target?: { file: string; url: string }) => {
      rpc
        .call("setPanelState", {
          sidePane: pane,
          // Cleared when no location was asked for, so the diff does not
          // reopen on whatever the last finding happened to point at. The file
          // drives the fallback view; the URL drives GitHub's own.
          diffFile: target?.file ?? null,
          diffUrl: target?.url ?? null,
        })
        .catch(ignore);
      if (!panel.openFixedTab({ surface: { kind: "current" }, tab: reviewTabRef })) {
        toast.error("Could not open the review tab.");
      }
    },
    [panel, rpc],
  );
}

// ---------------------------------------------------------------------------
// The PR list
// ---------------------------------------------------------------------------

type FilterTab = "mine" | "teams" | "all" | "authored";

function tabAndTeamFor(filter: PrFilter): { tab: FilterTab; team: string } {
  switch (filter.kind) {
    case "all":
      return { tab: "all", team: ANY_TEAM };
    case "mine":
      return { tab: "mine", team: ANY_TEAM };
    case "my-teams":
      return { tab: "teams", team: ANY_TEAM };
    case "team":
      return { tab: "teams", team: filter.teamSlug };
    case "authored":
      return { tab: "authored", team: ANY_TEAM };
  }
}

function reviewBadge(pr: PullRequestDto): ReactNode {
  switch (pr.reviewStatus) {
    case "running":
    case "queued":
      return (
        <Badge variant="outline" className="gap-1 border-border text-muted-foreground">
          <Icon name="Spinner" className="size-3 animate-spin" />
          reviewing
        </Badge>
      );
    case "reported":
      return (
        <Badge variant="outline" className="border-border">
          {pr.openFindings} open
          {pr.postedFindings > 0 ? ` · ${pr.postedFindings} posted` : ""}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="border-destructive/40 text-destructive">
          review failed
        </Badge>
      );
    default:
      return null;
  }
}

function PrRow({ pr, onOpen }: { pr: PullRequestDto; onOpen: () => void }) {
  const requestedTeams = pr.reviewRequests
    .map((request) => request.teamSlug)
    .filter((slug): slug is string => slug !== null)
    .map((slug) => slug.split("/").pop() ?? slug);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <div className="flex items-start gap-2">
        <Icon
          name={pr.isDraft ? "GitPullRequestDraft" : "GitPullRequest"}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            pr.isDraft ? "text-muted-foreground" : "text-foreground",
          )}
        />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{pr.title}</span>
        {reviewBadge(pr)}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
        <span>#{pr.number}</span>
        <span>·</span>
        <span>{pr.author}</span>
        <span>·</span>
        <span className="text-foreground/70">+{pr.additions}</span>
        <span className="text-foreground/70">−{pr.deletions}</span>
        <span>
          in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
        </span>
        {requestedTeams.length > 0 ? (
          <>
            <span>·</span>
            <span>team: {requestedTeams.join(", ")}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function PrListView({
  rpc,
  repo,
  repos,
  filter,
  onRepoChange,
  onFilterChange,
  myTeams,
  onOpenPr,
}: {
  rpc: Rpc;
  repo: string | null;
  repos: string[];
  filter: PrFilter;
  onRepoChange: (repo: string) => void;
  onFilterChange: (filter: PrFilter) => void;
  myTeams: string[];
  onOpenPr: (repo: string, number: number) => void;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { tab, team } = tabAndTeamFor(filter);

  const filterKey = JSON.stringify(filter);
  const { data, error, isLoading, refetch } = useLiveQuery(
    async () =>
      repo === null
        ? { fetchedAt: "", pullRequests: [] as PullRequestDto[] }
        : rpc.call("listPullRequests", { repo, filter }),
    [rpc, repo, filterKey],
  );

  const refresh = useCallback(() => {
    if (repo === null) return;
    setIsRefreshing(true);
    rpc
      .call("listPullRequests", { repo, filter, refresh: true })
      .then(() => refetch(), reportError)
      .finally(() => setIsRefreshing(false));
  }, [repo, rpc, filter, refetch]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={repo ?? ""} onValueChange={onRepoChange}>
          <SelectTrigger className="h-8 w-[16rem] text-xs">
            <SelectValue placeholder="Pick a repository" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((name) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs
          value={tab}
          onValueChange={(next) => {
            if (next === "all") onFilterChange({ kind: "all" });
            else if (next === "mine") onFilterChange({ kind: "mine" });
            else if (next === "authored") onFilterChange({ kind: "authored" });
            else {
              onFilterChange(
                team === ANY_TEAM ? { kind: "my-teams" } : { kind: "team", teamSlug: team },
              );
            }
          }}
        >
          <TabsList className="h-8">
            <TabsTrigger value="mine" className="text-xs">
              Asked me
            </TabsTrigger>
            <TabsTrigger value="teams" className="text-xs">
              Asked my team
            </TabsTrigger>
            <TabsTrigger value="all" className="text-xs">
              All open
            </TabsTrigger>
            <TabsTrigger value="authored" className="text-xs">
              Mine
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "teams" ? (
          <Select
            value={team}
            onValueChange={(next) =>
              onFilterChange(
                next === ANY_TEAM ? { kind: "my-teams" } : { kind: "team", teamSlug: next },
              )
            }
          >
            <SelectTrigger className="h-8 w-[15rem] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_TEAM} className="text-xs">
                Any of my teams
              </SelectItem>
              {myTeams.map((slug) => (
                <SelectItem key={slug} value={slug} className="text-xs">
                  {slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={refresh}
          disabled={repo === null || isRefreshing}
        >
          <Icon
            name="ArrowReloadHorizontal"
            className={cn("size-3.5", isRefreshing && "animate-spin")}
          />
          Refresh
        </Button>
        {/* The list never refreshes on its own now, so say how old it is. */}
        {data?.fetchedAt ? (
          <span className="text-xs text-muted-foreground">
            updated {relativeTime(data.fetchedAt)}
          </span>
        ) : null}
      </div>

      {tab === "teams" && myTeams.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No teams found. `gh api /user/teams` needs the `read:org` scope — run{" "}
          <code className="font-mono">gh auth refresh -s read:org</code>, or list your teams in
          the plugin&apos;s Teams setting.
        </p>
      ) : null}

      {repo === null ? (
        <EmptyState
          icon="FolderGit"
          title="No repositories"
          detail="Add owner/repo lines to the plugin's Repositories setting, or open a BB project whose checkout has a GitHub origin remote."
        />
      ) : error !== null ? (
        <EmptyState icon="AlertTriangle" title="Could not list pull requests" detail={error} />
      ) : isLoading && data === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : data === null || data.pullRequests.length === 0 ? (
        <EmptyState
          icon="GitPullRequest"
          title={tab === "authored" ? "Nothing here" : "Nothing to review"}
          detail={
            tab === "mine"
              ? "No open pull request in this repo has a review request for you."
              : tab === "teams"
                ? "No open pull request in this repo has a review request for these teams."
                : tab === "authored"
                  ? "You have no open pull requests in this repo."
                  : "This repo has no open pull requests from anyone else."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {data.pullRequests.map((pr) => (
            <PrRow key={pr.number} pr={pr} onOpen={() => onOpenPr(pr.repo, pr.number)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A PR's issue list
// ---------------------------------------------------------------------------

function FindingRow({ finding, onOpen }: { finding: FindingDto; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
        finding.state === "dismissed" && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{finding.title}</span>
        {finding.state === "posted" ? (
          <Badge variant="outline" className="shrink-0 gap-1 border-border">
            <Icon name="Check" className="size-3" />
            {finding.postedAs === "pending-review" ? "drafted" : "posted"}
          </Badge>
        ) : null}
        <Icon name="ChevronRight" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </div>
      {/* The gist, clamped to three lines — the point of this row. */}
      <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{finding.gist}</p>
      <p className="font-mono text-[11px] text-muted-foreground/80">{locationLabel(finding)}</p>
    </button>
  );
}

function ReviewControls({
  rpc,
  repo,
  number,
  review,
  skills,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  review: ReviewDto | null;
  skills: string[];
}) {
  const [isStarting, setIsStarting] = useState(false);
  const openSidePane = useOpenSidePane(rpc);
  const isRunning = review !== null && (review.status === "running" || review.status === "queued");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={isStarting || isRunning}
          onClick={() => {
            setIsStarting(true);
            rpc
              .call("startReview", { repo, number })
              .then(() => toast.success("Review started"), reportError)
              .finally(() => setIsStarting(false));
          }}
        >
          <Icon
            name={isRunning ? "Spinner" : "Bot"}
            className={cn("size-3.5", isRunning && "animate-spin")}
          />
          {isRunning ? "Reviewing…" : review === null ? "Review this PR" : "Re-run review"}
        </Button>
        {/* Opens the side pane rather than navigating to the thread: the
            review stays on screen beside the conversation about it. */}
        {review?.threadId == null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => openSidePane("discussion")}
          >
            <Icon name="SideChat" className="size-3.5" />
            Review thread
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {skills.length === 0 ? "Generic review" : `Skills: ${skills.join(", ")}`}
        </span>
      </div>
      {review?.error != null ? <p className="text-xs text-destructive">{review.error}</p> : null}
    </div>
  );
}

function PrFindingsView({
  rpc,
  repo,
  number,
  skills,
  onBack,
  onOpenFinding,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  skills: string[];
  onBack: () => void;
  onOpenFinding: (findingId: string) => void;
}) {
  const openSidePane = useOpenSidePane(rpc);
  const { data, error, isLoading } = useLiveQuery(
    () => rpc.call("getPullRequest", { repo, number }),
    [rpc, repo, number],
  );

  const grouped = useMemo(() => {
    const findings = data?.findings ?? [];
    return {
      open: findings.filter((finding) => finding.state === "open"),
      posted: findings.filter((finding) => finding.state === "posted"),
      dismissed: findings.filter((finding) => finding.state === "dismissed"),
    };
  }, [data]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All pull requests" />
        <EmptyState icon="AlertTriangle" title="Could not load this pull request" detail={error} />
      </div>
    );
  }
  if (isLoading && data === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All pull requests" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }
  const pr = data?.pullRequest ?? null;
  const isEmpty =
    grouped.open.length === 0 && grouped.posted.length === 0 && grouped.dismissed.length === 0;

  const section = (title: string, findings: FindingDto[]) =>
    findings.length === 0 ? null : (
      <Section key={title} title={`${title} (${findings.length})`}>
        <div className="flex flex-col gap-2">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              onOpen={() => onOpenFinding(finding.id)}
            />
          ))}
        </div>
      </Section>
    );

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="All pull requests" />

      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <Icon name="GitPullRequest" className="mt-1 size-4 shrink-0" />
          <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
            {pr?.title ?? `Pull request #${number}`}
          </h2>
          {/* Our own tab, not a BB browser tab: those are shared across the
              whole panel and outlive the review they were opened for. */}
          <Button
            variant="outline"
            size="sm"
            className="mt-0.5 h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => openSidePane("github")}
          >
            <Icon name="Github" className="size-3.5" />
            Show pull request
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
          <span>
            {repo}#{number}
          </span>
          {pr === null ? null : (
            <>
              <span>·</span>
              <span>{pr.author}</span>
              <span>·</span>
              <span>
                {pr.headRefName} → {pr.baseRefName}
              </span>
              <span>·</span>
              <span className="text-foreground/70">+{pr.additions}</span>
              <span className="text-foreground/70">−{pr.deletions}</span>
              <span>
                in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
      </div>

      <ReviewControls
        rpc={rpc}
        repo={repo}
        number={number}
        review={data?.review ?? null}
        skills={data?.review?.skills ?? skills}
      />

      {isEmpty ? (
        <EmptyState
          icon="Bug"
          title={
            data?.review == null
              ? "No review yet"
              : data.review.status === "reported"
                ? "No issues found"
                : "Review in progress"
          }
          detail={
            data?.review == null
              ? 'Press "Review this PR" to run your review skills against this change.'
              : data.review.status === "reported"
                ? "The review finished without raising anything."
                : "The review thread is working. Issues appear here as soon as it submits them."
          }
        />
      ) : (
        <>
          {section("Issues", grouped.open)}
          {section("Posted", grouped.posted)}
          {section("Dismissed", grouped.dismissed)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One issue, with the code it points at
// ---------------------------------------------------------------------------

/**
 * A snippet with real file line numbers. BB's SourceCode component numbers an
 * excerpt from 1, which would misreport every line — and these line numbers
 * are exactly what the reviewer is checking against the finding.
 */
/** One rendered row: a line of the file, or a line the pull request deleted. */
interface SnippetRow {
  key: string;
  /** Null for a deleted line, which has no place in the file being shown. */
  lineNumber: number | null;
  text: string;
  change: "added" | "removed" | "unchanged";
}

/**
 * The file at the reviewed commit, with the pull request's own changes marked.
 *
 * This is deliberately the file rather than a patch — that is what makes the
 * line numbers match the finding and lets the reader ask for more context —
 * but a plain file cannot say whether a line is new, and the lines the change
 * deleted are not in it at all. Both are folded back in here, in BB's own diff
 * colours, so it is obvious which code the pull request is responsible for.
 */
function snippetRows(location: LocationDto): SnippetRow[] {
  const added = new Set(location.addedLines);
  const removedAfter = new Map(location.removals.map((entry) => [entry.afterLine, entry.lines]));
  const rows: SnippetRow[] = [];

  const pushRemovals = (afterLine: number) => {
    (removedAfter.get(afterLine) ?? []).forEach((text, index) => {
      rows.push({ key: `-${afterLine}.${index}`, lineNumber: null, text, change: "removed" });
    });
  };

  // Deletions above the first line shown belong at the top of the window.
  pushRemovals(location.firstLine - 1);
  location.lines.forEach((text, index) => {
    const lineNumber = location.firstLine + index;
    rows.push({
      key: `${lineNumber}`,
      lineNumber,
      text,
      change: added.has(lineNumber) ? "added" : "unchanged",
    });
    pushRemovals(lineNumber);
  });
  return rows;
}

const CHANGE_MARKS: Record<SnippetRow["change"], string> = {
  added: "+",
  removed: "−",
  unchanged: " ",
};

/**
 * One background per row: the diff colour where the pull request touched the
 * line, the citation tint where it did not.
 *
 * A cited line that is also a changed line keeps the diff colour — losing it
 * there would hide the change on exactly the lines the finding is about — and
 * is marked as cited by the rule down its left edge instead.
 */
function rowBackground(change: SnippetRow["change"], isCited: boolean): string {
  if (change === "added") return isCited ? "bg-diff-added/30" : "bg-diff-added/15";
  if (change === "removed") {
    return cn("text-muted-foreground", isCited ? "bg-diff-removed/30" : "bg-diff-removed/15");
  }
  return isCited ? "bg-accent/60" : "";
}

function CodeSnippet({ location }: { location: LocationDto }) {
  const from = location.startLine;
  const to = location.endLine ?? location.startLine;
  const rows = useMemo(() => snippetRows(location), [location]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {rows.map((row) => {
            const isCited =
              row.lineNumber !== null &&
              from !== null &&
              row.lineNumber >= from &&
              row.lineNumber <= (to ?? from);
            return (
              <tr key={row.key} className={rowBackground(row.change, isCited)}>
                <td
                  className={cn(
                    "w-[1%] select-none whitespace-nowrap border-r border-l-2 border-border px-2 py-px text-right align-top text-muted-foreground/70",
                    // Transparent when not cited, so every row stays aligned.
                    isCited ? "border-l-foreground/40" : "border-l-transparent",
                  )}
                >
                  {row.lineNumber ?? ""}
                </td>
                <td
                  className={cn(
                    "w-[1%] select-none px-1 py-px text-center align-top",
                    row.change === "added" && "text-diff-added",
                    row.change === "removed" && "text-diff-removed",
                  )}
                  aria-label={
                    row.change === "unchanged" ? undefined : `Line ${row.change} by this pull request`
                  }
                >
                  {CHANGE_MARKS[row.change]}
                </td>
                <td className="whitespace-pre px-2 py-px">{row.text === "" ? " " : row.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What this pull request did to the lines on show, in a few words. */
function locationChangeLabel(location: LocationDto): string {
  if (!location.inDiff) return "Not changed by this PR";
  const added = location.addedLines.length;
  const removed = location.removals.reduce((total, entry) => total + entry.lines.length, 0);
  if (added === 0 && removed === 0) return "Changed elsewhere in this file";
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return `${parts.join(" ")} here`;
}

function LocationCard({ location, onShowDiff }: { location: LocationDto; onShowDiff: () => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <GithubLink
          href={location.diffUrl}
          className="min-w-0 flex-1 truncate font-mono text-xs underline-offset-4 hover:underline"
          title={`Open ${location.file} in the pull request diff on GitHub`}
        >
          {locationLabel(location)}
        </GithubLink>
        {/* Every card says where it stands, so an uncoloured snippet is never
            left ambiguous between "the PR did not touch this" and "the PR
            touched this file, but not the lines you are looking at". */}
        <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
          {locationChangeLabel(location)}
        </Badge>
        {/* Our own diff view, not GitHub's: a browser tab opened from here
            would outlive the review it was opened for. */}
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={onShowDiff}
          disabled={!location.inDiff}
          title={
            location.inDiff
              ? `Show ${location.file} in the diff`
              : "This pull request does not change this file"
          }
        >
          <Icon name="Code" className="size-3.5" />
          diff
        </button>
      </div>
      {location.note === "" ? null : (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {location.note}
        </p>
      )}
      {location.error !== null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{location.error}</p>
      ) : location.lines.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No lines to show.</p>
      ) : (
        <CodeSnippet location={location} />
      )}
    </div>
  );
}

function FindingActions({
  rpc,
  finding,
  diffUrl,
  primaryLocation,
  hasPendingReview,
  onAsk,
}: {
  rpc: Rpc;
  finding: FindingDto;
  /** The finding's own place in the PR diff, when the code has been resolved. */
  diffUrl?: string;
  /** The finding's own code, for quoting into a general comment. */
  primaryLocation?: LocationDto;
  /** The reviewer already has an unsubmitted review open on this PR. */
  hasPendingReview: boolean;
  /** Puts a question about this finding to the thread that ran the review. */
  onAsk: (question: string) => Promise<void>;
}) {
  const stored = finding.draftComment ?? finding.suggestedComment;
  const [comment, setComment] = useState(stored);
  const [isBusy, setIsBusy] = useState(false);
  const [inlineFailed, setInlineFailed] = useState(false);
  // null while the question box is closed, so "Discuss" opens it rather than
  // sending anything: the thread is shared with every other finding, and an
  // unprompted message in it is noise the reviewer did not ask for.
  const [question, setQuestion] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  // Adopt server-side changes (a re-run, another window) without clobbering an
  // edit in progress: the stored value is the identity of the draft.
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current !== stored) {
      lastStored.current = stored;
      setComment(stored);
    }
  }, [stored]);

  const isDirty = comment !== stored;
  const isPosted = finding.state === "posted";
  const commentRef = useAutoSizedTextarea(comment);
  const target = postTargetLabel(finding);
  const attachesToFile = finding.postAnchor.kind !== "line";
  // A general comment lands at the bottom of the conversation with no code
  // beside it, so a comment written about a line needs to carry its own
  // context. Offered rather than applied: the body is posted verbatim, and
  // that stays true only if what is in the box is all there is.
  // A comment that is not anchored to the lines has to carry them, or it reads
  // as a remark about nothing. Added automatically rather than offered: there
  // is no case where the reviewer wants the contextless version.
  const contextBlock =
    attachesToFile && primaryLocation !== undefined && primaryLocation.contextBlock !== ""
      ? primaryLocation.contextBlock
      : null;
  const hasContext = contextBlock !== null && comment.includes(contextBlock);
  const bodyToPost = contextBlock !== null && !hasContext ? `${contextBlock}\n\n${comment}` : comment;
  // A comment added to an unsubmitted review is a draft: nobody else can see
  // it until the review is submitted on GitHub.
  const isDraft = isPosted && finding.postedAs === "pending-review";

  const save = useCallback(
    () =>
      rpc
        .call("setFindingComment", { findingId: finding.id, comment })
        .then(() => undefined, reportError),
    [rpc, finding.id, comment],
  );

  const ask = useCallback(async () => {
    const text = question?.trim() ?? "";
    if (text === "") return;
    setIsAsking(true);
    try {
      await onAsk(text);
      // Closing on success keeps the box a one-question affair; the
      // conversation itself continues in the discussion pane.
      setQuestion(null);
    } catch (cause) {
      reportError(cause);
    } finally {
      setIsAsking(false);
    }
  }, [question, onAsk]);

  const post = useCallback(
    async (mode: "inline" | "issue" | "review") => {
      setIsBusy(true);
      try {
        // Persist exactly what is posted, so the record matches GitHub.
        if (isDirty || bodyToPost !== stored) {
          await rpc
            .call("setFindingComment", { findingId: finding.id, comment: bodyToPost })
            .then(() => undefined, reportError);
        }
        await rpc.call("postFinding", { findingId: finding.id, mode });
        toast.success("Comment posted");
        setInlineFailed(false);
      } catch (cause) {
        reportError(cause);
        if (mode === "inline") setInlineFailed(true);
      } finally {
        setIsBusy(false);
      }
    },
    [rpc, finding.id, isDirty, stored, bodyToPost],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isPosted ? (isDraft ? "Draft comment" : "Posted comment") : "Comment to post"}
        </p>
        {isDirty && !isPosted ? (
          <span className="text-xs text-muted-foreground">unsaved edit</span>
        ) : finding.draftComment !== null ? (
          <span className="text-xs text-muted-foreground">edited</span>
        ) : null}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        {isPosted ? (isDraft ? "Drafted " : "Posted ") : "Posts "}
        {diffUrl === undefined || attachesToFile ? (
          <span className="font-mono">{target.text}</span>
        ) : (
          <GithubLink href={diffUrl} className="font-mono underline-offset-4 hover:underline">
            {target.text}
          </GithubLink>
        )}
      </p>
      {target.note === null ? null : (
        <p className="-mt-1 text-xs text-muted-foreground/80">{target.note}</p>
      )}
      {!isPosted && contextBlock !== null && !hasContext ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          The lines this is about are not shown beside a {finding.postAnchor.kind === "file"
            ? "file"
            : "pull request"}{" "}
          comment, so a link and the code will be added above your text when you post.
        </p>
      ) : null}
      {!isPosted && hasPendingReview && !attachesToFile ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          You have a review open on this pull request, so this joins it as a draft alongside the
          comments you made on GitHub. Submit that review on GitHub to publish them together.
        </p>
      ) : null}
      {isDraft ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          You have a review open on this pull request, so this was added to it as a draft.
          Submit that review on GitHub to publish it.
        </p>
      ) : null}
      {isPosted ? (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-sm">
          {comment}
        </div>
      ) : (
        <Textarea
          ref={commentRef}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onBlur={() => {
            if (isDirty) void save();
          }}
          rows={1}
          // Height is managed by useAutoSizedTextarea; hide the scrollbar it
          // would otherwise show while growing.
          className="resize-none overflow-hidden text-sm"
          aria-label={`Comment for ${finding.title}`}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isPosted ? (
          finding.commentUrl === null ? null : (
            <GithubLink
              href={finding.commentUrl}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              <Icon name="ExternalLink" className="size-3.5" />
              View on GitHub
            </GithubLink>
          )
        ) : (
          <>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy || comment.trim() === ""}
              onClick={() => void post(attachesToFile ? "issue" : "inline")}
            >
              <Icon name="Sent" className="size-3.5" />
              {attachesToFile
                ? finding.postAnchor.kind === "file"
                  ? "Comment on the file"
                  : "Comment on the pull request"
                : hasPendingReview
                  ? "Add to my review"
                  : "Post comment"}
            </Button>
            {/* Mirrors GitHub's own split: publish now, or batch into a review.
                With a review already open, GitHub allows only the batched form,
                so the single button above already does that. */}
            {!attachesToFile && !hasPendingReview ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={isBusy || comment.trim() === ""}
                onClick={() => void post("review")}
              >
                Start a review
              </Button>
            ) : null}
            {inlineFailed && !attachesToFile ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={isBusy || comment.trim() === ""}
                onClick={() => void post("issue")}
              >
                Post as a general PR comment
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy}
              onClick={() => setQuestion((open) => (open === null ? "" : null))}
            >
              <Icon name="SideChat" className="size-3.5" />
              Discuss
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground"
              disabled={isBusy}
              onClick={() => {
                rpc
                  .call("setFindingState", {
                    findingId: finding.id,
                    state: finding.state === "dismissed" ? "open" : "dismissed",
                  })
                  .then(() => undefined, reportError);
              }}
            >
              {finding.state === "dismissed" ? "Restore" : "Dismiss"}
            </Button>
          </>
        )}
      </div>

      {question === null ? null : (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
          <Textarea
            autoFocus
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void ask();
              }
            }}
            rows={2}
            className="resize-none text-sm"
            placeholder="What do you want to ask about this issue?"
            aria-label={`Question about ${finding.title}`}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={isAsking || question.trim() === ""}
              onClick={() => void ask()}
            >
              <Icon
                name={isAsking ? "Spinner" : "SideChat"}
                className={cn("size-3.5", isAsking && "animate-spin")}
              />
              Ask the review thread
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground"
              disabled={isAsking}
              onClick={() => setQuestion(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingDetailView({
  rpc,
  repo,
  number,
  findingId,
  onBack,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  findingId: string;
  onBack: () => void;
}) {
  const openSidePane = useOpenSidePane(rpc);
  const [contextStep, setContextStep] = useState(0);
  const context = CONTEXT_STEPS[contextStep] ?? CONTEXT_STEPS[0];

  const pr = useLiveQuery(() => rpc.call("getPullRequest", { repo, number }), [rpc, repo, number]);
  const code = useLiveQuery(
    () => rpc.call("getFindingCode", { findingId, context }),
    [rpc, findingId, context],
  );

  const finding = useMemo(
    () => (pr.data?.findings ?? []).find((entry) => entry.id === findingId) ?? null,
    [pr.data, findingId],
  );

  const ask = useCallback(
    async (target: FindingDto, question: string) => {
      await rpc.call("askAboutFinding", { findingId: target.id, question });
      // The answer arrives in the review's own thread, so bring that pane
      // forward rather than leaving the reviewer to go looking for it.
      openSidePane("discussion");
    },
    [rpc, openSidePane],
  );

  if (pr.isLoading && pr.data === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All issues" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  if (finding === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All issues" />
        <EmptyState
          icon="Bug"
          title="This issue is gone"
          detail="It was probably replaced by a re-run of the review."
        />
      </div>
    );
  }

  const locations: LocationDto[] = code.data?.locations ?? [];
  const primary = locations.find((location) => location.isPrimary);
  const others = locations.filter((location) => !location.isPrimary);
  const nextContext = CONTEXT_STEPS[contextStep + 1];
  const isStale = code.data !== null && !code.data.isReviewedCommit && locations.length > 0;

  const contextButton =
    locations.length === 0 ? null : (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={() => setContextStep((step) => (step + 1) % CONTEXT_STEPS.length)}
      >
        {nextContext === undefined ? "Less context" : `More context (±${nextContext})`}
      </Button>
    );

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="All issues" />

      {/* The decision unit: what is wrong, the code it is about, and the
          comment to post about it — in that order, so the comment is read
          against the code rather than from memory. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-start gap-2">
          <SeverityBadge severity={finding.severity} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug">{finding.title}</h2>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {locationLabel(finding)}
              {finding.category === "" ? "" : ` · ${finding.category}`}
            </p>
          </div>
          {finding.state === "posted" ? (
            <Badge variant="outline" className="shrink-0 gap-1 border-border">
              <Icon name="Check" className="size-3" />
              {finding.postedAs === "pending-review" ? "drafted" : "posted"}
            </Badge>
          ) : null}
        </div>


        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {finding.postAnchor.kind === "line"
                ? "Code the comment attaches to"
                : "Code this issue is about"}
            </p>
            {contextButton}
          </div>
          {isStale ? (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This code is the pull request&apos;s current head, not the commit the review ran
              against — that commit was not recorded. Line numbers may have moved since the issue
              was written.
            </p>
          ) : null}
          {code.error !== null ? (
            <EmptyState icon="AlertTriangle" title="Could not load the code" detail={code.error} />
          ) : code.isLoading && code.data === null ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : primary === undefined ? (
            <EmptyState icon="Code" title="No code to show" detail="This issue cites no file." />
          ) : (
            <LocationCard
              location={primary}
              onShowDiff={() => openSidePane("diff", { file: primary.file, url: primary.diffUrl })}
            />
          )}
        </div>

        <FindingActions
          rpc={rpc}
          finding={finding}
          diffUrl={primary?.diffUrl}
          primaryLocation={primary}
          hasPendingReview={pr.data?.hasPendingReview ?? false}
          onAsk={(question) => ask(finding, question)}
        />
      </div>

      {others.length === 0 ? null : (
        <Section title={`Other code this issue points at (${others.length})`}>
          <div className="flex flex-col gap-3">
            {others.map((location) => (
              <LocationCard
                key={`${location.file}:${location.startLine ?? ""}`}
                location={location}
                onShowDiff={() =>
                  openSidePane("diff", { file: location.file, url: location.diffUrl })
                }
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function BackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 w-fit gap-1 px-1.5 text-xs" onClick={onBack}>
      <Icon name="ChevronLeft" className="size-3.5" />
      {label}
    </Button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function CodeReviewPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);

  const status = useLiveQuery(() => rpc.call("status"), [rpc]);
  const repos = useMemo(() => status.data?.repos ?? [], [status.data]);
  const hasRepos = status.data !== null;

  // Repo and filter live on the server, so re-opening the tab resumes instead
  // of asking again.
  const [repo, setRepo] = useState<string | null>(null);
  const [filter, setFilter] = useState<PrFilter>({ kind: "mine" });
  const [isRestored, setIsRestored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const done = () => {
      if (!cancelled) setIsRestored(true);
    };
    rpc.call("getPanelState").then((state) => {
      if (cancelled) return;
      if (state.repo !== null) setRepo(state.repo);
      if (state.filter !== null) setFilter(state.filter as PrFilter);
      done();
    }, done);
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Fall back to the first known repo only once BOTH the saved repo and the
  // repo list have arrived. `status` runs a gh auth probe, so it lands well
  // after `getPanelState`; acting on an empty list in that gap threw the saved
  // repo away and always landed on the first one.
  const repoKey = repos.join("\n");
  useEffect(() => {
    if (!isRestored || !hasRepos) return;
    setRepo((current) =>
      current !== null && repos.includes(current) ? current : (repos[0] ?? null),
    );
    // `repos` is rebuilt on every status refetch; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestored, hasRepos, repoKey]);

  const persist = useCallback(
    (next: { repo?: string; filter?: PrFilter }) => {
      rpc
        .call("setPanelState", {
          repo: next.repo ?? repo,
          filter: next.filter ?? filter,
        })
        // Losing the saved position is not worth interrupting the user for.
        .catch(() => undefined);
    },
    [rpc, repo, filter],
  );

  const go = useCallback(
    (next: Route) => navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) }),
    [navigate],
  );

  const ghState = status.data?.state ?? "checking";
  const blocked = ghState === "needs_configuration" || ghState === "unavailable";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-4 md:p-5">
        {blocked ? (
          <EmptyState
            icon={ghState === "needs_configuration" ? "Settings" : "AlertTriangle"}
            title={
              ghState === "needs_configuration"
                ? "The GitHub CLI needs setting up"
                : "GitHub is not reachable"
            }
            detail={
              <>
                <p>{status.data?.detail ?? "gh could not be reached."}</p>
                <p className="mt-2">
                  Install the GitHub CLI and run <code className="font-mono">gh auth login</code>,
                  then reload the plugin.
                </p>
              </>
            }
          />
        ) : route.kind === "finding" ? (
          <FindingDetailView
            rpc={rpc}
            repo={route.repo}
            number={route.number}
            findingId={route.findingId}
            onBack={() => go({ kind: "pr", repo: route.repo, number: route.number })}
          />
        ) : route.kind === "pr" ? (
          <PrFindingsView
            rpc={rpc}
            repo={route.repo}
            number={route.number}
            skills={status.data?.skills ?? []}
            onBack={() => go({ kind: "list" })}
            onOpenFinding={(findingId) =>
              go({ kind: "finding", repo: route.repo, number: route.number, findingId })
            }
          />
        ) : (
          <PrListView
            rpc={rpc}
            repo={repo}
            repos={repos}
            filter={filter}
            onRepoChange={(next) => {
              setRepo(next);
              persist({ repo: next });
            }}
            onFilterChange={(next) => {
              setFilter(next);
              persist({ filter: next });
            }}
            myTeams={status.data?.myTeams ?? []}
            onOpenPr={(nextRepo, number) => go({ kind: "pr", repo: nextRepo, number })}
          />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Code Review",
    // Only a fallback: the manifest icon asset wins on compact surfaces.
    icon: "Search",
    path: PANEL_PATH,
    component: CodeReviewPanel,
    fixedTabs: [
      {
        ...reviewTabRef,
        title: "Code review",
        icon: "Github",
        layout: "flush",
        component: ReviewSideTab,
      },
    ],
  });
});
