import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
// Statically imported so the explorer's folder/file glyphs paint on the first
// frame instead of flashing empty while the extended registry loads.
import "@/components/ui/icon-extended";
import { formatRoute, parseRoute, sameScope, type ScopeRef } from "@/lib/route";
import { readLastScope, readSession } from "@/lib/session";
import type { rpcContract } from "./server.js";
import { Browser } from "./components/Browser";

const PANEL_PATH = "files";

/**
 * The full-page browser. The route carries both the workspace and the open
 * file, so back/forward walk the files you opened and a link survives a reload.
 */
function FilesPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const route = useMemo(() => parseRoute(subPath), [subPath]);

  // With no workspace in the route, fall back to the thread in view, then to
  // whatever was open last, then to the server's first workspace — a visit
  // straight from the sidebar should land on files, not on an empty pane.
  const [fallback, setFallback] = useState<ScopeRef | null>(null);
  useEffect(() => {
    if (route.scope !== null) return;
    let cancelled = false;

    const guess = async (): Promise<ScopeRef | null> => {
      if (context.threadId !== null) return { kind: "thread", id: context.threadId };
      if (context.projectId !== null) return { kind: "project", id: context.projectId };
      const remembered = readLastScope();
      if (remembered !== null) return remembered;
      return (await rpc.call("workspaces")).defaultRef;
    };

    void guess()
      .then((next) => {
        if (cancelled || next === null) return;
        navigate.toPluginPanel(PANEL_PATH, {
          // With the file you last had open in this workspace, so arriving from
          // the sidebar resumes rather than restarts. Replaced, not pushed:
          // the empty route is not somewhere Back should return you to.
          subPath: formatRoute(next, readSession(next)?.filePath ?? null),
          replace: true,
        });
        setFallback(next);
      })
      .catch(() => {
        if (!cancelled) setFallback(null);
      });

    return () => {
      cancelled = true;
    };
  }, [context.projectId, context.threadId, navigate, route.scope, rpc]);

  const scope = route.scope ?? fallback;

  const onOpenPath = useCallback(
    (path: string | null) => {
      if (scope === null) return;
      // Compare structurally, not against `subPath`: BB hands the subPath back
      // percent-encoded while formatRoute writes raw segments, so a string
      // compare misses for any path with a space, bracket or non-ASCII name and
      // pushes a duplicate history entry every time that file is clicked.
      if (sameScope(route.scope, scope) && route.filePath === path) return;
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: formatRoute(scope, path),
        // Opening a file is navigation worth being able to undo, so it pushes.
        // Clearing back to the workspace root would leave a dead entry.
        ...(path === null ? { replace: true } : {}),
      });
    },
    [navigate, route.filePath, route.scope, scope],
  );

  const onChangeScope = useCallback(
    (next: ScopeRef) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: formatRoute(next, readSession(next)?.filePath ?? null),
      });
    },
    [navigate],
  );

  return (
    <Browser
      // Keyed on the workspace, so switching one re-seeds the browser from that
      // workspace's remembered session instead of carrying the previous one's
      // unfolded folders across.
      key={scope === null ? "none" : `${scope.kind}:${scope.id}`}
      scope={scope}
      filePath={route.filePath}
      onOpenPath={onOpenPath}
      onChangeScope={onChangeScope}
    />
  );
}

/**
 * The same browser beside a thread, pinned to that thread's workspace — the
 * files the agent in this conversation is actually editing.
 */
function ThreadFilesPanel({ threadId }: PluginThreadPanelProps) {
  const scope = useMemo<ScopeRef>(() => ({ kind: "thread", id: threadId }), [threadId]);
  // A side panel has no route to carry the open file, so it comes back from the
  // remembered session — the same record the Files page reads.
  const [filePath, setFilePath] = useState<string | null>(
    () => readSession(scope)?.filePath ?? null,
  );

  return (
    <Browser
      scope={scope}
      filePath={filePath}
      onOpenPath={setFilePath}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "files",
    title: "Files",
    icon: "Code",
    path: PANEL_PATH,
    component: FilesPage,
  });

  app.slots.threadPanelAction({
    id: "files",
    title: "Project files",
    icon: "Code",
    // "flush" gives the component the full tab area with a definite height and
    // no host scrolling — which is what lets the tree and the file each own a
    // scroll region that ends at the bottom of the panel.
    layout: "flush",
    component: ThreadFilesPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Files" });
    },
  });

  app.slots.commandPaletteAction({
    id: "open-files",
    title: "Files: browse this thread's project",
    // The palette opens anywhere, but this action needs a thread side panel.
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      if (!openPanel({ actionId: "files", title: "Files" })) {
        toast.error("Open a thread to browse its project files.");
      }
    },
  });
});
