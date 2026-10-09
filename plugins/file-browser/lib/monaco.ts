/**
 * Loading the Monaco bundle the server hands out (see
 * `scripts/build-monaco.mjs`). It is fetched once per page, the first time an
 * edit view opens, and shared by every edit view after that.
 */

import type * as Monaco from "monaco-editor";

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;

/** `baseUrl` is the path the server said the bundle's files are under. */
export function loadMonaco(baseUrl: string): Promise<MonacoApi> {
  loading ??= load(baseUrl).catch((error: unknown) => {
    // A failed load is not remembered, so the next edit view tries again.
    loading = null;
    throw error;
  });
  return loading;
}

async function load(baseUrl: string): Promise<MonacoApi> {
  const urlOf = (file: string) =>
    new URL(`${baseUrl}/${file}`, window.location.origin).href;

  await loadStylesheet(urlOf("editor.css"));
  // Monaco asks this global for its background worker (diffing, link
  // detection). The language services that would want workers of their own
  // are left out of the bundle.
  Object.assign(globalThis, {
    MonacoEnvironment: {
      getWorker: () => new Worker(urlOf("editor.worker.js"), { type: "module" }),
    },
  });

  const bundle: { monaco?: MonacoApi } = await import(
    /* @vite-ignore */ urlOf("editor.js")
  );
  if (bundle.monaco === undefined) {
    throw new Error("The Monaco bundle did not expose its API.");
  }
  return bundle.monaco;
}

function loadStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}
