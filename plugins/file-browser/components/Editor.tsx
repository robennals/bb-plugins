import { useEffect, useRef, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme, useRpc } from "@get-bb/plugin-sdk/app";
import type { editor } from "monaco-editor";
import { loadMonaco, type MonacoApi } from "@/lib/monaco";
import { monacoThemeFrom, monacoThemeName } from "@/lib/monaco-theme";
import type { rpcContract } from "../server.js";

export interface EditorProps {
  /** Workspace-relative; picks the language and labels the editor. */
  path: string;
  /** The text being edited, with every line break a `\n`. */
  value: string;
  wrapLines: boolean;
  onChange: (value: string) => void;
  /** ⌘S / Ctrl+S. */
  onSave: () => void;
}

/**
 * The edit view's editor: Monaco, the editor inside VS Code, painted with BB's
 * code theme. Monaco is loaded on demand from the server; when that fails —
 * the bundle could not be built, or the page cannot reach it — a plain text
 * box takes its place, so a file can still be edited and saved.
 */
export function Editor(props: EditorProps) {
  const rpc = useRpc<typeof rpcContract>();
  const codeTheme = useCodeTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  const [hasFailed, setHasFailed] = useState(false);

  // The editor is created once and outlives many renders, so its listeners
  // reach the latest props through this rather than the ones it was made with.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let isCancelled = false;
    void rpc
      .call("monacoAssets")
      .then(({ baseUrl }) => loadMonaco(baseUrl))
      .then((loaded) => {
        if (!isCancelled) setMonaco(loaded);
      })
      .catch(() => {
        if (!isCancelled) setHasFailed(true);
      });
    return () => {
      isCancelled = true;
    };
  }, [rpc]);

  const { path } = props;
  useEffect(() => {
    const container = containerRef.current;
    if (monaco === null || container === null) return;

    // The file's name is what Monaco picks the language from.
    const model = monaco.editor.createModel(
      latest.current.value,
      undefined,
      monaco.Uri.file(path),
    );
    const created = monaco.editor.create(container, {
      model,
      ariaLabel: `Edit ${path}`,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: latest.current.wrapLines ? "on" : "off",
      fontSize: 13,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono") ||
        undefined,
      // Hovers and the find box are otherwise clipped by the pane's edges.
      fixedOverflowWidgets: true,
    });
    created.onDidChangeModelContent(() => latest.current.onChange(created.getValue()));
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      latest.current.onSave(),
    );
    created.focus();
    setInstance(created);

    return () => {
      setInstance(null);
      created.dispose();
      model.dispose();
    };
  }, [monaco, path]);

  // Discarding an edit, or the file being re-read, changes the text from
  // outside. Typing arrives here too, but by then the editor already agrees.
  const { value } = props;
  useEffect(() => {
    if (instance !== null && instance.getValue() !== value) instance.setValue(value);
  }, [instance, value]);

  const { wrapLines } = props;
  useEffect(() => {
    instance?.updateOptions({ wordWrap: wrapLines ? "on" : "off" });
  }, [instance, wrapLines]);

  const theme = codeTheme.theme;
  const mode = codeTheme.mode;
  useEffect(() => {
    if (monaco === null) return;
    if (theme === null) {
      monaco.editor.setTheme(mode === "dark" ? "vs-dark" : "vs");
      return;
    }
    const name = monacoThemeName(theme);
    monaco.editor.defineTheme(name, monacoThemeFrom(theme));
    monaco.editor.setTheme(name);
  }, [mode, monaco, theme]);

  if (hasFailed) return <PlainTextEditor {...props} />;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} className="absolute inset-0" />
      {monaco === null ? (
        <p className="p-6 text-sm text-muted-foreground">Loading the editor…</p>
      ) : null}
    </div>
  );
}

function PlainTextEditor({ path, value, wrapLines, onChange, onSave }: EditorProps) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        const isAccel = event.metaKey || event.ctrlKey;
        if (!isAccel || event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        onSave();
      }}
      aria-label={`Edit ${path}`}
      autoFocus
      spellCheck={false}
      wrap={wrapLines ? "soft" : "off"}
      className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[13px] leading-relaxed text-foreground focus:outline-none"
    />
  );
}
