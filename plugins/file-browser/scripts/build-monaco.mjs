/**
 * Bundle the Monaco editor into three files a browser can load on demand:
 * `editor.js`, `editor.css` and `editor.worker.js`, in `monaco-bundle/`.
 *
 * Monaco is several megabytes, so it stays out of the plugin's own frontend
 * bundle; the server hands these files out and the edit view imports them the
 * first time it opens. Run as a script, or imported by the server when the
 * bundle is missing.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outdir = path.join(pluginRoot, "monaco-bundle");

/**
 * Monaco's main entry also registers language SERVICES for TypeScript, JSON,
 * CSS and HTML, each wanting a web worker of its own. They check one file with
 * no knowledge of the project around it, so in TypeScript they underline every
 * import as an error. Leave them out: syntax colouring comes from the language
 * definitions, which stay.
 */
const withoutLanguageServices = {
  name: "without-language-services",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /languages\/features\/|monaco-lsp-client/ },
      (args) => ({ path: args.path, namespace: "left-out" }),
    );
    pluginBuild.onLoad({ filter: /.*/, namespace: "left-out" }, () => ({
      contents: "",
    }));
  },
};

await mkdir(outdir, { recursive: true });

const shared = {
  absWorkingDir: pluginRoot,
  bundle: true,
  format: "esm",
  minify: true,
  logLevel: "warning",
};

await build({
  ...shared,
  stdin: {
    contents: 'export * as monaco from "monaco-editor/editor/editor.main.js";',
    resolveDir: pluginRoot,
  },
  outfile: path.join(outdir, "editor.js"),
  // The icon font goes inside the stylesheet, so there is no fourth file whose
  // address the stylesheet would have to know.
  loader: { ".ttf": "dataurl" },
  plugins: [withoutLanguageServices],
});

await build({
  ...shared,
  entryPoints: ["monaco-editor/editor/editor.worker.js"],
  outfile: path.join(outdir, "editor.worker.js"),
});
