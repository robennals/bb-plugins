// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it, vi } from "vitest";

/**
 * The thunk matters: app.tsx binds the plugin runtime at module load, so
 * loadPluginApp must install the test runtime before importing it.
 */
const load = () => loadPluginApp(() => import("./app"));

// jsdom has no layout, so it leaves this out; the explorer calls it to keep the
// open file's row in view.
Element.prototype.scrollIntoView = () => {};

const SCOPE = { kind: "project" as const, id: "p1" };

const TREE = {
  scope: {
    root: "/work/app",
    hostId: "h1",
    hostName: "laptop",
    isLocal: true,
    label: "app",
    sublabel: "project checkout",
    projectId: "p1",
    environmentId: null,
    ref: SCOPE,
  },
  entries: [{ path: "notes.txt", kind: "file" as const }],
  truncated: false,
  listing: "local" as const,
  excluded: [],
  changes: { kind: "unavailable" as const, reason: "This workspace is not a git repository." },
};

function textFile(content: string, sha256: string) {
  return {
    kind: "text" as const,
    content,
    sha256,
    sizeBytes: content.length,
    absolutePath: "/work/app/notes.txt",
  };
}

/**
 * Which view a file lands on is decided once the tree has answered, so a click
 * before that would be overruled. The explorer listing the file is the tree
 * having answered.
 */
async function startEditing(slot: ReturnType<typeof renderSlot>) {
  await slot.findByRole("treeitem", { name: /notes\.txt/ });
  fireEvent.click(slot.getByRole("button", { name: "Edit" }));
}

/** Open `notes.txt` on the Files page and start editing it. */
async function openEditor(rpc: Record<string, (input: never) => unknown>) {
  const app = await load();
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "project/p1/notes.txt" },
    { rpc: { tree: () => TREE, ...rpc } },
  );
  await startEditing(slot);
  const editor = await slot.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit notes.txt",
  });
  const writes = () =>
    slot.inspection.rpcCalls
      .filter((call) => call.method === "write")
      .map((call) => call.input);
  return { slot, editor, writes };
}

