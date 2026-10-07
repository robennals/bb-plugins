// The form for one project's list of preset commands. Shown in two places —
// the dialog the header dropdown opens, and the plugin's page in Settings — so
// it owns its own loading and saving rather than being handed a list.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { messageOf } from "./errors";
import { presetsSchema, type Preset } from "./presets";
import type { rpcContract } from "./server";

function blankPreset(): Preset {
  return { id: crypto.randomUUID(), name: "", command: "", url: "" };
}

function PresetFields({
  preset,
  onChange,
  onRemove,
}: {
  preset: Preset;
  onChange: (next: Preset) => void;
  onRemove: () => void;
}) {
  const label = preset.name.trim() === "" ? "new command" : `"${preset.name}"`;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Input
          value={preset.name}
          onChange={(event) => onChange({ ...preset, name: event.target.value })}
          placeholder="Name, e.g. Dev server"
          aria-label={`Name of ${label}`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </div>
      <Input
        value={preset.command}
        onChange={(event) => onChange({ ...preset, command: event.target.value })}
        placeholder="Command, e.g. npm run dev"
        aria-label={`Command for ${label}`}
        className="font-mono"
      />
      <Input
        value={preset.url}
        onChange={(event) => onChange({ ...preset, url: event.target.value })}
        placeholder="Address to open once it is up, e.g. http://localhost:3000 (optional)"
        aria-label={`Address to open for ${label}`}
      />
    </li>
  );
}

/**
 * Edits one project's commands. `onSaved` lets the dialog close itself; the
 * Settings page leaves it out.
 */
export function PresetEditor({ projectId, onSaved }: { projectId: string; onSaved?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<Preset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    rpc.call("presets_get", { projectId }).then(
      (result) => setDraft(result.presets),
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc, projectId]);
  useEffect(load, [load]);

  const save = async () => {
    const parsed = presetsSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "These commands are not valid.");
      return;
    }
    setSaving(true);
    try {
      const saved = await rpc.call("presets_save", { projectId, presets: parsed.data });
      setDraft(saved.presets);
      setError(null);
      onSaved?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  if (draft === null) {
    return (
      <p role={error === null ? "status" : "alert"} className="text-sm text-muted-foreground">
        {error ?? "Loading commands…"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No commands yet. Add one, such as the command that starts your dev server.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {draft.map((preset) => (
            <PresetFields
              key={preset.id}
              preset={preset}
              onChange={(next) =>
                setDraft(draft.map((entry) => (entry.id === preset.id ? next : entry)))
              }
              onRemove={() => setDraft(draft.filter((entry) => entry.id !== preset.id))}
            />
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => setDraft([...draft, blankPreset()])}>
          <Icon name="Plus" className="size-4" />
          Add command
        </Button>
        <Button size="sm" disabled={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * The Settings page's editor. BB does not tell a settings section which
 * project is in view, so this one asks: pick a project, then edit its list.
 */
export function ProjectPresetEditor() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("projects", null).then(
      (result) => {
        setProjects(result.projects);
        setProjectId((chosen) => chosen ?? result.projects[0]?.id ?? null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc]);

  if (projects === null) {
    return (
      <p role={error === null ? "status" : "alert"} className="text-sm text-muted-foreground">
        {error ?? "Loading projects…"}
      </p>
    );
  }
  if (projectId === null) {
    return <p className="text-sm text-muted-foreground">Add a project to give it commands.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        Project
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {/* Keyed so switching project discards the other project's unsaved draft. */}
      <PresetEditor key={projectId} projectId={projectId} />
    </div>
  );
}
