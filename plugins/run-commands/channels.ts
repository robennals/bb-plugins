// The realtime channels the server publishes on and the frontend listens to.
// Kept in a file of their own, free of imports, because the frontend bundle
// must not pull in server.ts: that file needs the plugin SDK package, which a
// git install (`npm install --omit=dev`) does not have when it builds the
// frontend. The frontend takes only types from server.ts.

/** Payload `{ projectId }`: that project's list of commands was edited. */
export const PRESETS_CHANGED = "presets-changed";
/** Payload `{ threadId }`: a run was added, removed, or changed status. */
export const RUNS_CHANGED = "runs-changed";
/** Payload `{ threadId, runId }`: a run printed more. */
export const OUTPUT_ADDED = "output-added";
