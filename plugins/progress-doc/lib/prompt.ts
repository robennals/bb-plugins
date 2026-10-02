// The message sent to the agent when you ask it to keep a progress doc.

export const PATH_PLACEHOLDER = "{{path}}";

export const DEFAULT_PROMPT = `Please keep a progress doc for this thread at ${PATH_PLACEHOLDER} (create the folder if it doesn't exist). I read it in a side panel to follow your work, so update it as you go: whenever you finish a step, open or update a PR, hit something hard, or make a decision I'd want to review.

Use these sections, in this order:

## Active PRs
Links to the pull requests this work has open, each with a one-line status.

## Things that are hard
What is slowing you down or going badly, so I can help fix it: missing access, flaky tooling, unclear requirements, anything you keep working around.

## Progress
What's done so far, and what remains.

## Spec links
Links to the specs, plans and issues guiding this work.

## Open Questions
Questions you'd like my input on. Say what you're assuming in the meantime.

## Notable Decisions
Notable decisions you've made on my behalf since my last review: what you chose, the alternative you rejected, and why.

## Archive
Open Questions I've answered and Notable Decisions I've reviewed. When I tell you I've reviewed them, move them here.

Keep moving forward on the work rather than blocking on me for advice: record questions and decisions in the doc and carry on with your best judgment. Only stop and wait for me when you hit a challenge or open question big enough that you really need my guidance to go further.`;

export function fillPrompt(template: string, docPath: string): string {
  return template.split(PATH_PLACEHOLDER).join(docPath);
}
