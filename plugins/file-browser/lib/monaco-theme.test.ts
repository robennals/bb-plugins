import { describe, expect, it } from "vitest";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { monacoThemeFrom, monacoThemeName } from "./monaco-theme.js";

const THEME: PluginCodeThemeData = {
  name: "GitHub Dark (dimmed)",
  type: "dark",
  fg: "#adbac7",
  bg: "#22272e",
  colors: {
    "editorCursor.foreground": "#539bf5",
    "not.a.colour": "transparent",
  },
  tokenColors: [
    { settings: { foreground: "#adbac7" } },
    { scope: "comment, string.comment", settings: { foreground: "#768390", fontStyle: "italic" } },
    { scope: ["constant.numeric"], settings: { foreground: "#6cb6ff" } },
    { scope: "string", settings: { foreground: "#abc" } },
    { scope: "keyword", settings: { fontStyle: "bold strikethrough" } },
    { scope: "ignored", settings: { foreground: "red" } },
  ],
};

describe("monacoThemeFrom", () => {
  const converted = monacoThemeFrom(THEME);
  const ruleFor = (token: string) => converted.rules.find((rule) => rule.token === token);

  it("starts from Monaco's dark or light base to match the theme", () => {
    expect(converted.base).toBe("vs-dark");
    expect(monacoThemeFrom({ ...THEME, type: "light" }).base).toBe("vs");
  });

  it("paints unmatched text in the theme's default colour", () => {
    expect(ruleFor("")).toEqual({ token: "", foreground: "adbac7" });
  });

  it("gives each scope of a rule the rule's colour and style", () => {
    expect(ruleFor("comment")).toEqual({ token: "comment", foreground: "768390", fontStyle: "italic" });
    expect(ruleFor("string.comment")).toEqual(ruleFor("comment") && { ...ruleFor("comment"), token: "string.comment" });
  });

  it("widens a three-digit colour and drops one that is not hex", () => {
    expect(ruleFor("string")?.foreground).toBe("aabbcc");
    expect(ruleFor("ignored")).toBeUndefined();
  });

  it("keeps only the font styles Monaco knows", () => {
    expect(ruleFor("keyword")).toEqual({ token: "keyword", fontStyle: "bold" });
  });

  it("colours Monaco's own token names from the matching TextMate scope", () => {
    expect(ruleFor("number")).toEqual({ token: "number", foreground: "6cb6ff" });
    expect(ruleFor("attribute.value")?.foreground).toBe("aabbcc");
    // Nothing in this theme colours tags, so Monaco's base theme decides.
    expect(ruleFor("tag")).toBeUndefined();
  });

  it("carries over workbench colours and fills in the editor's own from fg and bg", () => {
    expect(converted.colors).toEqual({
      "editorCursor.foreground": "#539bf5",
      "editor.background": "#22272e",
      "editor.foreground": "#adbac7",
    });
  });
});

describe("monacoThemeName", () => {
  it("replaces what Monaco does not allow in a theme name", () => {
    expect(monacoThemeName(THEME)).toBe("bb-GitHub-Dark--dimmed-");
  });
});
