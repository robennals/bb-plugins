// The preset commands a user has saved, kept free of the SDK so the rules can
// be tested on their own.
import { z } from "zod";

/** Only http(s) addresses can be opened in a BB browser tab. */
function isWebAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export const presetSchema = z.object({
  id: z.string().min(1),
  /** What the dropdown calls it, and the title of its terminal. */
  name: z.string().trim().min(1, "Give the command a name").max(80),
  /** A shell command line, run in the thread's workspace. */
  command: z.string().trim().min(1, "Enter the command to run").max(2000),
  /**
   * An address to open in a browser tab once the command is up, or "" for
   * none. A string rather than null so it maps straight onto a text field.
   */
  url: z
    .string()
    .trim()
    .refine((value) => value === "" || isWebAddress(value), "Use an http:// or https:// address"),
});
export type Preset = z.infer<typeof presetSchema>;

export const presetsSchema = z
  .array(presetSchema)
  .max(50)
  .refine(
    (presets) => new Set(presets.map((preset) => preset.id)).size === presets.length,
    "Two commands share an id",
  );

/**
 * What is in storage, read defensively: it is JSON this plugin wrote, but an
 * older version may have written a different shape, and a list we cannot read
 * should come back empty rather than break the header button.
 */
export function parseStoredPresets(stored: unknown): Preset[] {
  const parsed = presetsSchema.safeParse(stored ?? []);
  return parsed.success ? parsed.data : [];
}
