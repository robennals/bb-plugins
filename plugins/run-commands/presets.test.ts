import { describe, expect, it } from "vitest";
import { parseStoredPresets, presetsSchema, type Preset } from "./presets.js";

const dev: Preset = { id: "a", name: "Dev server", command: "npm run dev", url: "" };

function firstIssue(presets: unknown): string | undefined {
  const parsed = presetsSchema.safeParse(presets);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

describe("presetsSchema", () => {
  it("accepts a command with no address", () => {
    expect(firstIssue([dev])).toBeUndefined();
  });

  it("asks for a name and a command", () => {
    expect(firstIssue([{ ...dev, name: "  " }])).toBe("Give the command a name");
    expect(firstIssue([{ ...dev, command: "" }])).toBe("Enter the command to run");
  });

  it("only takes web addresses, since that is all a browser tab can open", () => {
    expect(firstIssue([{ ...dev, url: "http://localhost:3000" }])).toBeUndefined();
    expect(firstIssue([{ ...dev, url: "localhost:3000" }])).toBe("Use an http:// or https:// address");
    expect(firstIssue([{ ...dev, url: "file:///etc/passwd" }])).toBe("Use an http:// or https:// address");
  });
});

describe("parseStoredPresets", () => {
  it("reads nothing stored as an empty list", () => {
    expect(parseStoredPresets(undefined)).toEqual([]);
  });

  it("reads a shape it does not recognise as an empty list rather than throwing", () => {
    expect(parseStoredPresets([{ title: "from an older version" }])).toEqual([]);
  });
});
