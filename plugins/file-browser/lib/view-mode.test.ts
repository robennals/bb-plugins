import { describe, expect, it } from "vitest";
import {
  availableModes,
  isModeAvailable,
  isViewMode,
  preferredMode,
  resolveMode,
} from "./view-mode.js";

describe("availableModes", () => {
  it("offers the preview only for markdown", () => {
    expect(availableModes({ path: "README.md", isChanged: false, hasFork: true }))
      .toEqual({ canPreview: true, canDiff: false });
    expect(availableModes({ path: "index.ts", isChanged: false, hasFork: true }))
      .toEqual({ canPreview: false, canDiff: false });
  });

  it("offers the diff only with a fork point and a change", () => {
    expect(availableModes({ path: "index.ts", isChanged: true, hasFork: true }))
      .toEqual({ canPreview: false, canDiff: true });
    // No fork point — not a git repo, or git could not answer.
    expect(availableModes({ path: "index.ts", isChanged: true, hasFork: false }))
      .toEqual({ canPreview: false, canDiff: false });
  });

  it("offers nothing but source when no file is open", () => {
    expect(availableModes({ path: null, isChanged: false, hasFork: true }))
      .toEqual({ canPreview: false, canDiff: false });
  });
});

describe("preferredMode", () => {
  it("lands a changed file on its diff, markdown or not", () => {
    expect(preferredMode({ canPreview: true, canDiff: true })).toBe("diff");
    expect(preferredMode({ canPreview: false, canDiff: true })).toBe("diff");
  });

  it("lands unchanged markdown on the preview", () => {
    expect(preferredMode({ canPreview: true, canDiff: false })).toBe("preview");
  });

  it("lands anything else on the source", () => {
    expect(preferredMode({ canPreview: false, canDiff: false })).toBe("source");
  });
});

describe("resolveMode", () => {
  it("keeps a mode that still fits", () => {
    expect(resolveMode("source", { canPreview: true, canDiff: true })).toBe("source");
    expect(resolveMode("preview", { canPreview: true, canDiff: true })).toBe("preview");
    expect(resolveMode("diff", { canPreview: true, canDiff: true })).toBe("diff");
  });

  it("falls back when the diff goes away", () => {
    expect(resolveMode("diff", { canPreview: true, canDiff: false })).toBe("preview");
    expect(resolveMode("diff", { canPreview: false, canDiff: false })).toBe("source");
  });

  it("falls back to source when the file is not markdown", () => {
    expect(resolveMode("preview", { canPreview: false, canDiff: false })).toBe("source");
  });

  it("prefers the diff over the preview when both would be a fallback", () => {
    expect(resolveMode("preview", { canPreview: false, canDiff: true })).toBe("diff");
  });
});

describe("isModeAvailable", () => {
  it("always allows source", () => {
    expect(isModeAvailable("source", { canPreview: false, canDiff: false })).toBe(true);
  });
});

describe("isViewMode", () => {
  it("accepts every view", () => {
    for (const mode of ["preview", "source", "diff"]) {
      expect(isViewMode(mode), mode).toBe(true);
    }
  });

  it("rejects anything else a stored record might hold", () => {
    for (const value of ["", "Preview", "gallery", 7, null, undefined, {}]) {
      expect(isViewMode(value), String(value)).toBe(false);
    }
  });
});
