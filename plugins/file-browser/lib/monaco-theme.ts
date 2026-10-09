/**
 * BB's code theme, as a theme Monaco can paint with — so the editor's colours
 * are the ones the read-only source view beside it uses.
 *
 * BB hands over a VS Code theme file, whose rules name TextMate scopes
 * (`constant.numeric`). Monaco's own tokenizers name their tokens differently
 * (`number`), and a rule only applies to a token that starts with its name. The
 * scopes both sides share (`comment`, `string`, `keyword`) carry over as they
 * are; the handful below are the common ones that do not.
 *
 * The scope-to-rule translation follows BB's built-in File Editor plugin (MIT).
 */

import type { editor } from "monaco-editor";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

/** Monaco token name → the TextMate scopes that colour the same thing. */
const MONACO_TOKEN_SCOPES: Readonly<Record<string, readonly string[]>> = {
  number: ["constant.numeric"],
  regexp: ["string.regexp"],
  type: ["entity.name.type", "support.type"],
  tag: ["entity.name.tag"],
  "attribute.name": ["entity.other.attribute-name"],
  "attribute.value": ["string"],
};

const HEX_COLOR = /^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/** Monaco wants token colours as six or eight hex digits with no `#`. */
function tokenColor(color: string | undefined): string | undefined {
  if (color === undefined || !HEX_COLOR.test(color)) return undefined;
  const digits = color.slice(1);
  return digits.length <= 4
    ? [...digits].map((digit) => digit + digit).join("")
    : digits;
}

function fontStyle(style: string | undefined): string | undefined {
  if (style === undefined) return undefined;
  return style
    .split(/\s+/)
    .filter((word) => word === "italic" || word === "bold" || word === "underline")
    .join(" ");
}

function scopesOf(scope: string | readonly string[] | undefined): string[] {
  if (scope === undefined) return [];
  const listed = typeof scope === "string" ? scope.split(",") : scope;
  return listed.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

export function monacoThemeFrom(
  theme: PluginCodeThemeData,
): editor.IStandaloneThemeData {
  const rules: editor.ITokenThemeRule[] = [];
  const defaultColor = tokenColor(theme.fg);
  if (defaultColor !== undefined) rules.push({ token: "", foreground: defaultColor });

  for (const rule of theme.tokenColors) {
    const foreground = tokenColor(rule.settings.foreground);
    const style = fontStyle(rule.settings.fontStyle);
    if (foreground === undefined && style === undefined) continue;
    for (const scope of scopesOf(rule.scope)) {
      rules.push({
        token: scope,
        ...(foreground === undefined ? {} : { foreground }),
        ...(style === undefined ? {} : { fontStyle: style }),
      });
    }
  }

  for (const [token, scopes] of Object.entries(MONACO_TOKEN_SCOPES)) {
    if (rules.some((rule) => rule.token === token)) continue;
    // A later rule in a theme file overrides an earlier one, so take the last.
    const match = rules.filter((rule) => scopes.includes(rule.token)).at(-1);
    if (match !== undefined) rules.push({ ...match, token });
  }

  const colors: Record<string, string> = {};
  for (const [name, color] of Object.entries(theme.colors)) {
    if (HEX_COLOR.test(color)) colors[name] = color;
  }
  if (colors["editor.background"] === undefined && HEX_COLOR.test(theme.bg)) {
    colors["editor.background"] = theme.bg;
  }
  if (colors["editor.foreground"] === undefined && HEX_COLOR.test(theme.fg)) {
    colors["editor.foreground"] = theme.fg;
  }

  return {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors,
  };
}

/** Monaco theme names allow letters, digits and dashes only. */
export function monacoThemeName(theme: PluginCodeThemeData): string {
  return `bb-${theme.name.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}
