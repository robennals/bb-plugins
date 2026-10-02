// Where a progress doc goes when the agent is asked to start one.

/** The folder the agent is asked to keep its progress docs in. */
export const DOC_DIRECTORY = "~/agent-progress";

const MAX_SLUG_LENGTH = 60;

/**
 * `<title-slug>-<threadId>.md`. The title makes the file recognisable in a
 * listing; the thread id keeps two threads with the same title apart.
 */
export function docFileName(title: string | null, threadId: string): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "thread" : slug}-${threadId}.md`;
}
