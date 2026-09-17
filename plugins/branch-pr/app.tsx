// bb-plugin-branch-pr — frontend.
//
// Three ways to ask the same question ("what is my branch's pull request?"),
// one RPC behind all of them. The header button answers it in place; the
// palette and the panel's Actions list answer it inside a panel tab, because a
// palette `run` is a plain callback with no way to reach this plugin's RPC —
// its only power is to open one of our panel tabs.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { messageOf } from "./errors";
import { describeResult, type ResultMessage } from "./messages";
import { LAUNCHER_ACTION_ID, type rpcContract } from "./server";

const ICON = "GitPullRequest";
const HEADER_LABEL = "Open this branch's pull request";

function useOpenPullRequest(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const open = useCallback(
    async (fromLauncher: boolean): Promise<ResultMessage> => {
      setPending(true);
      try {
        return describeResult(await rpc.call("open", { threadId, fromLauncher }));
      } catch (cause) {
        return { tone: "error", text: messageOf(cause) };
      } finally {
        setPending(false);
      }
    },
    [rpc, threadId],
  );
  return { open, pending };
}

function announce(message: ResultMessage): void {
  if (message.tone === "success") toast.success(message.text);
  else if (message.tone === "error") toast.error(message.text);
  else toast(message.text);
}

/** The thread header's one-click button. */
function HeaderButton({ threadId }: { threadId: string }) {
  const { open, pending } = useOpenPullRequest(threadId);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={HEADER_LABEL}
      disabled={pending}
      onClick={() => {
        open(false).then(announce);
      }}
    >
      <Icon name={ICON} className="size-4" />
    </Button>
  );
}

/**
 * The panel tab the palette and the Actions list open. On success the server
 * swaps this tab for the browser tab in a single write, so this component
 * usually unmounts moments after it mounts; what it renders is the answer for
 * the times it does not — no pull request, or a lookup that failed.
 */
function LauncherPanel({ threadId }: { threadId: string }) {
  const { open, pending } = useOpenPullRequest(threadId);
  const [message, setMessage] = useState<ResultMessage | null>(null);
  // React mounts effects twice in development. `open` is idempotent, but a
  // second call would report "already open" over the real answer, so it runs
  // once per mount and only the Retry button asks again.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open(true).then(setMessage);
  }, [open]);
  return (
    <div className="flex flex-col items-start gap-3">
      <p
        role="status"
        className={message?.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {message?.text ?? "Looking for this branch's pull request…"}
      </p>
      {message === null ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            open(true).then(setMessage);
          }}
        >
          <Icon name="RotateCcw" className="size-4" />
          Try again
        </Button>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "branch-pr",
    title: HEADER_LABEL,
    component: ({ threadId }) => <HeaderButton threadId={threadId} />,
  });

  app.slots.threadPanelAction({
    id: LAUNCHER_ACTION_ID,
    title: HEADER_LABEL,
    icon: ICON,
    component: ({ threadId }) => <LauncherPanel threadId={threadId} />,
  });

  app.slots.commandPaletteAction({
    id: "open-branch-pr",
    title: "PR: open this branch's pull request",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      if (!openPanel({ actionId: LAUNCHER_ACTION_ID, title: "Pull request" })) {
        toast.error("Open a thread to find its pull request.");
      }
    },
  });
});