describe("the edit view", () => {
  it("saves the edited text against the hash of the file that was read", async () => {
    const { slot, editor, writes } = await openEditor({
      read: () => textFile("one\n", "sha-read"),
      write: () => ({ kind: "written", sha256: "sha-saved" }),
    });
    expect(editor.value).toBe("one\n");
    expect(slot.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);

    fireEvent.change(editor, { target: { value: "one\ntwo\n" } });
    await slot.findByText("Unsaved changes");
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await slot.findByText("No unsaved changes");
    expect(writes()).toEqual([
      { scope: SCOPE, path: "notes.txt", content: "one\ntwo\n", expectedSha256: "sha-read" },
    ]);

    // A second save is checked against what the first one wrote, not against
    // the file as it was first read.
    fireEvent.change(editor, { target: { value: "three\n" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ content: "three\n", expectedSha256: "sha-saved" });
    slot.lifecycle.unmount();
  });

  it("writes a Windows-style file back with its own line endings", async () => {
    const { slot, editor, writes } = await openEditor({
      read: () => textFile("one\r\ntwo\r\n", "sha-read"),
      write: () => ({ kind: "written", sha256: "sha-saved" }),
    });
    fireEvent.change(editor, { target: { value: "one\ntwo\nthree\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ content: "one\r\ntwo\r\nthree\r\n" });
    slot.lifecycle.unmount();
  });

  it("explains why a file that mixes line endings cannot be edited", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "project/p1/notes.txt" },
      { rpc: { tree: () => TREE, read: () => textFile("one\r\ntwo\n", "sha-read") } },
    );
    await startEditing(slot);
    await slot.findByText(/mixes Windows and Unix line endings/);
    expect(slot.queryByRole("textbox", { name: "Edit notes.txt" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps unsaved text across a trip to the source view, and discards it when asked", async () => {
    const { slot, editor } = await openEditor({
      read: () => textFile("one\n", "sha-read"),
    });
    fireEvent.change(editor, { target: { value: "mine\n" } });

    fireEvent.click(slot.getByRole("button", { name: "File" }));
    await waitFor(() =>
      expect(slot.queryByRole("textbox", { name: "Edit notes.txt" })).toBeNull(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    const back = await slot.findByRole<HTMLTextAreaElement>("textbox", { name: "Edit notes.txt" });
    expect(back.value).toBe("mine\n");

    fireEvent.click(slot.getByRole("button", { name: "Discard" }));
    await slot.findByText("No unsaved changes");
    expect(back.value).toBe("one\n");
    slot.lifecycle.unmount();
  });

  it("stops when the file changed on disk, and overwrites only when told to", async () => {
    let attempts = 0;
    const { slot, editor, writes } = await openEditor({
      read: () => textFile("one\n", "sha-read"),
      write: () => {
        attempts += 1;
        return attempts === 1
          ? { kind: "conflict", currentSha256: "sha-theirs" }
          : { kind: "written", sha256: "sha-saved" };
      },
    });
    fireEvent.change(editor, { target: { value: "mine\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await slot.findByText("This file changed on disk while you were editing it.");
    // The edit is still there to copy out of.
    expect(editor.value).toBe("mine\n");

    fireEvent.click(slot.getByRole("button", { name: "Overwrite" }));
    await slot.findByText("No unsaved changes");
    expect(writes()[1]).toMatchObject({ content: "mine\n", expectedSha256: "sha-theirs" });
    slot.lifecycle.unmount();
  });

  it("offers line wrapping beside the mode buttons, and remembers it", async () => {
    const { slot, editor } = await openEditor({
      read: () => textFile("one\n", "sha-read"),
    });
    expect(editor.wrap).toBe("off");

    fireEvent.click(slot.getByRole("button", { name: "Wrap long lines" }));
    expect(editor.wrap).toBe("soft");
    expect(localStorage.getItem("file-browser:wrap-lines")).toBe("true");

    fireEvent.click(slot.getByRole("button", { name: "Stop wrapping long lines" }));
    expect(editor.wrap).toBe("off");
    slot.lifecycle.unmount();
  });

  it("keeps the edit when the save fails", async () => {
    const { slot, editor } = await openEditor({
      read: () => textFile("one\n", "sha-read"),
      write: () => {
        throw new Error("The machine holding this workspace is offline.");
      },
    });
    fireEvent.change(editor, { target: { value: "mine\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "write")).toBe(true),
    );
    await slot.findByText("Unsaved changes");
    expect(editor.value).toBe("mine\n");
    slot.lifecycle.unmount();
  });

  it("asks before opening another file over unsaved changes", async () => {
    const answers = [false, true];
    const asked: string[] = [];
    vi.stubGlobal("confirm", (message: string) => {
      asked.push(message);
      return answers.shift() ?? true;
    });
    const { slot, editor } = await openEditor({
      tree: () => ({
        ...TREE,
        entries: [...TREE.entries, { path: "other.txt", kind: "file" as const }],
      }),
      read: () => textFile("one\n", "sha-read"),
    });
    fireEvent.change(editor, { target: { value: "mine\n" } });
    await slot.findByText("Unsaved changes");

    // Declined: nothing is opened and the edit stays.
    fireEvent.click(slot.getByText("other.txt"));
    expect(asked).toEqual(["Discard your unsaved changes to notes.txt?"]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(editor.value).toBe("mine\n");

    // Accepted: the other file is opened.
    fireEvent.click(slot.getByText("other.txt"));
    expect(slot.inspection.navigateCalls).toHaveLength(1);
    vi.unstubAllGlobals();
    slot.lifecycle.unmount();
  });

  it("re-reads the file when the edit is discarded after a conflict", async () => {
    let reads = 0;
    const { slot, editor } = await openEditor({
      read: () => {
        reads += 1;
        return reads === 1 ? textFile("one\n", "sha-read") : textFile("theirs\n", "sha-theirs");
      },
      write: () => ({ kind: "conflict", currentSha256: "sha-theirs" }),
    });
    fireEvent.change(editor, { target: { value: "mine\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    fireEvent.click(await slot.findByRole("button", { name: "Discard my edit" }));

    // The edit view carries on from what is on disk now.
    await waitFor(() =>
      expect(
        slot.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit notes.txt" }).value,
      ).toBe("theirs\n"),
    );
    slot.lifecycle.unmount();
  });
});
