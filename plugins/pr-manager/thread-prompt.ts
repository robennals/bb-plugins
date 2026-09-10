export interface ThreadPromptInput { url: string; headRefName: string; baseRefName: string; instructions: string }
// BB provisions the thread's worktree from the PR head ref, so the branch is already
// checked out and the prefix only has to say where the agent landed. The user's own
// instructions are the last thing it reads, and are passed through untouched.
export function buildThreadPrompt({ url, headRefName, baseRefName, instructions }: ThreadPromptInput): string {
  return [
    `This worktree is checked out from the head of pull request ${url} (${headRefName}, targeting ${baseRefName}). No checkout is needed.`,
    instructions,
  ].join("\n\n");
}
