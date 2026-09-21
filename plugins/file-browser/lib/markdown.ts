/**
 * Markdown-specific text handling for the preview.
 *
 * The only thing the preview has to do to the source before handing it to BB's
 * renderer is take the YAML frontmatter off the top. A chat-message renderer
 * has no notion of frontmatter, so `---` opens a horizontal rule and the keys
 * below it land as body text — which is exactly the wrong reading for the
 * files that use frontmatter most (skills, agents, docs with metadata). Split
 * it out and the preview can show it as what it is: a small metadata block.
 */

export interface SplitMarkdown {
  /** The frontmatter body, without its `---` fences; null when there is none. */
  frontmatter: string | null;
  /** Everything after the frontmatter, or the whole file when there is none. */
  body: string;
}

/** `---` opens frontmatter; YAML lets either `---` or `...` close it. */
const OPENING_FENCE = /^---[ \t]*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

export function splitFrontmatter(content: string): SplitMarkdown {
  const lines = content.split("\n");
  // Frontmatter has to open on the very first line of the file; anything else
  // there — including a blank line — means there is none.
  if (lines.length === 0 || !OPENING_FENCE.test(stripCarriageReturn(lines[0]!))) {
    return { frontmatter: null, body: content };
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (!CLOSING_FENCE.test(stripCarriageReturn(lines[index]!))) continue;
    return {
      frontmatter: lines
        .slice(1, index)
        .map(stripCarriageReturn)
        .join("\n"),
      body: lines.slice(index + 1).join("\n"),
    };
  }

  // An opening fence with no closing one is not frontmatter — it is a document
  // that happens to start with a horizontal rule.
  return { frontmatter: null, body: content };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
