import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const SCOPE = { kind: "project" as const, id: "p1" };

type WriteOutcome =
  | { outcome: "written"; sha256: string; sizeBytes: number }
  | { outcome: "conflict"; currentSha256: string | null };

function hostWhoseWriteReturns(saved: WriteOutcome) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "file-browser",
    sdk: {
      projects: {
        get: async () => ({
          id: "p1",
          name: "app",
          sources: [{ isDefault: true, path: "/work/app", hostId: "h1" }],
        }),
      },
      hosts: { get: async () => ({ name: "laptop" }) },
      system: { config: async () => ({ dataDir: "/nonexistent" }) },
      files: { write: async () => saved },
    },
  });
  plugin(bb);
  return harness;
}

describe("write", () => {
  it("writes inside the workspace, on its machine, against the hash it was given", async () => {
    const harness = hostWhoseWriteReturns({ outcome: "written", sha256: "sha-saved", sizeBytes: 4 });

    await expect(
      harness.behavior.callRpc("write", {
        scope: SCOPE,
        path: "docs/notes.txt",
        content: "one\n",
        expectedSha256: "sha-read",
      }),
    ).resolves.toEqual({ kind: "written", sha256: "sha-saved" });

    expect(harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          hostId: "h1",
          path: "/work/app/docs/notes.txt",
          rootPath: "/work/app",
          content: "one\n",
          expectedSha256: "sha-read",
        },
      ],
    ]);
  });

  it("reports a file that changed on disk instead of replacing it", async () => {
    const harness = hostWhoseWriteReturns({ outcome: "conflict", currentSha256: "sha-theirs" });

    await expect(
      harness.behavior.callRpc("write", {
        scope: SCOPE,
        path: "notes.txt",
        content: "mine\n",
        expectedSha256: "sha-read",
      }),
    ).resolves.toEqual({ kind: "conflict", currentSha256: "sha-theirs" });
  });

  it("refuses a path that climbs out of the workspace", async () => {
    const harness = hostWhoseWriteReturns({ outcome: "written", sha256: "sha-saved", sizeBytes: 4 });

    await expect(
      harness.behavior.callRpc("write", {
        scope: SCOPE,
        path: "../outside.txt",
        content: "x",
        expectedSha256: null,
      }),
    ).rejects.toThrow("Path escapes the workspace");
    expect(harness.sdk.callsTo("files.write")).toEqual([]);
  });
});
