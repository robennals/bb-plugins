// How a place in the code is named, in one place.
//
// Its own module rather than part of `review-core.ts` because the frontend
// needs it too, and `review-core.ts` imports zod — which tripled the app
// bundle (174 KB → 502 KB) when app.tsx imported from it. Nothing here has
// any dependency at all.

/** "src/a.ts:10-12", or "src/a.ts" when the range is unknown. */
export function formatLocation(target: {
  file: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (target.startLine === null) return target.file;
  const range =
    target.endLine !== null && target.endLine !== target.startLine
      ? `${target.startLine}-${target.endLine}`
      : `${target.startLine}`;
  return `${target.file}:${range}`;
}
