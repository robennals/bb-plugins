import { createFakePluginHost, type ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { DocRead } from "./lib/doc-read";
import { DEFAULT_PROMPT, fillPrompt } from "./lib/prompt";
import plugin from "./server";

const THREAD = "thr_1";
const ENVIRONMENT = "env_1";
const HOST = "host_1";
const HOME = "/home/me";
const DOC = `${HOME}/agent-progress/ship-it-thr_1.md`;

type Metadata = Record<string, unknown>;

function createHost(
  options: {
    metadata?: Metadata;
    environmentId?: string | null;
    title?: string | null;
    read?: DocRead;
    hostError?: Error;
    sendError?: Error;
    settings?: Record<string, string>;
  } = {},
) {
  let metadata: Metadata = { ...(options.metadata ?? {}) };
  const send = vi.fn(async () => {
    if (options.sendError) throw options.sendError;
    return { ok: true as const, delivery: "sent" as const };
  });
  const hostCalls: ExperimentalFakeHostRpcCall[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "progress-doc",
    experimental_hostEntry: true,
    settings: options.settings,
    experimental_callHostRpc: (call) => {
      hostCalls.push(call);
      if (options.hostError) throw options.hostError;
      const input = call.input as { path?: string; dir?: string };
      const expand = (value: string) => value.replace(/^~(?=\/|$)/, HOME);
      if (call.method === "resolvePath") return { path: expand(input.path!) };
      if (call.method === "listMarkdown") {
        return { kind: "ok", dir: expand(input.dir!), files: [] };
      }
      return options.read ?? { kind: "content", content: "# Hello", mtimeMs: 7 };
    },
    sdk: {
      threads: {
        get: vi.fn(async () => ({
          environmentId: options.environmentId === undefined ? ENVIRONMENT : options.environmentId,
          title: options.title === undefined ? "Ship it" : options.title,
          titleFallback: null,
        })),
        getPluginMetadata: vi.fn(async () => metadata),
        updatePluginMetadata: vi.fn(
          async ({ set, remove }: { set?: Metadata; remove?: string[] }) => {
            metadata = { ...metadata, ...(set ?? {}) };
            for (const key of remove ?? []) delete metadata[key];
            return metadata;
          },
        ),
        send,
      },
      environments: { get: vi.fn(async () => ({ hostId: HOST })) },
    } as never,
  });
  plugin(bb);
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  return { call, send, hostCalls, metadata: () => metadata };
}

describe("load", () => {
  it("reports no doc chosen for a fresh thread", async () => {
    const { call } = createHost();
    await expect(call("load", { threadId: THREAD, knownMtimeMs: null })).resolves.toEqual({
      kind: "unchosen",
    });
  });

  it("treats malformed metadata as unchosen", async () => {
    for (const metadata of [{ docPath: 42 }, { docPath: "relative.md" }, { docPath: "" }]) {
      const { call } = createHost({ metadata });
      await expect(call("load", { threadId: THREAD, knownMtimeMs: null })).resolves.toEqual({
        kind: "unchosen",
      });
    }
  });

  it("reads the chosen doc on the thread's machine, passing the known mtime", async () => {
    const { call, hostCalls } = createHost({ metadata: { docPath: DOC, askedAgent: true } });
    await expect(call("load", { threadId: THREAD, knownMtimeMs: 3 })).resolves.toEqual({
      kind: "chosen",
      docPath: DOC,
      askedAgent: true,
      doc: { kind: "content", content: "# Hello", mtimeMs: 7 },
    });
    expect(hostCalls).toEqual([
      expect.objectContaining({ method: "readDoc", hostId: HOST, input: { path: DOC, knownMtimeMs: 3 } }),
    ]);
  });

  it("reports a thread with no workspace", async () => {
    const { call } = createHost({ environmentId: null, metadata: { docPath: DOC } });
    await expect(call("load", { threadId: THREAD, knownMtimeMs: null })).resolves.toEqual({
      kind: "no-machine",
    });
  });

  it("turns a failed host call into an error the panel can show", async () => {
    const { call } = createHost({ metadata: { docPath: DOC }, hostError: new Error("host offline") });
    await expect(call("load", { threadId: THREAD, knownMtimeMs: null })).resolves.toMatchObject({
      kind: "chosen",
      doc: { kind: "error", message: "host offline" },
    });
  });
});

describe("choosePath", () => {
  it("expands and records a pasted path", async () => {
    const { call, metadata } = createHost();
    await expect(call("choosePath", { threadId: THREAD, path: " ~/notes/plan.md " })).resolves.toEqual({
      ok: true,
      docPath: `${HOME}/notes/plan.md`,
    });
    expect(metadata()).toEqual({ docPath: `${HOME}/notes/plan.md`, askedAgent: false });
  });

  it("refuses a relative path without recording anything", async () => {
    const { call, metadata } = createHost();
    await expect(call("choosePath", { threadId: THREAD, path: "plan.md" })).resolves.toMatchObject({
      ok: false,
    });
    expect(metadata()).toEqual({});
  });
});

describe("askAgent", () => {
  it("sends the default prompt naming the doc, then records it", async () => {
    const { call, send, metadata } = createHost();
    await expect(call("askAgent", { threadId: THREAD })).resolves.toEqual({ ok: true, docPath: DOC });
    expect(send).toHaveBeenCalledWith({
      threadId: THREAD,
      mode: "auto",
      input: [{ type: "text", text: fillPrompt(DEFAULT_PROMPT, DOC), mentions: [] }],
    });
    expect(metadata()).toEqual({ docPath: DOC, askedAgent: true });
  });

  it("uses the prompt from settings", async () => {
    const { call, send } = createHost({ settings: { prompt: "Track it in {{path}} please" } });
    await call("askAgent", { threadId: THREAD });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: `Track it in ${DOC} please`, mentions: [] }],
      }),
    );
  });

  it("names the file after the thread id alone when the thread has no title", async () => {
    const { call } = createHost({ title: null });
    await expect(call("askAgent", { threadId: THREAD })).resolves.toEqual({
      ok: true,
      docPath: `${HOME}/agent-progress/thread-thr_1.md`,
    });
  });

  it("records nothing when the message could not be sent", async () => {
    const { call, metadata } = createHost({ sendError: new Error("thread archived") });
    await expect(call("askAgent", { threadId: THREAD })).resolves.toEqual({
      ok: false,
      message: "thread archived",
    });
    expect(metadata()).toEqual({});
  });
});

describe("listFiles", () => {
  it("lists the agent-progress folder on the thread's machine", async () => {
    const { call, hostCalls } = createHost();
    await expect(call("listFiles", { threadId: THREAD })).resolves.toEqual({
      kind: "ok",
      dir: `${HOME}/agent-progress`,
      files: [],
    });
    expect(hostCalls[0]).toMatchObject({ method: "listMarkdown", input: { dir: "~/agent-progress" } });
  });
});

describe("forget", () => {
  it("clears the choice so the chooser shows again", async () => {
    const { call, metadata } = createHost({ metadata: { docPath: DOC, askedAgent: true, other: 1 } });
    await expect(call("forget", { threadId: THREAD })).resolves.toEqual({ ok: true });
    expect(metadata()).toEqual({ other: 1 });
  });
});
