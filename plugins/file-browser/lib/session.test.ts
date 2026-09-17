import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_STORE,
  lastScope,
  parseScopeKey,
  parseStore,
  readLastScope,
  readSession,
  readStore,
  saveSession,
  scopeKey,
  sessionFor,
  withSession,
} from "./session.js";
import type { ViewMode } from "./view-mode.js";

const store = (
  entries: readonly [
    string,
    { filePath: string | null; mode?: ViewMode | null; expanded?: string[] },
  ][],
) =>
  entries.reduce(
    (current, [key, session]) =>
      withSession(current, key, {
        filePath: session.filePath,
        mode: session.mode ?? null,
        expanded: session.expanded ?? [],
      }),
    EMPTY_STORE,
  );

describe("scopeKey", () => {
  it("round-trips a workspace reference", () => {
    const scope = { kind: "thread", id: "thr_abc" } as const;
    expect(parseScopeKey(scopeKey(scope))).toEqual(scope);
  });

  it("round-trips an id containing the separator", () => {
    const scope = { kind: "project", id: "a:b:c" } as const;
    expect(parseScopeKey(scopeKey(scope))).toEqual(scope);
  });

  it("rejects a key that is not one", () => {
    for (const key of ["", "thread", "thread:", ":abc", "nonsense:abc"]) {
      expect(parseScopeKey(key), key).toBeNull();
    }
  });
});

describe("withSession", () => {
  it("remembers the file, how it was read, and the unfolded folders", () => {
    const current = store([
      ["thread:a", { filePath: "docs/x.md", mode: "preview", expanded: ["docs"] }],
    ]);
    expect(sessionFor(current, "thread:a")).toEqual({
      filePath: "docs/x.md",
      mode: "preview",
      expanded: ["docs"],
    });
  });

  it("keeps the remembered file and view when the caller has neither yet", () => {
    let current = store([
      ["thread:a", { filePath: "README.md", mode: "preview" }],
    ]);
    current = withSession(current, "thread:a", {
      filePath: null,
      mode: null,
      expanded: ["docs"],
    });
    expect(sessionFor(current, "thread:a")).toEqual({
      filePath: "README.md",
      mode: "preview",
      expanded: ["docs"],
    });
  });

  it("replaces the remembered file and view when a new one is open", () => {
    let current = store([
      ["thread:a", { filePath: "README.md", mode: "preview" }],
    ]);
    current = withSession(current, "thread:a", {
      filePath: "src/app.ts",
      mode: "diff",
      expanded: [],
    });
    expect(sessionFor(current, "thread:a")).toMatchObject({
      filePath: "src/app.ts",
      mode: "diff",
    });
  });

  it("keeps one workspace's session out of another's", () => {
    const current = store([
      ["thread:a", { filePath: "a.md", expanded: ["docs"] }],
      ["thread:b", { filePath: "b.md", expanded: [] }],
    ]);
    expect(sessionFor(current, "thread:a")).toEqual({
      filePath: "a.md",
      mode: null,
      expanded: ["docs"],
    });
    expect(sessionFor(current, "thread:b")?.filePath).toBe("b.md");
  });

  it("puts the workspace just used at the head of the order", () => {
    const current = store([
      ["thread:a", { filePath: "a.md" }],
      ["thread:b", { filePath: "b.md" }],
      ["thread:a", { filePath: "a.md" }],
    ]);
    expect(current.order).toEqual(["thread:a", "thread:b"]);
  });

  it("evicts the least recently used workspace past the cap", () => {
    const keys = Array.from({ length: 30 }, (_, index) => `thread:w${index}`);
    const current = store(keys.map((key) => [key, { filePath: "x.md" }]));

    expect(current.order).toHaveLength(24);
    expect(Object.keys(current.sessions)).toHaveLength(24);
    // Newest kept, oldest gone.
    expect(sessionFor(current, "thread:w29")).not.toBeNull();
    expect(sessionFor(current, "thread:w0")).toBeNull();
  });

  it("caps how many unfolded folders one workspace remembers", () => {
    const expanded = Array.from({ length: 700 }, (_, index) => `dir${index}`);
    const current = withSession(EMPTY_STORE, "thread:a", {
      filePath: null,
      mode: null,
      expanded,
    });
    expect(sessionFor(current, "thread:a")?.expanded).toHaveLength(500);
  });
});

describe("lastScope", () => {
  it("is the workspace used most recently", () => {
    const current = store([
      ["thread:a", { filePath: "a.md" }],
      ["project:p", { filePath: "b.md" }],
    ]);
    expect(lastScope(current)).toEqual({ kind: "project", id: "p" });
  });

  it("skips a key that is no longer a workspace reference", () => {
    const parsed = parseStore(
      JSON.stringify({
        order: ["nonsense", "thread:a"],
        sessions: {
          nonsense: { filePath: "x.md", expanded: [] },
          "thread:a": { filePath: "a.md", expanded: [] },
        },
      }),
    );
    expect(lastScope(parsed)).toEqual({ kind: "thread", id: "a" });
  });

  it("is null for an empty store", () => {
    expect(lastScope(EMPTY_STORE)).toBeNull();
  });
});

