/** The message to show a user for a thrown value of unknown shape. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
