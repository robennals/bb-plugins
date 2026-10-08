// bb-plugin-run-commands — frontend.
//
// One button in the thread header. Its dropdown lists the preset commands;
// picking one runs it in this thread's workspace and brings up the thread's
// "Command output" tab, where every run gets a box with its output. The same
// dropdown opens the editor for the list, which also sits on the plugin's page
// in Settings.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { PRESETS_CHANGED } from "./channels";
import { messageOf } from "./errors";
import { OutputPanel } from "./output-panel";
import { PresetEditor, ProjectPresetEditor } from "./preset-editor";
import type { Preset } from "./presets";
import type { rpcContract } from "./server";

const HEADER_LABEL = "Run a command";
const OUTPUT_ACTION_ID = "output";
const OUTPUT_TITLE = "Command output";

// Realtime payloads arrive as untyped JSON; this is the field we filter on.
const presetsChangedSchema = z.object({ projectId: z.string() });

function usePresets(projectId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const refresh = useCallback(() => {
    rpc.call("presets_get", { projectId }).then(
      (result) => setPresets(result.presets),
      (cause) => toast.error(messageOf(cause)),
    );
  }, [rpc, projectId]);
  useEffect(refresh, [refresh]);
  useRealtime(PRESETS_CHANGED, (payload) => {
    if (presetsChangedSchema.safeParse(payload).data?.projectId === projectId) refresh();
  });
  return { rpc, presets };
}

function HeaderMenu({ threadId, projectId }: { threadId: string; projectId: string }) {
  const { rpc, presets } = usePresets(projectId);
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState(false);

  const showOutput = () => {
    navigate.openThreadPanel({ actionId: OUTPUT_ACTION_ID, title: OUTPUT_TITLE });
  };
  // The tab opens straight away and fills in when the run is recorded, so the
  // click feels immediate even when starting the terminal takes a moment.
  const run = (presetId: string) => {
    showOutput();
    rpc.call("run", { threadId, presetId }).catch((cause) => toast.error(messageOf(cause)));
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={HEADER_LABEL}
          >
            <Icon name="Play" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {presets === null || presets.length === 0 ? (
            <DropdownMenuItem disabled>
              {presets === null ? "Loading commands…" : "No commands yet"}
            </DropdownMenuItem>
          ) : (
            presets.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => run(preset.id)}>
                {preset.name}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={showOutput}>Show output</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditing(true)}>Edit commands…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commands</DialogTitle>
            <DialogDescription>
              These are this project's commands. Each one runs in the thread's workspace. Its output appears in the thread's{" "}
              {OUTPUT_TITLE} tab.
            </DialogDescription>
          </DialogHeader>
          <PresetEditor projectId={projectId} onSaved={() => setEditing(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "run-commands",
    title: HEADER_LABEL,
    component: ({ threadId, projectId }) => <HeaderMenu threadId={threadId} projectId={projectId} />,
  });

  app.slots.threadPanelAction({
    id: OUTPUT_ACTION_ID,
    title: OUTPUT_TITLE,
    component: ({ threadId }) => <OutputPanel threadId={threadId} />,
  });

  app.slots.settingsSection({
    id: "commands",
    title: "Commands",
    description: "The commands the Run button offers at the top of each of a project's threads.",
    component: () => <ProjectPresetEditor />,
  });
});
