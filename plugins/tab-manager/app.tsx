import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, TabMutationResult } from "./server";
import { messageOf } from "./errors";
import { describeTab, type PanelTab } from "./tabs";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface TabsState {
  revision: number;
  tabs: PanelTab[];
}

/** A small control that sits in a row of icon buttons inside the popover. */
function RowButton({
  label,
  icon,
  onClick,
  disabled,
  destructive,
}: {
  label: string;
  icon: "ArrowUp" | "ArrowDown" | "ChevronsDown" | "X";
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground",
        "hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-30",
        destructive === true && "hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

function TabRow({
  tab,
  index,
  total,
  busy,
  onClose,
  onCloseBelow,
  onMove,
}: {
  tab: PanelTab;
  index: number;
  total: number;
  busy: boolean;
  onClose: () => void;
  onCloseBelow: () => void;
  onMove: (toIndex: number) => void;
}) {
  const { label, detail } = describeTab(tab);
  return (
    <li className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-state-hover">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{label}</div>
        {detail === null ? null : (
          <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
        )}
      </div>
      <RowButton
        label={`Move ${label} up`}
        icon="ArrowUp"
        disabled={busy || index === 0}
        onClick={() => onMove(index - 1)}
      />
      <RowButton
        label={`Move ${label} down`}
        icon="ArrowDown"
        disabled={busy || index === total - 1}
        onClick={() => onMove(index + 1)}
      />
      <RowButton
        label={`Close tabs below ${label}`}
        icon="ChevronsDown"
        disabled={busy || index === total - 1}
        onClick={onCloseBelow}
      />
      <RowButton
        label={`Close ${label}`}
        icon="X"
        disabled={busy}
        destructive
        onClick={onClose}
      />
    </li>
  );
}

/**
 * A mutation either lands or comes back as a conflict carrying BB's current
 * tabs — either way the answer is the list to draw next, so both paths just
 * adopt it. Conflicts are surfaced because the user's click did not happen.
 */
function useTabMutation(setState: (next: TabsState) => void, setBusy: (busy: boolean) => void) {
  return useCallback(
    async (run: () => Promise<TabMutationResult>) => {
      setBusy(true);
      try {
        const result = await run();
        setState({ revision: result.revision, tabs: result.tabs });
        if (result.outcome === "conflict") {
          toast.info("Tabs changed elsewhere — refreshed. Try again.");
        }
        for (const warning of result.terminalWarnings) toast.warning(warning);
      } catch (cause) {
        toast.error(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [setState, setBusy],
  );
}

function TabList({ threadId, rpc }: { threadId: string; rpc: Rpc }) {
  const [state, setState] = useState<TabsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutate = useTabMutation(setState, setBusy);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpc.call("tabs_list", { threadId });
        if (!cancelled) setState({ revision: result.revision, tabs: result.tabs });
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (error !== null) return <p className="p-3 text-sm text-destructive">{error}</p>;
  if (state === null) return <p className="p-3 text-sm text-muted-foreground">Loading tabs…</p>;
  if (state.tabs.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">This thread has no panel tabs.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
        {state.tabs.map((tab, index) => (
          <TabRow
            key={tab.id}
            tab={tab}
            index={index}
            total={state.tabs.length}
            busy={busy}
            onClose={() =>
              void mutate(() =>
                rpc.call("tabs_close", {
                  threadId,
                  expectedRevision: state.revision,
                  tabIds: [tab.id],
                }),
              )
            }
            onCloseBelow={() =>
              void mutate(() =>
                rpc.call("tabs_close_mode", { threadId, mode: "right", anchorId: tab.id }),
              )
            }
            onMove={(toIndex) =>
              void mutate(() =>
                rpc.call("tabs_reorder", {
                  threadId,
                  expectedRevision: state.revision,
                  tabId: tab.id,
                  toIndex,
                }),
              )
            }
          />
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-border pt-2">
        <span className="text-[11px] text-muted-foreground">
          {state.tabs.length} tab{state.tabs.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() =>
            void mutate(() =>
              rpc.call("tabs_close_mode", { threadId, mode: "all", anchorId: null }),
            )
          }
        >
          Close all
        </Button>
      </div>
    </div>
  );
}

function TabManagerAction({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Manage panel tabs">
          <Icon name="Layers" className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        {/* Remount on each open so the list is never stale from a previous visit. */}
        {open ? <TabList threadId={threadId} rpc={rpc} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The same list, given the roomier side panel instead of a popover. */
function TabManagerPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Reorder tabs, or close them individually or in bulk.
      </p>
      <TabList threadId={threadId} rpc={rpc} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "tab-manager",
    title: "Manage panel tabs",
    component: ({ threadId }) => <TabManagerAction threadId={threadId} />,
  });

  app.slots.threadPanelAction({
    id: "manage-tabs",
    title: "Manage panel tabs",
    icon: "Layers",
    component: ({ threadId }) => <TabManagerPanel threadId={threadId} />,
  });

  // A palette `run` is a plain callback, so it cannot use the `useRpc` hook and
  // has no other way to reach this plugin's RPC. It therefore opens the manager
  // rather than closing tabs blind — which is also the safer palette command.
  app.slots.commandPaletteAction({
    id: "manage-tabs",
    title: "Tabs: manage panel tabs in this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      if (!openPanel({ actionId: "manage-tabs", title: "Panel tabs" })) {
        toast.error("Open a thread to manage its panel tabs.");
      }
    },
  });
});