describe("parseStore", () => {
  it("round-trips what it wrote", () => {
    const written = store([
      ["thread:a", { filePath: "src/index.ts", expanded: ["src", "src/lib"] }],
    ]);
    expect(parseStore(JSON.stringify(written))).toEqual(written);
  });

  it("starts empty when nothing is stored", () => {
    expect(parseStore(null)).toEqual(EMPTY_STORE);
  });

  it("discards a record that is not JSON, or not an object", () => {
    for (const raw of ["{not json", '"a string"', "42", "null", "[]"]) {
      expect(parseStore(raw).order, raw).toEqual([]);
    }
  });

  it("drops fields of the wrong type rather than throwing", () => {
    const parsed = parseStore(
      JSON.stringify({
        order: ["thread:a", 7, null],
        sessions: {
          "thread:a": { filePath: 7, expanded: ["src", 9, ""] },
          "thread:b": "not a session",
        },
      }),
    );
    expect(parsed.order).toEqual(["thread:a"]);
    expect(sessionFor(parsed, "thread:a")).toEqual({
      filePath: null,
      mode: null,
      expanded: ["src"],
    });
    expect(sessionFor(parsed, "thread:b")).toBeNull();
  });

  it("treats a session with no folder list as having none unfolded", () => {
    const parsed = parseStore(
      JSON.stringify({
        order: ["thread:a"],
        sessions: { "thread:a": { filePath: "a.md" } },
      }),
    );
    expect(sessionFor(parsed, "thread:a")).toEqual({
      filePath: "a.md",
      mode: null,
      expanded: [],
    });
  });

  it("leaves the view to be decided when the stored one is not a view", () => {
    for (const mode of ["gallery", 7, null]) {
      const parsed = parseStore(
        JSON.stringify({
          order: ["thread:a"],
          sessions: { "thread:a": { filePath: "a.md", mode, expanded: [] } },
        }),
      );
      expect(sessionFor(parsed, "thread:a")?.mode, String(mode)).toBeNull();
    }
  });

  it("keeps every view it knows", () => {
    for (const mode of ["preview", "source", "diff"] satisfies ViewMode[]) {
      const parsed = parseStore(
        JSON.stringify({
          order: ["thread:a"],
          sessions: { "thread:a": { filePath: "a.md", mode, expanded: [] } },
        }),
      );
      expect(sessionFor(parsed, "thread:a")?.mode, mode).toBe(mode);
    }
  });

  it("gives a session missing from the order a place in it", () => {
    const parsed = parseStore(
      JSON.stringify({
        order: [],
        sessions: { "thread:a": { filePath: "a.md", expanded: [] } },
      }),
    );
    expect(parsed.order).toEqual(["thread:a"]);
  });
});

/**
 * The round trip through storage is the whole point of this module, so it is
 * exercised against a stand-in for the browser's own — the test environment is
 * Node and has no `window`.
 */
describe("readStore and saveSession", () => {
  const useStorage = (localStorage: Pick<Storage, "getItem" | "setItem">) => {
    vi.stubGlobal("window", { localStorage });
  };

  /** Enough of `Storage` for this module, which only reads and writes one key. */
  const workingStorage = (): Pick<Storage, "getItem" | "setItem"> => {
    const entries = new Map<string, string>();
    return {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => void entries.set(key, value),
    };
  };

  const brokenStorage = (): Pick<Storage, "getItem" | "setItem"> => ({
    getItem: () => {
      throw new Error("storage is disabled");
    },
    setItem: () => {
      throw new Error("storage is disabled");
    },
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("brings back the file and folders that were saved", () => {
    useStorage(workingStorage());
    const scope = { kind: "thread", id: "thr_abc" } as const;

    saveSession(scope, {
      filePath: "docs/guide.md",
      mode: "preview",
      expanded: ["docs"],
    });

    expect(readSession(scope)).toEqual({
      filePath: "docs/guide.md",
      mode: "preview",
      expanded: ["docs"],
    });
    expect(readLastScope()).toEqual(scope);
  });

  it("keeps two workspaces' places apart", () => {
    useStorage(workingStorage());
    const first = { kind: "thread", id: "a" } as const;
    const second = { kind: "environment", id: "b" } as const;

    saveSession(first, { filePath: "a.md", mode: "preview", expanded: ["src"] });
    saveSession(second, { filePath: "b.md", mode: "diff", expanded: [] });

    expect(readSession(first)).toMatchObject({ filePath: "a.md", mode: "preview" });
    expect(readSession(second)).toMatchObject({ filePath: "b.md", mode: "diff" });
    // The last one saved is the one a visit with no workspace falls back to.
    expect(readLastScope()).toEqual(second);
  });

  it("has nothing to say about a workspace never visited", () => {
    useStorage(workingStorage());
    expect(readSession({ kind: "thread", id: "unseen" })).toBeNull();
    expect(readSession(null)).toBeNull();
    expect(readLastScope()).toBeNull();
  });

  it("carries on when storage is unavailable", () => {
    useStorage(brokenStorage());

    expect(readStore()).toEqual(EMPTY_STORE);
    expect(readSession({ kind: "thread", id: "a" })).toBeNull();
    expect(() =>
      saveSession(
        { kind: "thread", id: "a" },
        { filePath: "a.md", mode: "source", expanded: [] },
      ),
    ).not.toThrow();
  });
});
