import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PullRequest, rpcContract } from "./server";
import { PULL_REQUEST_STATUSES } from "./pr-status";
import { SORT_ORDERS, SORT_ORDER_LABELS, searchPullRequests, sortPullRequests, type SortOrder } from "./pr-list";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const statusStyle: Record<PullRequest["status"], string> = {
  OPEN: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  DRAFT: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  WAITING: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  FAILING: "border-destructive/30 bg-destructive/10 text-destructive",
  FEEDBACK: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  APPROVED: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  // Outlined rather than filled, so a partly approved PR reads as a lighter APPROVED
  // instead of a status of its own.
  PART_APPROVED: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  MERGED: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};
function StatusBadge({ status, count }: { status: PullRequest["status"]; count?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide", statusStyle[status])}>
      {status === "APPROVED" ? <Icon name="CircleCheck" className="size-3.5" /> : null}
      <span>{status}</span>
      {count === undefined ? null : <span className="tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
function PullRequestRow({ pr, onChanged }: { pr: PullRequest; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askingInstructions, setAskingInstructions] = useState(false);
  const [instructions, setInstructions] = useState("");
  const instructionsId = useId();
  const createThread = async () => {
    if (pr.projectId === null || creating || instructions.trim() === "") return;
    setCreating(true); setError(null);
    try {
      const result = await rpc.call("prs_create_thread", {
        repository: pr.repository, number: pr.number, title: pr.title, url: pr.url,
        headRefName: pr.headRefName, baseRefName: pr.baseRefName, projectId: pr.projectId,
        instructions,
      });
      setAskingInstructions(false);
      onChanged();
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setCreating(false); }
  };
  // The linked thread may have been deleted since the list was cached. Ask the
  // server before navigating, and fall back to creating a replacement.
  const openThread = async () => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const { threadId } = await rpc.call("prs_resolve_thread", { repository: pr.repository, number: pr.number });
      if (threadId !== null) navigate.toThread(threadId);
      else setAskingInstructions(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setCreating(false); }
  };
  return (
    <article className={cn("rounded-lg border border-border bg-card px-4 py-3 shadow-sm",
      pr.status === "APPROVED" && "border-emerald-500/40 bg-emerald-500/5 ring-1 ring-emerald-500/20")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge status={pr.status} />
          <span className="text-xs text-muted-foreground">{pr.repository} #{pr.number}</span>
          {pr.isDraft ? <span className="text-xs text-muted-foreground">Draft</span> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {pr.threadId !== null && pr.projectId !== null ? (
            <Button size="sm" onClick={() => void openThread()} disabled={creating}>
              <Icon name={creating ? "Loading" : "MessageSquare"} className={cn("size-4", creating && "animate-spin")} />
              {creating ? "Opening…" : "Open thread"}
            </Button>
          ) : pr.threadId !== null ? (
            <Button size="sm" onClick={() => navigate.toThread(pr.threadId!)}><Icon name="MessageSquare" className="size-4" />Open thread</Button>
          ) : pr.projectId !== null && pr.status !== "MERGED" && !askingInstructions ? (
            <Button size="sm" onClick={() => setAskingInstructions(true)}>
              <Icon name="GitBranch" className="size-4" />Create thread
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => navigate.openUrl(pr.url)} aria-label={`Open ${pr.repository} pull request ${pr.number} on GitHub`}>
            <Icon name="ExternalLink" className="size-4" />GitHub
          </Button>
        </div>
      </div>
      <h2 className="mt-1.5 text-sm font-medium leading-5 text-foreground">{pr.title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{pr.summary}</p>
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{pr.headRefName} → {pr.baseRefName}</p>
      {pr.threadId === null && pr.projectId === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Add this repository as a BB project to create a worktree and thread.</p>
      ) : pr.threadId !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">Thread: {pr.threadTitle ?? pr.threadId}</p>
      ) : null}
      {error === null ? null : <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {askingInstructions ? (
        <div className="mt-3 border-t border-border pt-3">
          <label htmlFor={instructionsId} className="text-xs font-medium text-foreground">
            What should the agent do with #{pr.number}?
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            It starts in a worktree checked out from {pr.headRefName}. This is the first message it receives.
          </p>
          <textarea
            id={instructionsId}
            autoFocus
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !creating) setAskingInstructions(false);
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void createThread(); }
            }}
            placeholder="e.g. Fix the failing type check, then push."
            className="mt-1.5 block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setAskingInstructions(false)} disabled={creating}>Cancel</Button>
            <Button size="sm" onClick={() => void createThread()} disabled={creating || instructions.trim() === ""}>
              <Icon name={creating ? "Loading" : "GitBranch"} className={cn("size-4", creating && "animate-spin")} />
              {creating ? "Creating…" : "Create thread"}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
function PrManagerPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PullRequest["status"] | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>("STATUS");
  const [query, setQuery] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const applyResult = useCallback((result: { prs: PullRequest[]; refreshedAt: string | null; repositoryFilter: string | null; sortOrder: SortOrder }) => {
    setPrs(result.prs); setRefreshedAt(result.refreshedAt); setRepositoryFilter(result.repositoryFilter);
    setSortOrder(result.sortOrder); setError(null);
  }, []);
  const loadCached = useCallback(async () => {
    try {
      const result = await rpc.call("prs_list");
      applyResult(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [applyResult, rpc]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await rpc.call("prs_refresh");
      applyResult(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRefreshing(false); }
  }, [applyResult, rpc]);
  const changeView = useCallback(async (repository: string | null, order: SortOrder) => {
    setRepositoryFilter(repository); setSortOrder(order);
    try {
      await rpc.call("prs_set_view", { repository, sortOrder: order });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void loadCached();
    }
  }, [loadCached, rpc]);
  useEffect(() => {
    void loadCached();
  }, [loadCached]);
  useRealtime("prs-changed", loadCached);
  const repositories = useMemo(() => {
    const latestPrByRepository = new Map<string, number>();
    for (const pr of prs ?? []) {
      const createdAt = Date.parse(pr.createdAt);
      latestPrByRepository.set(pr.repository, Math.max(latestPrByRepository.get(pr.repository) ?? 0, Number.isNaN(createdAt) ? 0 : createdAt));
    }
    return [...latestPrByRepository.keys()].sort((a, b) =>
      (latestPrByRepository.get(b) ?? 0) - (latestPrByRepository.get(a) ?? 0) || a.localeCompare(b));
  }, [prs]);
  useEffect(() => {
    if (repositoryFilter !== null && !repositories.includes(repositoryFilter)) {
      void changeView(null, sortOrder);
    }
  }, [changeView, repositories, repositoryFilter, sortOrder]);
  const repositoryPrs = useMemo(
    () => repositoryFilter === null ? (prs ?? []) : (prs ?? []).filter((pr) => pr.repository === repositoryFilter),
    [prs, repositoryFilter],
  );
  const searchedPrs = useMemo(() => searchPullRequests(repositoryPrs, query), [query, repositoryPrs]);
  // Counts follow the search so the chips describe the list you are actually looking at.
  const counts = useMemo(() => {
    const result = new Map<PullRequest["status"], number>();
    for (const pr of searchedPrs) result.set(pr.status, (result.get(pr.status) ?? 0) + 1);
    return result;
  }, [searchedPrs]);
  useEffect(() => {
    if (statusFilter !== null && !counts.has(statusFilter)) setStatusFilter(null);
  }, [counts, statusFilter]);
  const filteredPrs = useMemo(
    () => sortPullRequests(statusFilter === null ? searchedPrs : searchedPrs.filter((pr) => pr.status === statusFilter), sortOrder),
    [searchedPrs, sortOrder, statusFilter],
  );
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">Your pull requests</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {prs === null
                ? "Loading saved status…"
                : filteredPrs.length === prs.length
                  ? `${prs.length} current and recently merged`
                  : `${filteredPrs.length} of ${prs.length} shown`}
              {refreshedAt === null ? "" : ` · refreshed ${new Date(refreshedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {repositories.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Repository</span>
                <select
                  value={repositoryFilter ?? ""}
                  onChange={(event) => void changeView(event.target.value === "" ? null : event.target.value, sortOrder)}
                  className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">All repositories</option>
                  {repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}
                </select>
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Sort</span>
              <select
                value={sortOrder}
                onChange={(event) => void changeView(repositoryFilter, SORT_ORDERS.find((order) => order === event.target.value) ?? sortOrder)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SORT_ORDERS.map((order) => <option key={order} value={order}>{SORT_ORDER_LABELS[order]}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
              <Icon name="RotateCcw" className={cn("size-4", refreshing && "animate-spin")} />Refresh
            </Button>
          </div>
        </div>
        <div className="relative mt-3">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title, repository, number, branch or status"
            aria-label="Search pull requests"
            className="h-9 pl-8"
          />
        </div>
        {prs !== null && prs.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">{PULL_REQUEST_STATUSES.filter((status) => counts.has(status)).map((status) =>
            <button
              key={status}
              type="button"
              aria-pressed={statusFilter === status}
              aria-label={`${statusFilter === status ? "Clear" : "Filter by"} ${status.toLowerCase()} status, ${counts.get(status) ?? 0} pull requests`}
              onClick={() => setStatusFilter((current) => current === status ? null : status)}
              className={cn(
                "inline-flex items-center rounded-full text-xs text-muted-foreground outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                statusFilter !== null && statusFilter !== status && "opacity-50",
                statusFilter === status && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
            >
              <StatusBadge status={status} count={counts.get(status)} />
            </button>)}</div>
        ) : null}
        {error === null ? null : <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
        <div className="mt-4 space-y-2.5">
          {prs === null ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Loading your saved pull request list…</div>
          : refreshedAt === null ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No saved pull request list yet. Click Refresh to load it.</div>
          : prs.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No open or recently merged pull requests.</div>
          : filteredPrs.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No pull requests match these filters.</div>
          : filteredPrs.map((pr) => <PullRequestRow key={pr.key} pr={pr} onChanged={() => void loadCached()} />)}
        </div>
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "pull-requests", title: "Pull requests", icon: "GitPullRequest", path: "pull-requests", component: PrManagerPage });
});
