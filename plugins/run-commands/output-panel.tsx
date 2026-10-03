// The thread's "Command output" tab: one collapsible box per run, newest
// first, each showing what the command printed — live while it runs.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { messageOf } from "./errors";
import type { RunSummary } from "./runs";
import { OUTPUT_ADDED, RUNS_CHANGED, type rpcContract } from "./server";
import { displayText } from "./terminal-text";

// Realtime payloads arrive as untyped JSON; these are the fields we filter on.
const runsChangedSchema = z.object({ threadId: z.string() });
const outputAddedSchema = z.object({ runId: z.string() });

export function describeStatus(run: RunSummary): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "exited":
      return run.exitCode === 0 ? "Finished" : `Failed (exit code ${run.exitCode ?? "unknown"})`;
    case "stopped":
      return "Stopped";
    case "lost":
      return "Ended — its terminal was closed";
  }
}

/** Within this many pixels of the bottom counts as "following" the output. */
const FOLLOW_SLACK_PX = 24;

/** What one run printed, fetched a piece at a time as the server reports more. */
function RunOutput({ threadId, runId }: { threadId: string; runId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [output, setOutput] = useState({ text: "", end: 0, trimmed: false });
  const [error, setError] = useState<string | null>(null);
  // A signal can arrive while a fetch is in flight; rather than fetching twice
  // at once, note it and fetch again when the first one lands.
  const fetching = useRef(false);
  const again = useRef(false);
  const end = useRef(0);

  const fetchMore = useCallback(() => {
    if (fetching.current) {
      again.current = true;
      return;
    }
    fetching.current = true;
    const from = end.current;
    rpc.call("output", { threadId, runId, from }).then(
      (piece) => {
        end.current = piece.end;
        setOutput((previous) =>
          piece.start > from
            ? // The part we were missing has been trimmed away: start over
              // from what is left rather than leave a gap in the middle.
              { text: piece.text, end: piece.end, trimmed: true }
            : { text: previous.text + piece.text, end: piece.end, trimmed: previous.trimmed },
        );
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    ).finally(() => {
      fetching.current = false;
      if (again.current) {
        again.current = false;
        fetchMore();
      }
    });
  }, [rpc, threadId, runId]);

  useEffect(fetchMore, [fetchMore]);
  useRealtime(OUTPUT_ADDED, (payload) => {
    if (outputAddedSchema.safeParse(payload).data?.runId === runId) fetchMore();
  });

  // Keep the newest output in view, unless the reader has scrolled up.
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && box.current !== null) {
      box.current.scrollTop = box.current.scrollHeight;
    }
  }, [output.text]);

  const shown = displayText(output.text);
  return (
    <pre
      ref={box}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        following.current = scrollHeight - scrollTop - clientHeight < FOLLOW_SLACK_PX;
      }}
      className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground"
    >
      {output.trimmed ? (
        <span className="text-muted-foreground">{"(earlier output was dropped to save space)\n"}</span>
      ) : null}
      {shown === "" ? <span className="text-muted-foreground">No output yet.</span> : shown}
      {error === null ? null : <span className="text-destructive">{`\n${error}`}</span>}
    </pre>
  );
}

function RunBox({
  threadId,
  run,
  expanded,
  onToggle,
  onStop,
}: {
  threadId: string;
  run: RunSummary;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
}) {
  const failed = run.status === "exited" && run.exitCode !== 0;
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span
            aria-hidden
            className={cn(
              "w-3 shrink-0 text-[10px] text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          >
            ▶
          </span>
          <span className="truncate font-medium">{run.name}</span>
          <span
            className={cn(
              "shrink-0 text-xs",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {describeStatus(run)}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {new Date(run.startedAt).toLocaleTimeString()}
          </span>
        </button>
        {run.status === "running" ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0"
            aria-label={`Stop "${run.name}"`}
            onClick={onStop}
          >
            <Icon name="Square" className="size-3.5" />
            Stop
          </Button>
        ) : null}
      </div>
      {expanded ? <RunOutput threadId={threadId} runId={run.id} /> : null}
    </li>
  );
}

export function OutputPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  // Only the reader's own choices are stored; a run they have not touched is
  // open when it is the newest one, so each new run opens and the last closes.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    rpc.call("runs", { threadId }).then(
      (result) => setRuns(result.runs),
      (cause) => toast.error(messageOf(cause)),
    );
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime(RUNS_CHANGED, (payload) => {
    if (runsChangedSchema.safeParse(payload).data?.threadId === threadId) refresh();
  });

  if (runs === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has run in this thread yet. Pick a command from the Run button at the top of the
        thread.
      </p>
    );
  }
  const newestId = runs[0]?.id;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={runs.every((run) => run.status === "running")}
          onClick={() => {
            rpc.call("clear", { threadId }).then((result) => setRuns(result.runs), (cause) =>
              toast.error(messageOf(cause)),
            );
          }}
        >
          Clear finished
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {runs.map((run) => (
          <RunBox
            key={run.id}
            threadId={threadId}
            run={run}
            expanded={toggled[run.id] ?? run.id === newestId}
            onToggle={() =>
              setToggled((previous) => ({
                ...previous,
                [run.id]: !(previous[run.id] ?? run.id === newestId),
              }))
            }
            onStop={() => {
              rpc.call("stop", { threadId, runId: run.id }).catch((cause) => toast.error(messageOf(cause)));
            }}
          />
        ))}
      </ul>
    </div>
  );
}
