// bb-plugin-code-review — backend.
//
// The loop this plugin implements:
//
//   1. List a repo's open PRs, filtered by who was asked to review (me, one of
//      my teams, any of my teams, everyone).
//   2. Open a PR, start a review: a BB thread runs the review skills you
//      configured and writes structured findings to a JSON file, then submits
//      that file with `bb code-review submit`.
//   3. Each finding lands in the panel as a ready-to-post comment you can edit,
//      post to GitHub, or ask the review thread about, with the code it points
//      at shown beside it.
//
// gh is the only GitHub transport, so whatever `gh auth` can see, this can.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  awaitsReviewFrom,
  ANSWER_SCHEMA_TEXT,
  buildFindingQuestion,
  buildPostCommentArgs,
  buildReviewPrompt,
  CLI_OUTPUT_BUDGET,
  FINDINGS_SCHEMA_TEXT,
  findingGist,
  findingLocations,
  formatContext,
  formatFileList,
  buildFileContextBlock,
  githubBlobUrl,
  githubPrFileUrl,
  githubPrUrl,
  citationCandidates,
  describeGitHubError,
  diffHunkRanges,
  findBadPaths,
  formatBadPaths,
  needsPathResolution,
  resolveCitedPath,
  resolvePostAnchor,
  filterPullRequests,
  isRepoName,
  parseGithubRemote,
  parsePullRequests,
  parseReport,
  parsePrSnapshot,
  parseAnswer,
  parseReportEdit,
  REPORT_EDIT_SCHEMA_TEXT,
  parseRepoList,
  parseReviewComments,
  parseSkillList,
  PR_JSON_FIELDS,
  PR_LIST_LIMIT,
  PR_VIEW_JSON_FIELDS,
  severityRank,
  reviewTabFor,
  SEVERITIES,
  patchLineChanges,
  splitUnifiedDiff,
  type Finding,
  type FilePatch,
  type FilterContext,
  type FindingLocation,
  type PostAnchor,
  type PrSnapshot,
  type PullRequest,
} from "./review-core";

const CHANGED = "code-review-changed";
/** Panel position only, so choosing a side pane does not refetch everything. */
const PANEL_STATE_CHANGED = "code-review-panel-state-changed";
const GH_HINT =
  "Install the GitHub CLI and run `gh auth login`, then reload the plugin.";
const GH_HOST = "github.com";
const GH_NO_CREDENTIALS = /no oauth token|not logged in/i;
const VIEWER_CACHE_MS = 60 * 60_000;
const TEAM_CACHE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

const reviewRequestSchema = z.object({
  login: z.string().nullable(),
  teamSlug: z.string().nullable(),
});

const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  labels: z.array(z.string()),
  reviewRequests: z.array(reviewRequestSchema),
  /** Status of this plugin's review of the PR, if one has been started. */
  reviewStatus: z.enum(["none", "queued", "running", "reported", "failed"]),
  openFindings: z.number(),
  postedFindings: z.number(),
  /** The review's thread, when it has one — so the panel can link to an archived one. */
  reviewThreadId: z.string().nullable(),
  /**
   * Unarchiving is broken in BB, so an archived thread cannot be worked in. The
   * panel offers a new review instead, and keeps the old thread as a read-only link.
   */
  reviewThreadArchived: z.boolean(),
});
export type PullRequestDto = z.infer<typeof pullRequestSchema>;

/** The parts of a finding the review thread can revise after submitting it. */
const revisedFieldSchema = z.enum([
  "title",
  "summary",
  "suggestedFix",
  "suggestedComment",
  "severity",
  "category",
  "location",
  "references",
]);
type RevisedField = z.infer<typeof revisedFieldSchema>;
const REVISED_FIELDS: readonly RevisedField[] = revisedFieldSchema.options;

/** A question the reviewer asked about a finding, and the review thread's answer. */
const questionSchema = z.object({
  id: z.string(),
  question: z.string(),
  /**
   * "pending" until the thread records an answer. "unanswered" means its turn
   * ended without one; a late answer still lands.
   */
  status: z.enum(["pending", "answered", "unanswered"]),
  /** Markdown. For "unanswered", the thread's last reply when it can only be this question's. */
  answer: z.string().nullable(),
  /** Which of the finding's fields the answer rewrote. */
  updatedFields: z.array(revisedFieldSchema),
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
});
export type QuestionDto = z.infer<typeof questionSchema>;

const findingSchemaDto = z.object({
  id: z.string(),
  reviewId: z.string(),
  file: z.string(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  severity: z.enum(SEVERITIES),
  category: z.string(),
  title: z.string(),
  /** The gist for the list view; derived when the agent wrote none. */
  gist: z.string(),
  summary: z.string(),
  /** How the agent would fix it; empty when it offered none. */
  suggestedFix: z.string(),
  suggestedComment: z.string(),
  /** The user's edit, or null when the suggested comment is unedited. */
  draftComment: z.string().nullable(),
  state: z.enum(["open", "posted", "dismissed"]),
  commentUrl: z.string().nullable(),
  postedAt: z.string().nullable(),
  /** "pending-review" means it is a draft in the user's unsubmitted review. */
  postedAs: z.enum(["comment", "pending-review"]),
  /**
   * How this comment can be attached, given the diff.
   */
  postAnchor: z.object({
    /** "line" anchors to the code; "file" attaches to the file in the diff;
     *  "pull-request" is a plain comment, for a file the PR does not touch. */
    kind: z.enum(["line", "file", "pull-request"]),
    line: z.number().nullable(),
    startLine: z.number().nullable(),
    /** The finding's range had to be narrowed to fit the diff. */
    adjusted: z.boolean(),
  }),
  references: z.array(
    z.object({
      file: z.string(),
      startLine: z.number().nullable(),
      endLine: z.number().nullable(),
      note: z.string(),
    }),
  ),
  /** Questions asked about this finding, oldest first. */
  questions: z.array(questionSchema),
  /**
   * A comment the review thread revised but could not apply, because the
   * reviewer had edited theirs or already posted it. Theirs to take or leave.
   */
  proposedComment: z.string().nullable(),
  /** The review thread's last change to this finding after submitting it. */
  revision: z
    .object({ at: z.string(), note: z.string(), fields: z.array(revisedFieldSchema) })
    .nullable(),
  /** Why the review thread withdrew it, when it was the one that dismissed it. */
  removedReason: z.string().nullable(),
});
export type FindingDto = z.infer<typeof findingSchemaDto>;

const reviewSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  status: z.enum(["queued", "running", "reported", "failed"]),
  summary: z.string(),
  error: z.string().nullable(),
  threadId: z.string().nullable(),
  findingsPath: z.string().nullable(),
  skills: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewDto = z.infer<typeof reviewSchema>;

const prCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** Set for inline review comments. */
  file: z.string().nullable(),
  line: z.number().nullable(),
});

const prSnapshotSchema = z.object({
  title: z.string(),
  body: z.string(),
  author: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headSha: z.string(),
  comments: z.array(prCommentSchema),
  reviewComments: z.array(prCommentSchema),
  files: z.array(
    z.object({ path: z.string(), additions: z.number(), deletions: z.number() }),
  ),
});

const statusSchema = z.object({
  state: z.enum(["ready", "needs_configuration", "unavailable", "checking"]),
  detail: z.string().nullable(),
  viewer: z.string().nullable(),
  repos: z.array(z.string()),
  myTeams: z.array(z.string()),
  skills: z.array(z.string()),
});

const filterSchema = z.union([
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("mine") }),
  z.object({ kind: z.literal("my-teams") }),
  z.object({ kind: z.literal("team"), teamSlug: z.string() }),
  z.object({ kind: z.literal("authored") }),
]);

const codeLocationSchema = z.object({
  file: z.string(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  note: z.string(),
  isPrimary: z.boolean(),
  /** The PR's diff for this file, anchored at the cited line. */
  diffUrl: z.string(),
  /** The file at the reviewed commit, with the lines highlighted. */
  blobUrl: z.string(),
  /**
   * Markdown quoting this location with a link, for a comment that cannot be
   * anchored to a line. Empty when the code could not be read.
   */
  contextBlock: z.string(),
  /** First line number in `lines`; 1-based. */
  firstLine: z.number(),
  lines: z.array(z.string()),
  /**
   * Whether this file is in the pull request at all. False means the code
   * below is untouched context, not part of the change under review.
   */
  inDiff: z.boolean(),
  /** Which of the returned lines the pull request added. */
  addedLines: z.array(z.number()),
  /** Lines the pull request deleted, keyed to the line they followed. */
  removals: z.array(z.object({ afterLine: z.number(), lines: z.array(z.string()) })),
  /** Lines exist above/below what was returned. */
  hasMoreAbove: z.boolean(),
  hasMoreBelow: z.boolean(),
  /** Why the code could not be shown, if it could not. */
  error: z.string().nullable(),
});

/** Which view of the side pane the reviewer last had open. */
const sidePaneSchema = z.enum(["github", "diff", "files", "discussion"]);

const panelStateSchema = z.object({
  repo: z.string().nullable(),
  filter: filterSchema.nullable(),
  sidePane: sidePaneSchema.nullable(),
  /** The file the diff view should open on, when one was asked for. */
  diffFile: z.string().nullable(),
  /** That file's anchored place in GitHub's diff, for the in-app browser. */
  diffUrl: z.string().nullable(),
});

/**
 * The provider, model and reasoning level a review thread runs with: the value
 * BB's own model picker emits, and what `threads.spawn` takes.
 */
const reviewModelSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  /** Present only when the provider has service tiers. */
  serviceTier: z.enum(["default", "fast"]).optional(),
});
export type ReviewModelDto = z.infer<typeof reviewModelSchema>;

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  listPullRequests: {
    input: z.object({
      repo: z.string(),
      filter: filterSchema,
      refresh: z.boolean().optional(),
    }),
    output: z.object({
      /** When this list was last pulled from GitHub. */
      fetchedAt: z.string(),
      pullRequests: z.array(pullRequestSchema),
    }),
  },
  getPullRequest: {
    input: z.object({ repo: z.string(), number: z.number().int().positive() }),
    output: z.object({
      pullRequest: pullRequestSchema.nullable(),
      review: reviewSchema.nullable(),
      findings: z.array(findingSchemaDto),
      /** You already have an unsubmitted review open on this PR. */
      hasPendingReview: z.boolean(),
    }),
  },
  startReview: {
    input: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
      /** Overrides the configured skill list for this run only. */
      skills: z.array(z.string()).optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  setFindingComment: {
    input: z.object({ findingId: z.string(), comment: z.string() }),
    output: z.object({ finding: findingSchemaDto }),
  },
  setFindingState: {
    input: z.object({
      findingId: z.string(),
      state: z.enum(["open", "dismissed"]),
    }),
    output: z.object({ finding: findingSchemaDto }),
  },
  postFinding: {
    input: z.object({
      findingId: z.string(),
      /**
       * "inline" publishes a single anchored comment; "review" puts it in the
       * pending review, starting one if there is none, so comments made here
       * and in the GitHub UI batch together; "issue" is a plain PR comment.
       */
      mode: z.enum(["inline", "issue", "review"]),
    }),
    output: z.object({ finding: findingSchemaDto }),
  },
  /**
   * Open a review that has already run: check its thread is alive, make sure
   * that thread carries this review's tab, and hand it back for the panel to
   * navigate to. Never starts a review — that is what startReview is for.
   */
  openReview: {
    input: z.object({ repo: z.string(), number: z.number().int().positive() }),
    output: z.object({ threadId: z.string(), review: reviewSchema }),
  },
  /** Which review a thread belongs to, for a tab opened from the launcher. */
  getReviewForThread: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ repo: z.string(), number: z.number() }).nullable(),
  },
  askAboutFinding: {
    input: z.object({ findingId: z.string(), question: z.string().min(1) }),
    output: z.object({ threadId: z.string(), questionId: z.string() }),
  },
  /** Take the review thread's revised comment in place of the reviewer's, or turn it down. */
  resolveProposedComment: {
    input: z.object({ findingId: z.string(), use: z.boolean() }),
    output: z.object({ finding: findingSchemaDto }),
  },
  getFindingCode: {
    input: z.object({
      findingId: z.string(),
      /** Lines of surrounding context above and below each cited range. */
      context: z.number().int().min(0).max(200).optional(),
    }),
    output: z.object({
      prUrl: z.string(),
      headSha: z.string(),
      /** False when the code was fetched after the review, so lines may have moved. */
      isReviewedCommit: z.boolean(),
      locations: z.array(codeLocationSchema),
    }),
  },
  /**
   * The model the next review will run with: the one chosen in the panel, or
   * until one is chosen, the default of the BB project `repo` belongs to. Null
   * when neither is known.
   */
  getReviewModel: {
    input: z.object({ repo: z.string().nullable() }),
    output: reviewModelSchema.nullable(),
  },
  setReviewModel: { input: reviewModelSchema, output: reviewModelSchema },
  getPanelState: { input: z.null(), output: panelStateSchema },
  /**
   * A patch, not a replacement: the PR list owns the repo and filter while the
   * side pane owns its own selection, and neither should flatten the other's
   * field by writing a whole row. An absent key keeps what is stored; an
   * explicit null clears it.
   */
  setPanelState: {
    input: z.object({
      repo: z.string().nullable().optional(),
      filter: filterSchema.nullable().optional(),
      sidePane: sidePaneSchema.nullable().optional(),
      diffFile: z.string().nullable().optional(),
      diffUrl: z.string().nullable().optional(),
    }),
    output: panelStateSchema,
  },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

function isNeedsConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
  /** Written to the process's stdin, for `gh api --input -`. */
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} ${args.slice(0, 3).join(" ")} failed: ${
                describeGitHubError(stdout, stderr) || error.message
              }`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function reviewIdFor(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** "path:line" or "path:start-end", for messages. */
function locationOf(finding: { file: string; startLine: number | null; endLine: number | null }): string {
  if (finding.startLine === null) return finding.file;
  const end = finding.endLine;
  return end !== null && end !== finding.startLine
    ? `${finding.file}:${finding.startLine}-${end}`
    : `${finding.file}:${finding.startLine}`;
}

function requireRepo(repo: string): string {
  if (!isRepoName(repo)) throw new Error(`Invalid repository "${repo}"; expected owner/repo.`);
  return repo;
}

/** The comment text that would actually be posted: the edit, else the suggestion. */
function effectiveComment(finding: FindingDto): string {
  return finding.draftComment ?? finding.suggestedComment;
}

const REVIEW_STATUSES = ["queued", "running", "reported", "failed"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

function isSeverity(value: string): value is FindingDto["severity"] {
  return (SEVERITIES as readonly string[]).includes(value);
}

/** Read one string field out of a `gh --json` / `gh api` response. */
function ghField(raw: string, field: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return "";
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

interface ReviewRow {
  id: string;
  repo: string;
  number: number;
  title: string;
  status: string;
  summary: string;
  error: string | null;
  thread_id: string | null;
  /** 1 when GitHub was asking the viewer for this review when it started. */
  awaited_me_at_start: number;
  /** Set once the thread has been archived, so it is archived only once. */
  thread_archived_at: string | null;
  findings_path: string | null;
  skills: string;
  created_at: string;
  updated_at: string;
}

interface FindingRow {
  id: string;
  review_id: string;
  ord: number;
  file: string;
  start_line: number | null;
  end_line: number | null;
  side: string;
  severity: string;
  category: string;
  title: string;
  summary: string;
  suggested_fix: string;
  suggested_comment: string;
  draft_comment: string | null;
  state: string;
  comment_url: string | null;
  posted_at: string | null;
  posted_as: string;
  references_json: string;
  proposed_comment: string | null;
  revised_at: string | null;
  revision_note: string | null;
  revised_fields: string | null;
  removed_reason: string | null;
}

interface QuestionRow {
  id: string;
  finding_id: string;
  review_id: string;
  question: string;
  status: string;
  answer: string | null;
  updated_fields: string;
  asked_at: string;
  answered_at: string | null;
}

function toQuestionDto(row: QuestionRow): QuestionDto {
  return {
    id: row.id,
    question: row.question,
    status:
      row.status === "answered" ? "answered" : row.status === "unanswered" ? "unanswered" : "pending",
    answer: row.answer,
    updatedFields: parseJsonArray<string>(row.updated_fields).filter(
      (field): field is RevisedField => (REVISED_FIELDS as readonly string[]).includes(field),
    ),
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  };
}

function toReviewDto(row: ReviewRow): ReviewDto {
  return {
    id: row.id,
    repo: row.repo,
    number: row.number,
    title: row.title,
    // A row whose status the current build no longer knows is shown as failed
    // rather than crashing the panel's output validation.
    status: isReviewStatus(row.status) ? row.status : "failed",
    summary: row.summary,
    error: row.error,
    threadId: row.thread_id,
    findingsPath: row.findings_path,
    skills: JSON.parse(row.skills) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFindingDto(row: FindingRow, questions: QuestionDto[] = []): FindingDto {
  return {
    id: row.id,
    reviewId: row.review_id,
    file: row.file,
    startLine: row.start_line,
    endLine: row.end_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    severity: isSeverity(row.severity) ? row.severity : "medium",
    category: row.category,
    title: row.title,
    summary: row.summary ?? "",
    gist: findingGist({ summary: row.summary ?? "", suggestedComment: row.suggested_comment }),
    suggestedFix: row.suggested_fix ?? "",
    suggestedComment: row.suggested_comment,
    draftComment: row.draft_comment,
    state:
      row.state === "posted" ? "posted" : row.state === "dismissed" ? "dismissed" : "open",
    commentUrl: row.comment_url,
    postedAt: row.posted_at,
    postedAs: row.posted_as === "pending-review" ? "pending-review" : "comment",
    references: parseJsonArray(row.references_json),
    // Replaced by listFindings, which has the diff to hand.
    postAnchor: { kind: "file" as const, line: null, startLine: null, adjusted: false },
    questions,
    proposedComment: row.proposed_comment ?? null,
    revision:
      row.revised_at == null
        ? null
        : {
            at: row.revised_at,
            note: row.revision_note ?? "",
            fields: parseJsonArray<string>(row.revised_fields).filter(
              (field): field is RevisedField => (REVISED_FIELDS as readonly string[]).includes(field),
            ),
          },
    removedReason: row.removed_reason ?? null,
  };
}

/** Stored JSON that predates a column, or was written by an older build. */
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * How the plugin shells out. The real host never passes this — it exists so
 * tests can drive gh and git without a GitHub account or a checkout.
 */
export interface PluginDependencies {
  runCommand?: (
    file: string,
    args: string[],
    timeoutMs?: number,
    stdin?: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * How long to wait after a review thread goes idle before deciding its
   * questions went unanswered, so a queued question has time to start.
   */
  idleSettleMs?: number;
}

export default async function plugin(bb: BbPluginApi, deps: PluginDependencies = {}) {
  const runCommand = deps.runCommand ?? run;
  const idleSettleMs = deps.idleSettleMs ?? 3_000;
  const settings = bb.settings.define({
    repos: {
      type: "string",
      label: "Repositories",
      description:
        'One "owner/repo" per line, in addition to repos discovered from your BB projects\' git remotes.',
      experimental_multiline: true,
      default: "",
    },
    reviewSkills: {
      type: "string",
      label: "Review skills",
      description:
        "Skill names the review agent should run, one per line (for example `code-review`). Leave empty for a generic review.",
      experimental_multiline: true,
      default: "code-review",
    },
    reviewInstructions: {
      type: "string",
      label: "Extra review instructions",
      description:
        "Appended to every review prompt — house rules, things to always check, things to never comment on.",
      experimental_multiline: true,
      default: "",
    },
    findingsDir: {
      type: "string",
      label: "Findings directory",
      description:
        "Where the review agent writes its findings JSON, relative to the checkout.",
      default: ".bb/code-review",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where review threads spawn for repos that are not attached to a BB project.",
    },
    teams: {
      type: "string",
      label: "Teams",
      description:
        'One "org/team" per line. Leave empty to use the teams `gh api /user/teams` reports.',
      experimental_multiline: true,
      default: "",
    },
  });

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  const db: Database.Database = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS reviews (
       id TEXT PRIMARY KEY,
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'queued',
       summary TEXT NOT NULL DEFAULT '',
       error TEXT,
       thread_id TEXT,
       findings_path TEXT,
       skills TEXT NOT NULL DEFAULT '[]',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    // This statement has already been applied to existing databases, and
    // `bb.storage.migrate` matches statements by index by hashing their text --
    // so much as reformatting one that has run makes the plugin refuse to load.
    // Columns this plugin no longer uses are therefore still created here and
    // dropped by an appended migration at the end of this list.
    `CREATE TABLE IF NOT EXISTS findings (
       id TEXT PRIMARY KEY,
       review_id TEXT NOT NULL,
       ord INTEGER NOT NULL DEFAULT 0,
       file TEXT NOT NULL DEFAULT '',
       start_line INTEGER,
       end_line INTEGER,
       side TEXT NOT NULL DEFAULT 'RIGHT',
       severity TEXT NOT NULL DEFAULT 'medium',
       category TEXT NOT NULL DEFAULT '',
       title TEXT NOT NULL DEFAULT '',
       background TEXT NOT NULL DEFAULT '',
       problem TEXT NOT NULL DEFAULT '',
       suggested_fix TEXT NOT NULL DEFAULT '',
       suggested_comment TEXT NOT NULL DEFAULT '',
       draft_comment TEXT,
       state TEXT NOT NULL DEFAULT 'open',
       comment_url TEXT,
       posted_at TEXT,
       discussion_thread_id TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS findings_by_review ON findings (review_id)`,
    `CREATE INDEX IF NOT EXISTS reviews_by_thread ON reviews (thread_id)`,
    // The PR as fetched when the review started. Held so the review agent
    // never needs gh or network access of its own, and so its findings' line
    // numbers refer to one stable diff.
    `CREATE TABLE IF NOT EXISTS review_context (
       review_id TEXT PRIMARY KEY,
       snapshot TEXT NOT NULL,
       diff TEXT NOT NULL DEFAULT '',
       fetched_at TEXT NOT NULL
     )`,
    // File bodies at the reviewed commit, so the panel can show the code a
    // finding points at without refetching on every render.
    `CREATE TABLE IF NOT EXISTS review_files (
       review_id TEXT NOT NULL,
       path TEXT NOT NULL,
       content TEXT,
       error TEXT,
       fetched_at TEXT NOT NULL,
       PRIMARY KEY (review_id, path)
     )`,
    // Panel state, so re-opening the tab does not mean re-choosing the repo.
    `CREATE TABLE IF NOT EXISTS panel_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       repo TEXT,
       filter TEXT,
       updated_at TEXT NOT NULL
     )`,
    `ALTER TABLE findings ADD COLUMN summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE findings ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'`,
    // The PR list survives reloads and restarts, and is only re-fetched when
    // the user asks for it.
    `CREATE TABLE IF NOT EXISTS pr_cache (
       repo TEXT PRIMARY KEY,
       prs TEXT NOT NULL,
       fetched_at TEXT NOT NULL
     )`,
    `ALTER TABLE review_context ADD COLUMN at_review_start INTEGER NOT NULL DEFAULT 1`,
    // The repo's file list at the reviewed commit, so a citation to code the
    // PR does not touch can still be resolved to a real path.
    `CREATE TABLE IF NOT EXISTS repo_tree (
       review_id TEXT PRIMARY KEY,
       paths TEXT NOT NULL,
       fetched_at TEXT NOT NULL
     )`,
    // A finding is a comment now, and questions go to the review's own thread,
    // so nothing reads these four. None is indexed or part of a key, so SQLite
    // can drop them outright.
    `ALTER TABLE findings DROP COLUMN background`,
    `ALTER TABLE findings DROP COLUMN problem`,
    `ALTER TABLE findings DROP COLUMN suggested_fix`,
    `ALTER TABLE findings DROP COLUMN discussion_thread_id`,
    // The model reviews run with, chosen in the panel.
    `CREATE TABLE IF NOT EXISTS review_model (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       model TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    // Questions about a finding and the review thread's answers, so they show
    // on the issue instead of only in the chat.
    `CREATE TABLE IF NOT EXISTS finding_questions (
       id TEXT PRIMARY KEY,
       finding_id TEXT NOT NULL,
       review_id TEXT NOT NULL,
       question TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       answer TEXT,
       updated_fields TEXT NOT NULL DEFAULT '[]',
       asked_at TEXT NOT NULL,
       answered_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS finding_questions_by_finding ON finding_questions (finding_id)`,
  ]);

  /**
   * Add a column if it is not already there.
   *
   * `bb.storage.migrate` applies statements by index, so a statement inserted
   * above an already-applied one is silently skipped and shows up much later
   * as "no such column" — which is exactly what happened to `posted_as`.
   * Checking the table instead is immune to that, and to the same mistake
   * being made again.
   */
  function ensureColumn(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    bb.log.info(`added the ${table}.${column} column`);
  }

  ensureColumn("findings", "posted_as", `TEXT NOT NULL DEFAULT 'comment'`);
  // Dropped with background and problem, then brought back on its own: the
  // write-up around it was noise, but how the agent would fix a finding is
  // often the useful part. The DROP above has already run on real databases
  // and `migrate` hashes statements by index, so editing it would refuse the
  // load — hence ensureColumn.
  ensureColumn("findings", "suggested_fix", `TEXT NOT NULL DEFAULT ''`);
  ensureColumn("reviews", "awaited_me_at_start", `INTEGER NOT NULL DEFAULT 0`);
  ensureColumn("reviews", "thread_archived_at", `TEXT`);
  ensureColumn("panel_state", "side_pane", `TEXT`);
  ensureColumn("panel_state", "diff_file", `TEXT`);
  ensureColumn("panel_state", "diff_url", `TEXT`);
  // The review thread keeps editing the report after it submits it.
  ensureColumn("findings", "proposed_comment", `TEXT`);
  ensureColumn("findings", "revised_at", `TEXT`);
  ensureColumn("findings", "revision_note", `TEXT`);
  ensureColumn("findings", "revised_fields", `TEXT`);
  ensureColumn("findings", "removed_reason", `TEXT`);
  // Which commit a cached file list is of. Rows from before this are of an
  // unknown one, so they are never reused.
  ensureColumn("repo_tree", "sha", `TEXT`);

  function getReview(reviewId: string): ReviewRow | null {
    return (db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(reviewId) as
      | ReviewRow
      | undefined) ?? null;
  }

  function getReviewByThread(threadId: string): ReviewRow | null {
    return (db.prepare(`SELECT * FROM reviews WHERE thread_id = ?`).get(threadId) as
      | ReviewRow
      | undefined) ?? null;
  }

  function listFindings(reviewId: string): FindingDto[] {
    const rows = db
      .prepare(`SELECT * FROM findings WHERE review_id = ? ORDER BY ord ASC`)
      .all(reviewId) as FindingRow[];
    // Parsing the diff once per list keeps this off the per-finding path.
    const stored = getContext(reviewId);
    const patches = stored === null ? [] : splitUnifiedDiff(stored.diff);
    const questions = new Map<string, QuestionDto[]>();
    for (const row of db
      .prepare(`SELECT * FROM finding_questions WHERE review_id = ? ORDER BY asked_at ASC, rowid ASC`)
      .all(reviewId) as QuestionRow[]) {
      const list = questions.get(row.finding_id) ?? [];
      list.push(toQuestionDto(row));
      questions.set(row.finding_id, list);
    }
    return rows.map((row) => {
      const finding = toFindingDto(row, questions.get(row.id) ?? []);
      const patch = patches.find((file) => file.path === finding.file);
      return {
        ...finding,
        postAnchor: resolvePostAnchor(
          finding,
          patch === undefined ? [] : diffHunkRanges(patch.patch, finding.side),
          // With no stored diff we cannot tell, so assume the file is in it and
          // let GitHub have the final say.
          stored === null || patch !== undefined,
        ),
      };
    });
  }

  function getFinding(findingId: string): FindingRow | null {
    return (db.prepare(`SELECT * FROM findings WHERE id = ?`).get(findingId) as
      | FindingRow
      | undefined) ?? null;
  }

  function requireFinding(findingId: string): FindingRow {
    const row = getFinding(findingId);
    if (row === null) throw new Error(`No finding with id ${findingId}.`);
    return row;
  }

  /** A finding with its questions, for an RPC that hands one back. */
  function findingDto(row: FindingRow): FindingDto {
    const questions = db
      .prepare(`SELECT * FROM finding_questions WHERE finding_id = ? ORDER BY asked_at ASC, rowid ASC`)
      .all(row.id) as QuestionRow[];
    return toFindingDto(row, questions.map(toQuestionDto));
  }

  /** Questions about findings a re-run replaced go with them. */
  function dropOrphanedQuestions(reviewId: string): void {
    db.prepare(
      `DELETE FROM finding_questions
       WHERE review_id = ? AND finding_id NOT IN (SELECT id FROM findings)`,
    ).run(reviewId);
  }

  function getQuestion(questionId: string): QuestionRow | null {
    return (db.prepare(`SELECT * FROM finding_questions WHERE id = ?`).get(questionId) as
      | QuestionRow
      | undefined) ?? null;
  }

  function touchReview(reviewId: string, patch: Partial<ReviewRow>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    db.prepare(
      `UPDATE reviews SET ${fields.map((f) => `${f} = @${f}`).join(", ")}, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, id: reviewId, updated_at: nowIso() });
  }

  function announce(): void {
    bb.realtime.publish(CHANGED, { at: nowIso() });
  }

  function announcePanelState(): void {
    bb.realtime.publish(PANEL_STATE_CHANGED, { at: nowIso() });
  }

  // -------------------------------------------------------------------------
  // gh plumbing. The server may run with a trimmed PATH, so probe the usual
  // install locations once and remember the winner.
  // -------------------------------------------------------------------------
  let ghPath: string | null = null;
  type GhState = "ready" | "needs_configuration" | "unavailable" | "checking";
  let ghState: GhState = "checking";
  let ghDetail: string | null = "checking gh…";

  async function resolveGh(): Promise<string> {
    if (ghPath !== null) return ghPath;
    for (const candidate of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
      try {
        await runCommand(candidate, ["--version"], 5_000);
        ghPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`GitHub CLI not found. ${GH_HINT}`);
  }

  async function gh(args: string[], timeoutMs?: number, stdin?: string): Promise<string> {
    const { stdout } = await runCommand(await resolveGh(), args, timeoutMs, stdin);
    return stdout;
  }

  // `gh auth status` hits the network, so its failure is not by itself a
  // configuration problem. Only two outcomes are: gh missing, and gh present
  // with no credentials at all — which `gh auth token` answers offline.
  // Everything else stays retryable rather than latching the plugin.
  async function probeAuth(): Promise<void> {
    try {
      await gh(["auth", "status", "--hostname", GH_HOST, "--active"], 10_000);
      ghState = "ready";
      ghDetail = null;
      return;
    } catch (error) {
      ghDetail = error instanceof Error ? error.message : String(error);
      if (isNeedsConfigurationError(error)) {
        ghState = "needs_configuration";
        throw error;
      }
    }
    let hasCredentials = true;
    try {
      await gh(["auth", "token", "--hostname", GH_HOST], 5_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hasCredentials = !GH_NO_CREDENTIALS.test(message);
    }
    if (!hasCredentials) {
      ghState = "needs_configuration";
      throw needsConfiguration(`GitHub CLI is not authenticated. ${GH_HINT}`);
    }
    ghState = "unavailable";
    throw new Error(`gh auth status failed (this is usually transient): ${ghDetail}`);
  }

  // Concurrent callers share one in-flight probe instead of spawning duplicate
  // gh processes.
  let authProbe: Promise<void> | null = null;
  function checkAuth(): Promise<void> {
    if (authProbe === null) {
      authProbe = probeAuth().finally(() => {
        authProbe = null;
      });
    }
    return authProbe;
  }

  // -------------------------------------------------------------------------
  // Viewer, teams, repos
  // -------------------------------------------------------------------------
  let viewerCache: { login: string; at: number } | null = null;

  async function getViewer(): Promise<string> {
    if (viewerCache !== null && Date.now() - viewerCache.at < VIEWER_CACHE_MS) {
      return viewerCache.login;
    }
    const login = ghField(await gh(["api", "user"], 15_000), "login");
    if (login === "") throw new Error("could not resolve the gh viewer login");
    viewerCache = { login, at: Date.now() };
    return login;
  }

  let teamCache: { teams: string[]; at: number } | null = null;

  async function getMyTeams(): Promise<string[]> {
    const configured = parseRepoList((await settings.get()).teams ?? "");
    if (configured.length > 0) return configured;
    if (teamCache !== null && Date.now() - teamCache.at < TEAM_CACHE_MS) {
      return teamCache.teams;
    }
    let teams: string[] = [];
    try {
      // Needs the `read:org` scope; without it gh 403s and the team filters
      // simply stay empty rather than breaking the panel.
      const raw = await gh(
        ["api", "--paginate", "/user/teams", "--jq", ".[] | .organization.login + \"/\" + .slug"],
        20_000,
      );
      teams = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => isRepoName(line));
    } catch (error) {
      bb.log.warn(`could not list teams: ${String(error)}`);
    }
    teamCache = { teams, at: Date.now() };
    return teams;
  }

  interface RepoInfo {
    repo: string;
    projectId: string | null;
  }

  let repoCache: { repos: RepoInfo[]; at: number } | null = null;

  async function discoverRepos(force = false): Promise<RepoInfo[]> {
    if (!force && repoCache !== null && Date.now() - repoCache.at < 60_000) {
      return repoCache.repos;
    }
    const byRepo = new Map<string, RepoInfo>();
    try {
      const projects = await bb.sdk.projects.list();
      for (const project of projects) {
        for (const source of project.sources ?? []) {
          if (source.type !== "local_path") continue;
          try {
            const { stdout } = await runCommand(
              "git",
              ["-C", source.path, "remote", "get-url", "origin"],
              5_000,
            );
            const repo = parseGithubRemote(stdout);
            if (repo !== null && !byRepo.has(repo)) {
              byRepo.set(repo, { repo, projectId: project.id });
            }
          } catch {
            // not a git checkout, or no origin — skip it
          }
        }
      }
    } catch (error) {
      bb.log.warn(`project discovery failed: ${String(error)}`);
    }
    for (const repo of parseRepoList((await settings.get()).repos ?? "")) {
      if (!byRepo.has(repo)) byRepo.set(repo, { repo, projectId: null });
    }
    const repos = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
    repoCache = { repos, at: Date.now() };
    return repos;
  }

  async function resolveProjectId(repo: string): Promise<string> {
    const known = (await discoverRepos()).find((info) => info.repo === repo);
    if (known?.projectId != null) return known.projectId;
    const configured = (await settings.get()).defaultProject;
    if (typeof configured === "string" && configured !== "") return configured;
    throw new Error(
      `No BB project is attached to ${repo}. Create a project whose checkout has that ` +
        "origin remote, or set the plugin's default project setting.",
    );
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------
  /**
   * The stored PR list for a repo. Deliberately has no expiry: the panel shows
   * what you last pulled until you press Refresh, so re-opening the tab is
   * instant and never silently re-runs gh.
   */
  function storedPullRequests(repo: string): { prs: PullRequest[]; fetchedAt: string } | null {
    const row = db.prepare(`SELECT prs, fetched_at FROM pr_cache WHERE repo = ?`).get(repo) as
      | { prs: string; fetched_at: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return { prs: JSON.parse(row.prs) as PullRequest[], fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  async function fetchPullRequests(
    repo: string,
    force = false,
  ): Promise<{ prs: PullRequest[]; fetchedAt: string }> {
    if (!force) {
      const stored = storedPullRequests(repo);
      if (stored !== null) return stored;
    }
    const raw = await gh(
      ["pr", "list", "-R", repo, "--state", "open",
       "--limit", `${PR_LIST_LIMIT}`, "--json", PR_JSON_FIELDS],
      45_000,
    );
    const prs = parsePullRequests(raw, repo);
    const fetchedAt = nowIso();
    db.prepare(
      `INSERT INTO pr_cache (repo, prs, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET prs = excluded.prs, fetched_at = excluded.fetched_at`,
    ).run(repo, JSON.stringify(prs), fetchedAt);
    return { prs, fetchedAt };
  }

  async function filterContext(): Promise<FilterContext> {
    return { viewer: await getViewer(), myTeams: await getMyTeams() };
  }

  /** Whether GitHub is currently asking the viewer to review this PR. */
  async function awaitsReview(repo: string, number: number): Promise<boolean> {
    const { prs } = await fetchPullRequests(repo);
    const pr = prs.find((candidate) => candidate.number === number);
    return pr !== undefined && awaitsReviewFrom(pr, await filterContext());
  }


  /**
   * Every archived thread BB knows about, as one list call per project rather
   * than a `threads.get` per pull request, so the cost does not grow with the
   * list. A project with more archived threads than the limit, or a thread in
   * no listed project, can still slip through — `openReview` re-checks the one
   * thread it is about to open.
   */
  async function listArchivedThreadIds(): Promise<Set<string>> {
    try {
      const projects = await bb.sdk.projects.list();
      const lists = await Promise.all(
        projects.map((project) =>
          // A review thread can be hidden from the sidebar as well as archived,
          // and BB leaves hidden threads out unless asked for them.
          bb.sdk.threads.list({
            projectId: project.id,
            archived: true,
            includeHidden: true,
            limit: 500,
          }),
        ),
      );
      return new Set(lists.flat().map((thread) => thread.id));
    } catch (error) {
      // A failed lookup must not empty the pull request list. Treat every thread
      // as live and leave it to openReview's own check.
      bb.log.warn(`could not list archived threads: ${String(error)}`);
      return new Set();
    }
  }

  /** Attach this plugin's review state to the wire DTO. */
  function withReviewState(pr: PullRequest, archivedThreadIds: Set<string>): PullRequestDto {
    const review = getReview(reviewIdFor(pr.repo, pr.number));
    const findings = review === null ? [] : listFindings(review.id);
    const threadId = review?.thread_id ?? null;
    return {
      ...pr,
      reviewStatus: review === null ? "none" : toReviewDto(review).status,
      openFindings: findings.filter((finding) => finding.state === "open").length,
      postedFindings: findings.filter((finding) => finding.state === "posted").length,
      reviewThreadId: threadId,
      reviewThreadArchived: threadId !== null && archivedThreadIds.has(threadId),
    };
  }

  // -------------------------------------------------------------------------
  // The PR snapshot the review agent reads
  // -------------------------------------------------------------------------
  /** A stored pull request: the snapshot, its diff, and whether it is pinned. */
interface StoredContext {
  snapshot: PrSnapshot;
  diff: string;
  atReviewStart: boolean;
}

interface ContextRow {
    snapshot: string;
    diff: string;
    fetched_at: string;
    at_review_start: number;
  }

  function storedContextFetchedAt(reviewId: string): string {
    const row = db
      .prepare(`SELECT fetched_at FROM review_context WHERE review_id = ?`)
      .get(reviewId) as { fetched_at: string } | undefined;
    return row?.fetched_at ?? "";
  }

  function getContext(reviewId: string): StoredContext | null {
    const row = db.prepare(`SELECT * FROM review_context WHERE review_id = ?`).get(reviewId) as
      | ContextRow
      | undefined;
    if (row === undefined) return null;
    return {
      snapshot: JSON.parse(row.snapshot) as PrSnapshot,
      diff: row.diff,
      atReviewStart: row.at_review_start !== 0,
    };
  }

  /**
   * Fetch the PR once, on the server, and store it. Everything the review
   * agent needs comes from here, so the agent never runs gh: gh is configured
   * and unsandboxed here, and may be neither in the agent's environment.
   *
   * Returns what it stored, so a caller never has to read back what it just
   * wrote and prove to the compiler that it is there.
   */
  async function fetchContext(
    repo: string,
    number: number,
    atReviewStart = true,
  ): Promise<StoredContext> {
    const [viewRaw, diffRaw] = await Promise.all([
      gh(["pr", "view", String(number), "-R", repo, "--json", PR_VIEW_JSON_FIELDS], 45_000),
      gh(["pr", "diff", String(number), "-R", repo], 120_000),
    ]);
    const snapshot = parsePrSnapshot(viewRaw);
    // Inline review comments live on a separate endpoint that some repos
    // refuse; losing them is not worth failing the review over.
    try {
      snapshot.reviewComments = parseReviewComments(
        await gh(["api", "--paginate", `repos/${repo}/pulls/${number}/comments`], 45_000),
      );
    } catch (error) {
      bb.log.warn(`could not fetch review comments for ${repo}#${number}: ${String(error)}`);
    }
    db.prepare(
      `INSERT INTO review_context (review_id, snapshot, diff, fetched_at, at_review_start)
       VALUES (@review_id, @snapshot, @diff, @fetched_at, @at_review_start)
       ON CONFLICT(review_id) DO UPDATE SET
         snapshot = @snapshot, diff = @diff, fetched_at = @fetched_at,
         at_review_start = @at_review_start`,
    ).run({
      review_id: reviewIdFor(repo, number),
      snapshot: JSON.stringify(snapshot),
      diff: diffRaw,
      fetched_at: nowIso(),
      at_review_start: atReviewStart ? 1 : 0,
    });
    return { snapshot, diff: diffRaw, atReviewStart };
  }

  /**
   * The stored pull request, fetching it if there is none.
   *
   * `refresh` is honoured only for a pull request that has not been reviewed.
   * A reviewed one is pinned to the commit its findings were written against,
   * and replacing that would move the code out from under comments already
   * written about it.
   */
  async function loadContext(
    repo: string,
    number: number,
    refresh = false,
  ): Promise<StoredContext> {
    const stored = getContext(reviewIdFor(repo, number));
    if (stored !== null && !(refresh && !stored.atReviewStart)) return stored;
    return fetchContext(repo, number, false);
  }

  // -------------------------------------------------------------------------
  // The model reviews run with
  // -------------------------------------------------------------------------
  function chosenReviewModel(): ReviewModelDto | null {
    const row = db.prepare(`SELECT model FROM review_model WHERE id = 1`).get() as
      | { model: string }
      | undefined;
    if (row === undefined) return null;
    let stored: unknown = null;
    try {
      stored = JSON.parse(row.model);
    } catch {
      stored = null;
    }
    const parsed = reviewModelSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  }

  /**
   * What a review of `repo` runs with while no model has been chosen: its BB
   * project's default. Only for showing in the picker — an unchosen review is
   * spawned without a model, so BB applies this default itself.
   */
  async function projectDefaultReviewModel(repo: string): Promise<ReviewModelDto | null> {
    try {
      const defaults = await bb.sdk.projects.defaultExecutionOptions({
        projectId: await resolveProjectId(repo),
      });
      const parsed = reviewModelSchema.safeParse(defaults);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      // A repo with no project cannot be reviewed either, and startReview says
      // so; the picker just has nothing to show until then.
      bb.log.warn(`could not read the default model for ${repo}: ${String(error)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Starting a review
  // -------------------------------------------------------------------------
  async function startReview(
    repo: string,
    number: number,
    skillOverride?: string[],
  ): Promise<ReviewDto> {
    requireRepo(repo);
    const config = await settings.get();
    const skills = skillOverride ?? parseSkillList(config.reviewSkills ?? "");
    const reviewId = reviewIdFor(repo, number);
    // Fetch the PR up front, on the server. If GitHub is unreachable there is
    // no point spawning an agent that would have nothing to read.
    const { snapshot } = await fetchContext(repo, number);
    const title = snapshot.title === "" ? `PR #${number}` : snapshot.title;
    const findingsPath = path.posix.join(
      config.findingsDir === "" ? ".bb/code-review" : config.findingsDir,
      `${repo.replace("/", "-")}-${number}.json`,
    );

    // Re-running a review replaces what has not been acted on and keeps what
    // has: posted comments are history, and dismissals are a decision the user
    // should not have to make twice.
    db.prepare(`DELETE FROM findings WHERE review_id = ? AND state = 'open'`).run(reviewId);
    dropOrphanedQuestions(reviewId);
    // The thread these were asked in is about to be replaced, so no answer is
    // coming for them.
    db.prepare(
      `UPDATE finding_questions SET status = 'unanswered' WHERE review_id = ? AND status = 'pending'`,
    ).run(reviewId);
    // Cached file bodies belong to the commit that was reviewed; a re-run may
    // be on a newer one.
    db.prepare(`DELETE FROM review_files WHERE review_id = ?`).run(reviewId);

    // Whether GitHub is asking *you* for this review decides how the thread is
    // cleaned up later: a request that was there at the start and is gone on a
    // later refresh means the review was submitted. Recorded now, because a
    // review run from "All open" never had one and must not look finished the
    // moment it is done.
    const awaitedMe = await awaitsReview(repo, number);

    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO reviews (id, repo, number, title, status, summary, error, thread_id,
                            findings_path, skills, created_at, updated_at,
                            awaited_me_at_start, thread_archived_at)
       VALUES (@id, @repo, @number, @title, 'queued', '', NULL, NULL, @findings_path,
               @skills, @created_at, @updated_at, @awaited_me, NULL)
       ON CONFLICT(id) DO UPDATE SET
         title = @title, status = 'queued', summary = '', error = NULL, thread_id = NULL,
         findings_path = @findings_path, skills = @skills, updated_at = @updated_at,
         awaited_me_at_start = @awaited_me, thread_archived_at = NULL`,
    ).run({
      id: reviewId,
      repo,
      number,
      title,
      findings_path: findingsPath,
      skills: JSON.stringify(skills),
      created_at: timestamp,
      updated_at: timestamp,
      awaited_me: awaitedMe ? 1 : 0,
    });
    announce();

    const projectId = await resolveProjectId(repo);
    const prompt = buildReviewPrompt({
      repo,
      number,
      title,
      reviewId,
      findingsPath,
      skills,
      extraInstructions: config.reviewInstructions ?? "",
      headSha: snapshot.headSha,
    });
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        // The repo is already the thread's project, so the title spends its
        // first characters on what tells one review thread apart from the next.
        title: `Review #${number} - ${title}`.slice(0, 120),
        prompt,
        // Nothing chosen leaves the model to the project's default.
        ...(chosenReviewModel() ?? {}),
      });
      touchReview(reviewId, { thread_id: thread.id, status: "running" });
      bb.log.info(`started review thread ${thread.id} for ${reviewId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      touchReview(reviewId, { status: "failed", error: message });
      announce();
      throw error;
    }
    announce();
    const row = getReview(reviewId);
    if (row === null) throw new Error(`review ${reviewId} disappeared`);
    return toReviewDto(row);
  }

  /**
   * Make sure this review's tab is on its thread. The tab list is BB's, and
   * another client may be writing it at the same time, so this is a
   * compare-and-swap with one retry. Failing to write the tab must not fail
   * the open: the review is reachable from the thread panel's own
   * New tab -> Actions list either way.
   *
   * Earlier versions put the PR in the tab's params, and wrote it under an id
   * BB did not match, so their threads can carry two or three copies of it.
   * Every review tab on the thread, whatever its params, is replaced by the
   * one fixed tab, in the first copy's place.
   */
  async function ensureReviewTab(threadId: string): Promise<void> {
    const tab = reviewTabFor(bb.pluginId);
    const isReviewTab = (entry: { id: string } & Record<string, unknown>) =>
      entry.id === tab.id ||
      (entry.kind === tab.kind &&
        entry.pluginId === tab.pluginId &&
        entry.actionId === tab.actionId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const current = await bb.sdk.threads.tabs.get({ threadId });
        const copies = current.tabs.filter(isReviewTab);
        if (copies.length === 1 && copies[0].id === tab.id) return;
        const at = current.tabs.findIndex(isReviewTab);
        const others = current.tabs.filter((entry) => !isReviewTab(entry));
        const tabs =
          at === -1 ? [...others, tab] : [...others.slice(0, at), tab, ...others.slice(at)];
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          tabs,
        });
        return;
      } catch (error) {
        if (attempt === 1) {
          bb.log.warn(`could not add the review tab to ${threadId}: ${String(error)}`);
          return;
        }
      }
    }
  }

  /**
   * Can this thread still be opened? A deleted one is gone, and an archived one
   * cannot be worked in while unarchiving is broken in BB — and `threads.get`
   * returns an archived thread perfectly happily, so only checking for deletion
   * would walk the user into a thread they cannot use.
   */
  async function threadOpenable(threadId: string): Promise<boolean> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.archivedAt === null;
    } catch {
      return false;
    }
  }

  /**
   * Open a review that has already run. This never starts an agent: pressing
   * "Open review" must not cost a review run, and a pull request with no
   * review offers "Start review" instead.
   */
  async function openReview(
    repo: string,
    number: number,
  ): Promise<{ threadId: string; review: ReviewDto }> {
    requireRepo(repo);
    const existing = getReview(reviewIdFor(repo, number));
    if (
      existing === null ||
      existing.thread_id === null ||
      !(await threadOpenable(existing.thread_id))
    ) {
      throw new Error(
        "This pull request has no review thread to open \u2014 start a new review instead.",
      );
    }
    await ensureReviewTab(existing.thread_id);
    return { threadId: existing.thread_id, review: toReviewDto(existing) };
  }

  // -------------------------------------------------------------------------
  // Importing the findings file
  // -------------------------------------------------------------------------

  /**
   * `run` executes on the server, but the findings file lives on whichever
   * machine the agent ran on. Resolve that host from the invoking thread and
   * read through bb.sdk.files so a remote checkout is not silently read from
   * the server's own disk.
   */
  async function resolveInvokingHostId(threadId?: string): Promise<string | undefined> {
    if (threadId === undefined) return undefined;
    try {
      const { environmentId } = await bb.sdk.threads.get({ threadId });
      if (environmentId === null) return undefined;
      const { hostId } = await bb.sdk.environments.get({ environmentId });
      return hostId;
    } catch (error) {
      bb.log.warn(`could not resolve invoking host for ${threadId}: ${String(error)}`);
      return undefined;
    }
  }

  function insertFinding(reviewId: string, ord: number, finding: Finding): void {
    db.prepare(
      `INSERT INTO findings (id, review_id, ord, file, start_line, end_line, side, severity,
                             category, title, summary, suggested_fix,
                             suggested_comment, references_json, draft_comment, state)
       VALUES (@id, @review_id, @ord, @file, @start_line, @end_line, @side, @severity,
               @category, @title, @summary, @suggested_fix,
               @suggested_comment, @references_json, NULL, 'open')`,
    ).run({
      id: randomUUID(),
      review_id: reviewId,
      ord,
      file: finding.file,
      start_line: finding.startLine,
      end_line: finding.endLine,
      side: finding.side,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      summary: finding.summary,
      suggested_fix: finding.suggestedFix,
      suggested_comment: finding.suggestedComment,
      references_json: JSON.stringify(finding.references),
    });
  }

  /** A stored finding back in the shape the agent writes. */
  function findingFromRow(row: FindingRow): Finding {
    const dto = toFindingDto(row);
    return {
      file: dto.file,
      startLine: dto.startLine,
      endLine: dto.endLine,
      side: dto.side,
      severity: dto.severity,
      category: dto.category,
      title: dto.title,
      summary: dto.summary,
      suggestedFix: dto.suggestedFix,
      suggestedComment: dto.suggestedComment,
      references: dto.references,
    };
  }

  function importFindings(reviewId: string, findings: Finding[], summary: string): number {
    const existingPosted = db
      .prepare(`SELECT COUNT(*) AS n FROM findings WHERE review_id = ? AND state != 'open'`)
      .get(reviewId) as { n: number };
    const write = db.transaction((rows: Finding[]) => {
      db.prepare(`DELETE FROM findings WHERE review_id = ? AND state = 'open'`).run(reviewId);
      dropOrphanedQuestions(reviewId);
      // Cached file bodies belong to the commit that was reviewed; a re-run may
      // be on a newer one.
      db.prepare(`DELETE FROM review_files WHERE review_id = ?`).run(reviewId);
      rows.forEach((finding, index) => insertFinding(reviewId, existingPosted.n + index, finding));
    });
    const sorted = [...findings].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.file.localeCompare(b.file) ||
        (a.startLine ?? 0) - (b.startLine ?? 0),
    );
    write(sorted);
    touchReview(reviewId, { status: "reported", summary, error: null });
    announce();
    return sorted.length;
  }

  // -------------------------------------------------------------------------
  // Posting to GitHub
  // -------------------------------------------------------------------------
  async function headSha(repo: string, number: number): Promise<string> {
    // Deliberately not cached: posting against a stale head SHA is rejected by
    // GitHub, and a review can sit in the panel while the PR keeps moving.
    const raw = await gh(["pr", "view", String(number), "-R", repo, "--json", "headRefOid"], 20_000);
    const sha = ghField(raw, "headRefOid");
    if (sha === "") throw new Error(`could not resolve the head commit of ${repo}#${number}`);
    return sha;
  }

  /**
   * The viewer's own unsubmitted review on a PR, if any.
   *
   * GitHub allows one pending review per user per PR, and refuses to create a
   * standalone review comment while one exists — so a reviewer who has started
   * a review in the GitHub UI cannot post from here unless the comment joins
   * that review. PENDING reviews are invisible to the REST reviews endpoint,
   * hence GraphQL.
   */
  async function pendingReviewId(repo: string, number: number): Promise<string | null> {
    const [owner, name] = repo.split("/");
    try {
      const raw = await gh(
        [
          "api", "graphql",
          "-f", `query=query($owner:String!,$name:String!,$number:Int!,$viewer:String!){
            repository(owner:$owner,name:$name){
              pullRequest(number:$number){
                reviews(last:20, states:PENDING, author:$viewer){ nodes { id } }
              } } }`,
          "-f", `owner=${owner}`,
          "-f", `name=${name}`,
          "-F", `number=${number}`,
          "-f", `viewer=${await getViewer()}`,
          "--jq", ".data.repository.pullRequest.reviews.nodes[0].id // empty",
        ],
        30_000,
      );
      const id = raw.trim();
      return id === "" ? null : id;
    } catch (error) {
      // What a failed lookup should mean is the caller's decision: guessing
      // "there is none" is harmless for a badge and harmful when the answer
      // decides whether to open a second draft.
      throw new Error(
        `could not look up a pending review on ${repo}#${number}: ${String(error)}`,
      );
    }
  }

  /** The same lookup for callers that can live with an unknown answer. */
  async function tolerantPendingReviewId(repo: string, number: number): Promise<string | null> {
    try {
      return await pendingReviewId(repo, number);
    } catch (error) {
      bb.log.warn(String(error));
      return null;
    }
  }

  /**
   * Start a pending review whose first comment is this finding.
   *
   * A reviewer works across both surfaces — some comments here, some in the
   * GitHub UI — so the plugin has to be able to open the shared draft, not
   * only join one somebody else's UI started.
   */
  async function startPendingReview(
    repo: string,
    number: number,
    finding: FindingDto,
    anchor: PostAnchor,
    body: string,
  ): Promise<string> {
    const comment: Record<string, unknown> = {
      path: finding.file,
      line: anchor.line ?? 1,
      side: finding.side,
      body,
    };
    if (anchor.startLine !== null) {
      comment.start_line = anchor.startLine;
      comment.start_side = finding.side;
    }
    // No `event` means the review is created PENDING, which is the point.
    const raw = await gh(
      [
        "api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`,
        "--input", "-",
      ],
      30_000,
      JSON.stringify({ commit_id: await headSha(repo, number), comments: [comment] }),
    );
    return ghField(raw, "html_url");
  }

  /**
   * Open the shared draft — unless one appeared between the lookup and now, in
   * which case join it. Two drafts on one pull request split the reviewer's
   * comments in half, and GitHub gives them no way to merge the halves.
   */
  async function startOrJoinPendingReview(
    repo: string,
    number: number,
    finding: FindingDto,
    anchor: PostAnchor,
    body: string,
  ): Promise<string> {
    try {
      return await startPendingReview(repo, number, finding, anchor, body);
    } catch (error) {
      const raced = await tolerantPendingReviewId(repo, number);
      if (raced === null) throw error;
      return await addToPendingReview(raced, finding, anchor, body);
    }
  }

  // One lookup per PR view would be a network call on every render, so hold
  // the answer briefly. This is for display only — posting asks GitHub afresh,
  // because a cached "no draft" that the user has since contradicted by
  // clicking "Start a review" would make the plugin open a second draft.
  const pendingReviewCache = new Map<string, { id: string | null; at: number }>();

  async function cachedPendingReviewId(repo: string, number: number): Promise<string | null> {
    const key = reviewIdFor(repo, number);
    const cached = pendingReviewCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.id;
    const id = await tolerantPendingReviewId(repo, number);
    pendingReviewCache.set(key, { id, at: Date.now() });
    return id;
  }

  /** Add a comment to an existing pending review. Returns its URL. */
  async function addToPendingReview(
    reviewId: string,
    finding: FindingDto,
    anchor: PostAnchor,
    body: string,
  ): Promise<string> {
    const end = anchor.line ?? 0;
    const isRange = anchor.startLine !== null;
    const mutation = `mutation($reviewId:ID!,$path:String!,$body:String!,$line:Int!,$side:DiffSide!${
      isRange ? ",$startLine:Int!,$startSide:DiffSide!" : ""
    }){
      addPullRequestReviewThread(input:{
        pullRequestReviewId:$reviewId, path:$path, body:$body, line:$line, side:$side${
          isRange ? ", startLine:$startLine, startSide:$startSide" : ""
        }
      }){ thread { comments(first:1){ nodes { url } } } }
    }`;
    const args = [
      "api", "graphql",
      "-f", `query=${mutation}`,
      "-f", `reviewId=${reviewId}`,
      "-f", `path=${finding.file}`,
      "-f", `body=${body}`,
      "-F", `line=${end}`,
      "-f", `side=${finding.side}`,
    ];
    if (isRange) {
      args.push("-F", `startLine=${anchor.startLine}`, "-f", `startSide=${finding.side}`);
    }
    const raw = await gh(args, 30_000);
    const parsed = JSON.parse(raw) as {
      data?: { addPullRequestReviewThread?: { thread?: { comments?: { nodes?: Array<{ url?: unknown }> } } | null } };
    };
    const thread = parsed.data?.addPullRequestReviewThread?.thread;
    if (thread == null) {
      // GitHub answers with a null thread and no error when it will not place
      // one — in practice, when this line already has a thread on it.
      throw new Error(
        `GitHub would not add a comment at ${finding.file}:${anchor.line}. That usually ` +
          "means a comment thread already exists there — reply to it on GitHub instead.",
      );
    }
    return String(thread.comments?.nodes?.[0]?.url ?? "");
  }

  /** The anchor GitHub will accept for a finding, from the reviewed diff. */
  function postAnchorFor(finding: FindingDto): PostAnchor {
    const stored = getContext(finding.reviewId);
    if (stored === null) return resolvePostAnchor(finding, [], true);
    const patch = splitUnifiedDiff(stored.diff).find((file) => file.path === finding.file);
    return resolvePostAnchor(
      finding,
      patch === undefined ? [] : diffHunkRanges(patch.patch, finding.side),
      patch !== undefined,
    );
  }

  async function postFinding(
    findingId: string,
    mode: "inline" | "issue" | "review",
  ): Promise<FindingDto> {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    if (finding.state === "posted") {
      throw new Error("That comment has already been posted.");
    }
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    const body = effectiveComment(finding);
    if (body.trim() === "") throw new Error("The comment is empty.");

    // "issue" is an explicit request for a plain pull request comment; anything
    // else takes the best placement the diff allows.
    const anchor = mode === "issue"
      ? { kind: "pull-request" as const, line: null, startLine: null, adjusted: false }
      : postAnchorFor(finding);
    const attachable = anchor.kind !== "pull-request";

    // A reviewer with a review already open in the GitHub UI cannot have a
    // standalone comment created; the comment has to join that review. Ask
    // GitHub now rather than reuse the panel's cached answer, which can predate
    // the user clicking "Start a review" on GitHub seconds ago.
    const mightOpenDraft = anchor.kind === "line" && mode === "review";
    let pending: string | null = null;
    if (attachable) {
      try {
        pending = await pendingReviewId(review.repo, review.number);
      } catch (error) {
        // Guessing "no draft" is safe when the fallback is a standalone
        // comment: GitHub rejects that outright if a draft does exist. It is
        // not safe when the fallback opens a draft, because a wrong guess
        // leaves the reviewer with two of them.
        if (mightOpenDraft) throw error;
        bb.log.warn(String(error));
      }
    }

    let url: string;
    let postedAs: "comment" | "pending-review";
    if (anchor.kind === "line" && (pending !== null || mode === "review")) {
      // Join the open review when there is one; otherwise open it, so the next
      // comment — from here or from GitHub — lands in the same draft.
      url =
        pending !== null
          ? await addToPendingReview(pending, finding, anchor, body)
          : await startOrJoinPendingReview(review.repo, review.number, finding, anchor, body);
      postedAs = "pending-review";
    } else {
      const raw = await gh(
        buildPostCommentArgs({
          repo: review.repo,
          number: review.number,
          body,
          headSha: attachable ? await headSha(review.repo, review.number) : "",
          file: finding.file,
          startLine: anchor.startLine ?? anchor.line,
          endLine: anchor.line,
          side: finding.side,
          kind: anchor.kind,
        }),
        30_000,
      );
      url = ghField(raw, "html_url");
      postedAs = "comment";
    }

    // Posting can create the pending review, so the cached answer is stale.
    pendingReviewCache.delete(reviewIdFor(review.repo, review.number));

    db.prepare(
      `UPDATE findings SET state = 'posted', comment_url = ?, posted_at = ?, posted_as = ?
       WHERE id = ?`,
    ).run(url === "" ? null : url, nowIso(), postedAs, findingId);
    announce();
    return findingDto(requireFinding(findingId));
  }

  // -------------------------------------------------------------------------
  // Asking the review thread about a finding
  // -------------------------------------------------------------------------

  /**
   * Questions go to the thread that produced the review, not to a fresh thread
   * per finding: it already holds the PR, the diff, and the reasoning behind
   * every finding, and one conversation per review is one place to look.
   * Re-running a review starts a new thread, so the conversation always
   * belongs to the run whose findings are on screen.
   */
  async function askAboutFinding(
    findingId: string,
    question: string,
  ): Promise<{ threadId: string; questionId: string }> {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    const threadId = review.thread_id;
    if (threadId === null) {
      throw new Error("This review has no thread yet — start the review first.");
    }
    try {
      await bb.sdk.threads.get({ threadId });
    } catch {
      throw new Error("The review thread is gone. Re-run the review to start a new one.");
    }
    const questionId = randomUUID();
    // Beside the findings file, which the agent already writes into.
    const answerPath = path.join(
      path.dirname(review.findings_path ?? ".bb/code-review/findings.json"),
      "answers",
      `${questionId}.json`,
    );
    // Recorded before sending, so a fast answer always finds its question.
    db.prepare(
      `INSERT INTO finding_questions (id, finding_id, review_id, question, status, asked_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(questionId, findingId, review.id, question, nowIso());
    try {
      await bb.sdk.threads.send({
        threadId,
        // Queued, not steered: questions asked in quick succession then get a
        // turn each, instead of being folded into whichever answer is being
        // written.
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            mentions: [],
            text: buildFindingQuestion({
              reviewId: review.id,
              finding: {
                id: finding.id,
                file: finding.file,
                startLine: finding.startLine,
                endLine: finding.endLine,
                title: finding.title,
                summary: finding.summary,
                suggestedFix: finding.suggestedFix,
                suggestedComment: effectiveComment(finding),
              },
              question,
              questionId,
              answerPath,
            }),
          },
        ],
      });
    } catch (error) {
      db.prepare(`DELETE FROM finding_questions WHERE id = ?`).run(questionId);
      throw error;
    }
    announce();
    return { threadId, questionId };
  }

  /**
   * The row changes that revise a finding, from the review thread as the
   * discussion moves on.
   *
   * The comment is rewritten only while it is still the agent's own: an edit
   * of the reviewer's is theirs, and a posted comment is history. A revision
   * that cannot be applied is offered beside the comment instead. A posted
   * comment also stays where it was posted, so its location cannot move.
   */
  function reviseFinding(
    row: FindingRow,
    changes: Partial<Finding>,
  ): { patch: Partial<FindingRow>; fields: RevisedField[] } {
    const patch: Partial<FindingRow> = {};
    const fields: RevisedField[] = [];
    const set = <K extends keyof FindingRow>(
      field: RevisedField,
      column: K,
      value: FindingRow[K] | undefined,
    ) => {
      if (value === undefined || value === row[column]) return;
      patch[column] = value;
      if (!fields.includes(field)) fields.push(field);
    };
    set("title", "title", changes.title);
    set("summary", "summary", changes.summary);
    set("suggestedFix", "suggested_fix", changes.suggestedFix);
    set("severity", "severity", changes.severity);
    set("category", "category", changes.category);
    if (changes.references !== undefined) {
      set("references", "references_json", JSON.stringify(changes.references));
    }
    const movesLocation =
      (changes.file !== undefined && changes.file !== row.file) ||
      (changes.startLine !== undefined && changes.startLine !== row.start_line) ||
      (changes.endLine !== undefined && changes.endLine !== row.end_line) ||
      (changes.side !== undefined && changes.side !== row.side);
    if (movesLocation) {
      if (row.state === "posted") {
        throw new Error(
          `"${row.title}" is already posted, so it cannot move. Add a new finding instead.`,
        );
      }
      set("location", "file", changes.file);
      set("location", "start_line", changes.startLine);
      set("location", "end_line", changes.endLine);
      set("location", "side", changes.side);
    }
    const comment = changes.suggestedComment;
    if (comment !== undefined && comment !== (row.draft_comment ?? row.suggested_comment)) {
      if (row.state !== "posted" && row.draft_comment === null) {
        set("suggestedComment", "suggested_comment", comment);
        patch.proposed_comment = null;
      } else {
        patch.proposed_comment = comment;
      }
    }
    return { patch, fields };
  }

  function writeFindingPatch(findingId: string, patch: Partial<FindingRow>): void {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    db.prepare(
      `UPDATE findings SET ${columns.map((column) => `${column} = @${column}`).join(", ")}
       WHERE id = @id`,
    ).run({ ...patch, id: findingId });
  }

  /** What the thread is told about a revision, so it knows what landed. */
  function describeRevision(row: FindingRow, fields: RevisedField[], patch: Partial<FindingRow>) {
    const labels = fields.map((field) =>
      field === "suggestedFix" ? "suggested fix" : field === "suggestedComment" ? "comment" : field,
    );
    return [
      labels.length === 0 ? null : `Updated "${patch.title ?? row.title}": ${labels.join(", ")}.`,
      patch.proposed_comment == null
        ? null
        : row.state === "posted"
          ? `"${row.title}" is already posted, so the revised comment is shown beside it instead.`
          : `The reviewer has edited the comment on "${row.title}", so the revised one is offered beside theirs instead of replacing it.`,
    ].filter((line): line is string => line !== null);
  }

  /** Put the review thread's answer on the issue, revising the finding as it says. */
  function recordAnswer(questionId: string, raw: string): string {
    const question = getQuestion(questionId);
    if (question === null) {
      throw new Error(`No question with id ${questionId}. Use the id from the message that asked it.`);
    }
    const row = getFinding(question.finding_id);
    if (row === null) {
      throw new Error("That issue was replaced by a re-run of the review, so there is nowhere to put the answer.");
    }
    const { answer, error } = parseAnswer(raw);
    if (answer === null) {
      throw new Error(`Not a valid answer file — ${error}\n\nExpected shape:\n${ANSWER_SCHEMA_TEXT}`);
    }
    const { answer: text, ...changes } = answer;
    const { patch, fields } = reviseFinding(row, changes);
    db.transaction(() => {
      writeFindingPatch(row.id, patch);
      db.prepare(
        `UPDATE finding_questions
         SET status = 'answered', answer = ?, updated_fields = ?, answered_at = ?
         WHERE id = ?`,
      ).run(text, JSON.stringify(fields), nowIso(), questionId);
    })();
    announce();
    return [`Answer recorded on "${patch.title ?? row.title}".`, ...describeRevision(row, fields, patch)].join(
      "\n",
    );
  }

  /**
   * Apply the review thread's edit to a report it has already submitted: add
   * findings, revise them, or withdraw them. All or nothing, so the thread
   * never has to work out which half landed.
   *
   * Withdrawing dismisses rather than deletes. The reviewer may have edited
   * the comment or asked about it, and a dismissal keeps all of that, says
   * why, and is one click to undo.
   */
  async function editReport(reviewId: string, raw: string): Promise<string> {
    const review = getReview(reviewId);
    if (review === null) throw new Error(unknownReview(reviewId));
    const { edit, errors } = parseReportEdit(raw);
    if (edit === null) {
      throw new Error(
        `Not a valid edit file — ${errors.join("; ")}\n\nExpected shape:\n${REPORT_EDIT_SCHEMA_TEXT}`,
      );
    }

    const rowFor = (id: string, verb: string): FindingRow => {
      const row = getFinding(id);
      if (row === null || row.review_id !== reviewId) {
        throw new Error(
          `Cannot ${verb} ${id}: no finding with that id in ${reviewId}. ` +
            `\`bb code-review findings --review ${reviewId}\` lists them.`,
        );
      }
      return row;
    };
    const updates = edit.update.map(({ id, note, ...changes }) => {
      const row = rowFor(id, "update");
      return { row, note: note ?? "", changes, ...reviseFinding(row, changes) };
    });
    const removals = edit.remove.map(({ id, reason }) => {
      const row = rowFor(id, "remove");
      if (row.state === "posted") {
        throw new Error(`Cannot remove "${row.title}": it is already posted to GitHub.`);
      }
      return { row, reason };
    });

    // The same check `submit` makes, on everything this edit would leave in
    // the report, while the thread can still fix it.
    const snapshot = getContext(reviewId)?.snapshot ?? null;
    if (snapshot !== null) {
      const repoPaths = await repoTree(reviewId, review.repo, snapshot.headSha);
      const updated = updates
        .filter(({ changes }) => changes.file !== undefined || changes.references !== undefined)
        .map(({ row, changes }) => ({
          ...findingFromRow(row),
          ...changes,
        }));
      const problems = [
        { label: '"add"', bad: findBadPaths(edit.add, repoPaths) },
        { label: '"update"', bad: findBadPaths(updated, repoPaths) },
      ].filter(({ bad }) => bad.length > 0);
      if (problems.length > 0) {
        throw new Error(
          problems.map(({ label, bad }) => `In ${label}: ${formatBadPaths(bad)}`).join("\n\n"),
        );
      }
    }

    const at = nowIso();
    db.transaction(() => {
      const { next } = db
        .prepare(`SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM findings WHERE review_id = ?`)
        .get(reviewId) as { next: number };
      edit.add.forEach((finding, index) => insertFinding(reviewId, next + index, finding));
      for (const { row, note, patch, fields } of updates) {
        writeFindingPatch(row.id, {
          ...patch,
          revised_at: at,
          revision_note: note,
          revised_fields: JSON.stringify(fields),
        });
      }
      for (const { row, reason } of removals) {
        writeFindingPatch(row.id, { state: "dismissed", removed_reason: reason });
      }
    })();
    announce();

    return [
      edit.add.length === 0 ? null : `Added ${edit.add.map((finding) => `"${finding.title}"`).join(", ")}.`,
      ...updates.flatMap(({ row, fields, patch }) =>
        fields.length === 0 && patch.proposed_comment == null
          ? [`"${row.title}" was already as given; nothing changed.`]
          : describeRevision(row, fields, patch),
      ),
      removals.length === 0
        ? null
        : `Removed ${removals.map(({ row }) => `"${row.title}"`).join(", ")} — dismissed, so the reviewer can restore them.`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  /** The findings as the review thread should see them, to edit them by id. */
  function formatFindingsForAgent(reviewId: string): string {
    const findings = listFindings(reviewId);
    if (findings.length === 0) return `${reviewId} has no findings.`;
    return findings
      .map((finding) =>
        [
          `${finding.id}  [${finding.state}${finding.draftComment === null ? "" : ", comment edited by the reviewer"}]  ${finding.severity}  ${locationOf(finding)}`,
          `  ${finding.title}`,
          `  comment: ${(finding.draftComment ?? finding.suggestedComment).split("\n").join("\n           ")}`,
        ].join("\n"),
      )
      .join("\n\n");
  }

  /**
   * Once the review thread has nothing left to do, a question still waiting
   * was not answered through `bb code-review answer` — usually because the
   * agent replied in the chat instead. Saying so beats a spinner that never
   * stops. When only one question was outstanding, the thread's last reply
   * can only be about it, so that is shown in its place.
   *
   * Checked after a pause, and against the queue and the thread's status,
   * because a thread goes idle between one queued question and the next.
   */
  async function settleQuestions(reviewId: string, threadId: string, lastReply: string | null) {
    const pendingFor = () =>
      db
        .prepare(`SELECT * FROM finding_questions WHERE review_id = ? AND status = 'pending'`)
        .all(reviewId) as QuestionRow[];
    if (pendingFor().length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, idleSettleMs));
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    if (queued.length > 0) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status !== "idle") return;
    // The review may have been re-run meanwhile, onto another thread.
    if (getReview(reviewId)?.thread_id !== threadId) return;
    const pending = pendingFor();
    if (pending.length === 0) return;
    const reply = pending.length === 1 && lastReply !== null && lastReply.trim() !== "" ? lastReply : null;
    const mark = db.prepare(
      `UPDATE finding_questions SET status = 'unanswered', answer = ? WHERE id = ? AND status = 'pending'`,
    );
    for (const question of pending) mark.run(reply, question.id);
    announce();
  }

  // -------------------------------------------------------------------------
  // Review threads that end without submitting
  // -------------------------------------------------------------------------
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const review = getReviewByThread(thread.id);
    if (review === null) return;
    if (review.status !== "running") {
      void settleQuestions(review.id, thread.id, lastAssistantText).catch((error) => {
        bb.log.warn(`could not settle questions for ${review.id}: ${String(error)}`);
      });
      return;
    }
    touchReview(review.id, {
      status: "failed",
      error:
        "The review thread finished without submitting findings. Open it to see what happened, " +
        "or re-run the review.",
    });
    announce();
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const review = getReviewByThread(thread.id);
    if (review === null) return;
    if (review.status !== "running") {
      // Nothing more will come from a failed turn; asking again retries it.
      const settled = db
        .prepare(
          `UPDATE finding_questions SET status = 'unanswered' WHERE review_id = ? AND status = 'pending'`,
        )
        .run(review.id);
      if (settled.changes > 0) announce();
      return;
    }
    touchReview(review.id, { status: "failed", error: error ?? "The review thread failed." });
    announce();
  });

  // -------------------------------------------------------------------------
  // The code a finding points at
  // -------------------------------------------------------------------------

  /**
   * A file's body at the reviewed commit, cached per review. Fetched from
   * GitHub rather than a checkout because the panel has no worktree, and
   * because the reviewed commit is what the finding's line numbers refer to.
   */
  async function fileContent(
    reviewId: string,
    repo: string,
    sha: string,
    filePath: string,
  ): Promise<{ content: string | null; error: string | null }> {
    const cached = db
      .prepare(`SELECT content, error FROM review_files WHERE review_id = ? AND path = ?`)
      .get(reviewId, filePath) as { content: string | null; error: string | null } | undefined;
    if (cached !== undefined) return cached;

    let content: string | null = null;
    let error: string | null = null;
    try {
      const raw = await gh(
        [
          "api",
          `repos/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
        ],
        30_000,
      );
      const parsed = JSON.parse(raw) as { content?: unknown; encoding?: unknown };
      if (typeof parsed.content !== "string") {
        error = `${filePath} is not a readable file at ${sha.slice(0, 12)}.`;
      } else {
        content =
          parsed.encoding === "base64"
            ? Buffer.from(parsed.content, "base64").toString("utf8")
            : parsed.content;
      }
    } catch (cause) {
      // A cited file may simply not exist at that commit — the agent may have
      // named it loosely. That is a per-file note, not a failed request.
      const message = cause instanceof Error ? cause.message : String(cause);
      error = /404|not found/i.test(message)
        ? `${filePath} is not in the repository at ${sha.slice(0, 12)}.`
        : message;
    }
    db.prepare(
      `INSERT INTO review_files (review_id, path, content, error, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(review_id, path) DO UPDATE SET
         content = excluded.content, error = excluded.error, fetched_at = excluded.fetched_at`,
    ).run(reviewId, filePath, content, error, nowIso());
    return { content, error };
  }

  /**
   * Every path in the repo at the reviewed commit, cached per review. Fetched
   * only when a citation fails to resolve against the PR's own files, which is
   * the uncommon case.
   */
  async function repoTree(reviewId: string, repo: string, sha: string): Promise<string[]> {
    // Only a list of the same commit will do: a re-run reviews a newer head,
    // and checking it against the old one rejects every file the PR has
    // added since.
    const cached = db
      .prepare(`SELECT paths FROM repo_tree WHERE review_id = ? AND sha = ?`)
      .get(reviewId, sha) as { paths: string } | undefined;
    if (cached !== undefined) return parseJsonArray<string>(cached.paths);
    let paths: string[] = [];
    try {
      const raw = await gh(
        [
          "api",
          `repos/${repo}/git/trees/${sha}?recursive=1`,
          "--jq",
          '[.tree[] | select(.type=="blob") | .path] | join("\n")',
        ],
        45_000,
      );
      paths = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    } catch (error) {
      // Resolution is a convenience; without it a citation just stays as
      // written and reports that it is not in the repo.
      bb.log.warn(`could not read the tree of ${repo}@${sha.slice(0, 12)}: ${String(error)}`);
    }
    db.prepare(
      `INSERT INTO repo_tree (review_id, paths, fetched_at, sha) VALUES (?, ?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET
         paths = excluded.paths, fetched_at = excluded.fetched_at, sha = excluded.sha`,
    ).run(reviewId, JSON.stringify(paths), nowIso(), sha);
    return paths;
  }

  function pathDigest(filePath: string): string {
    return createHash("sha256").update(filePath).digest("hex");
  }

  async function findingCode(findingId: string, contextLines: number) {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    // A review from before snapshots existed, or one whose fetch failed, has
    // no stored commit. Fetching it is two gh calls — far cheaper than telling
    // the user to re-run an agent review just to look at code.
    let stored = getContext(finding.reviewId);
    if (stored === null || stored.snapshot.headSha === "") {
      await fetchContext(review.repo, review.number, false);
      stored = getContext(finding.reviewId);
    }
    const snapshot = stored?.snapshot ?? null;
    const sha = snapshot?.headSha ?? "";
    // Parsed once for the whole finding: several locations often sit in the
    // same file, and every one of them needs the same answer.
    const patches = stored === null ? [] : splitUnifiedDiff(stored.diff);

    const prPaths = (snapshot?.files ?? []).map((entry) => entry.path);
    // Resolve against the PR's files first; only if something still looks
    // unresolved is the repo-wide tree worth a call.
    const firstPass = findingLocations(
      {
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        summary: finding.summary,
        suggestedComment: finding.suggestedComment,
        references: finding.references,
      },
      (file) => resolveCitedPath(file, prPaths, [], finding.file),
    );
    const treePaths = firstPass.some((location) => needsPathResolution(location.file, prPaths))
      ? await repoTree(finding.reviewId, review.repo, sha)
      : [];

    const locations: FindingLocation[] = findingLocations({
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      summary: finding.summary,
      suggestedComment: finding.suggestedComment,
      references: finding.references,
    }, (file) => resolveCitedPath(file, prPaths, treePaths, finding.file));

    const resolved = await Promise.all(
      locations.map(async (location) => {
        const diffUrl = githubPrFileUrl({
          repo: review.repo,
          number: review.number,
          pathDigest: pathDigest(location.file),
          line: location.startLine,
          side: finding.side,
        });
        const blobUrl = githubBlobUrl({
          repo: review.repo,
          sha,
          file: location.file,
          startLine: location.startLine,
          endLine: location.endLine,
        });
        const base = {
          ...location,
          diffUrl,
          blobUrl,
          contextBlock: "",
          firstLine: 1,
          lines: [] as string[],
          inDiff: patches.some((entry) => entry.path === location.file),
          addedLines: [] as number[],
          removals: [] as Array<{ afterLine: number; lines: string[] }>,
        };
        if (sha === "") {
          return {
            ...base,
            hasMoreAbove: false,
            hasMoreBelow: false,
            error: "This review has no fetched commit; re-run it to see the code.",
          };
        }
        const { content, error } = await fileContent(
          finding.reviewId,
          review.repo,
          sha,
          location.file,
        );
        if (content === null) {
          // An unresolved citation is more useful with its candidates than
          // with a bare "not found".
          const candidates = citationCandidates(location.file, treePaths).slice(0, 5);
          const detail =
            candidates.length > 1
              ? `${error} It could be: ${candidates.join(", ")}.`
              : error;
          return { ...base, hasMoreAbove: false, hasMoreBelow: false, error: detail };
        }
        const all = content.split("\n");
        // No line anchor means the whole file is the subject; show the head of
        // it rather than nothing.
        const start = location.startLine ?? 1;
        const end = location.endLine ?? start;
        const from = Math.max(1, start - contextLines);
        const to = Math.min(all.length, end + contextLines);
        const lines = all.slice(from - 1, to);
        // What the pull request did to this window, so the snippet can say
        // whether the reader is looking at new code or code that was already
        // there — the file alone cannot tell them apart.
        const patch = patches.find((entry) => entry.path === location.file);
        const changes =
          patch === undefined ? { added: [], removals: [] } : patchLineChanges(patch.patch);
        return {
          ...base,
          firstLine: from,
          lines,
          addedLines: changes.added.filter((line) => line >= from && line <= to),
          removals: changes.removals.filter(
            // `afterLine` 0 means "before the first line of the file", which is
            // only in this window when the window starts at the top.
            (removal) => removal.afterLine >= from - 1 && removal.afterLine <= to,
          ),
          contextBlock: buildFileContextBlock({
            file: location.file,
            startLine: location.startLine,
            endLine: location.endLine,
            blobUrl,
            lines,
            firstLine: from,
          }),
          hasMoreAbove: from > 1,
          hasMoreBelow: to < all.length,
          error: null,
        };
      }),
    );
    return {
      prUrl: githubPrUrl(review.repo, review.number),
      headSha: sha,
      // False when the code shown was fetched after the fact, so its line
      // numbers may have moved since the finding was written.
      isReviewedCommit: stored?.atReviewStart ?? false,
      locations: resolved,
    };
  }

  // -------------------------------------------------------------------------
  // Panel state, so re-opening the tab resumes where it left off
  // -------------------------------------------------------------------------
  function readPanelState() {
    const row = db
      .prepare(`SELECT repo, filter, side_pane, diff_file, diff_url FROM panel_state WHERE id = 1`)
      .get() as
      | {
          repo: string | null;
          filter: string | null;
          side_pane: string | null;
          diff_file: string | null;
          diff_url: string | null;
        }
      | undefined;
    if (row === undefined) {
      return { repo: null, filter: null, sidePane: null, diffFile: null, diffUrl: null };
    }
    let filter: unknown = null;
    try {
      filter = row.filter === null ? null : JSON.parse(row.filter);
    } catch {
      filter = null;
    }
    const parsed = filterSchema.safeParse(filter);
    const sidePane = sidePaneSchema.safeParse(row.side_pane);
    return {
      repo: row.repo,
      filter: parsed.success ? parsed.data : null,
      sidePane: sidePane.success ? sidePane.data : null,
      diffFile: row.diff_file,
      diffUrl: row.diff_url,
    };
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async status() {
      const config = await settings.get();
      let viewer: string | null = null;
      try {
        await checkAuth();
        viewer = await getViewer();
      } catch (error) {
        if (ghDetail === null) {
          ghDetail = error instanceof Error ? error.message : String(error);
        }
      }
      const repos = (await discoverRepos()).map((info) => info.repo);
      const myTeams = ghState === "ready" ? await getMyTeams() : [];
      return {
        state: ghState,
        detail: ghDetail,
        viewer,
        repos,
        myTeams,
        skills: parseSkillList(config.reviewSkills ?? ""),
      };
    },

    async listPullRequests({ repo, filter, refresh }) {
      requireRepo(repo);
      await checkAuth();
      const { prs, fetchedAt } = await fetchPullRequests(repo, refresh === true);
      const filtered = filterPullRequests(prs, filter, await filterContext());
      const archivedThreadIds = await listArchivedThreadIds();
      return {
        fetchedAt,
        pullRequests: filtered
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((candidate) => withReviewState(candidate, archivedThreadIds)),
      };
    },

    // The panel shows issues, not the diff — the diff lives on GitHub, one
    // click away, and the reviewed snapshot is already stored. So this stays a
    // cheap read rather than a per-view `gh pr diff`.
    async getPullRequest({ repo, number }) {
      requireRepo(repo);
      await checkAuth();
      const { prs } = await fetchPullRequests(repo);
      const pr = prs.find((candidate) => candidate.number === number) ?? null;
      const review = getReview(reviewIdFor(repo, number));
      const archivedThreadIds = await listArchivedThreadIds();
      return {
        pullRequest: pr === null ? null : withReviewState(pr, archivedThreadIds),
        review: review === null ? null : toReviewDto(review),
        findings: review === null ? [] : listFindings(review.id),
        hasPendingReview: (await cachedPendingReviewId(repo, number)) !== null,
      };
    },

    async startReview({ repo, number, skills }) {
      await checkAuth();
      const review = await startReview(repo, number, skills);
      // The panel stays on its list, so the thread may be reached from the
      // sidebar before "Open review" is ever pressed: the tab has to be there.
      if (review.threadId !== null) await ensureReviewTab(review.threadId);
      return { review };
    },

    setFindingComment({ findingId, comment }) {
      const row = requireFinding(findingId);
      // Storing null when the edit matches the suggestion keeps "edited" an
      // honest signal in the UI.
      const draft = comment === row.suggested_comment ? null : comment;
      db.prepare(`UPDATE findings SET draft_comment = ? WHERE id = ?`).run(draft, findingId);
      announce();
      return { finding: findingDto(requireFinding(findingId)) };
    },

    setFindingState({ findingId, state }) {
      const row = requireFinding(findingId);
      if (row.state === "posted") throw new Error("That comment has already been posted.");
      // The reviewer's own decision replaces the thread's reason for it.
      db.prepare(`UPDATE findings SET state = ?, removed_reason = NULL WHERE id = ?`).run(
        state,
        findingId,
      );
      announce();
      return { finding: findingDto(requireFinding(findingId)) };
    },

    async postFinding({ findingId, mode }) {
      await checkAuth();
      return { finding: await postFinding(findingId, mode) };
    },

    async askAboutFinding({ findingId, question }) {
      return askAboutFinding(findingId, question);
    },

    resolveProposedComment({ findingId, use }) {
      const row = requireFinding(findingId);
      if (row.proposed_comment === null) throw new Error("There is no revised comment to use.");
      if (use && row.state === "posted") throw new Error("That comment has already been posted.");
      writeFindingPatch(
        findingId,
        use
          ? { suggested_comment: row.proposed_comment, draft_comment: null, proposed_comment: null }
          : { proposed_comment: null },
      );
      announce();
      return { finding: findingDto(requireFinding(findingId)) };
    },

    async openReview({ repo, number }) {
      await checkAuth();
      return openReview(repo, number);
    },

    getReviewForThread({ threadId }) {
      const row = getReviewByThread(threadId);
      return row === null ? null : { repo: row.repo, number: row.number };
    },

    async getFindingCode({ findingId, context }) {
      await checkAuth();
      return findingCode(findingId, context ?? 3);
    },

    async getReviewModel({ repo }) {
      return chosenReviewModel() ?? (repo === null ? null : projectDefaultReviewModel(repo));
    },

    setReviewModel(model) {
      db.prepare(
        `INSERT INTO review_model (id, model, updated_at) VALUES (1, @model, @updated_at)
         ON CONFLICT(id) DO UPDATE SET model = @model, updated_at = @updated_at`,
      ).run({ model: JSON.stringify(model), updated_at: nowIso() });
      // So a picker already on screen elsewhere follows this choice.
      announcePanelState();
      return model;
    },

    getPanelState() {
      return readPanelState();
    },

    setPanelState(patch) {
      const current = readPanelState();
      const repo = patch.repo === undefined ? current.repo : patch.repo;
      const filter = patch.filter === undefined ? current.filter : patch.filter;
      const sidePane = patch.sidePane === undefined ? current.sidePane : patch.sidePane;
      const diffFile = patch.diffFile === undefined ? current.diffFile : patch.diffFile;
      const diffUrl = patch.diffUrl === undefined ? current.diffUrl : patch.diffUrl;
      db.prepare(
        `INSERT INTO panel_state (id, repo, filter, side_pane, diff_file, diff_url, updated_at)
         VALUES (1, @repo, @filter, @side_pane, @diff_file, @diff_url, @updated_at)
         ON CONFLICT(id) DO UPDATE SET repo = @repo, filter = @filter,
           side_pane = @side_pane, diff_file = @diff_file, diff_url = @diff_url,
           updated_at = @updated_at`,
      ).run({
        repo,
        filter: filter === null ? null : JSON.stringify(filter),
        side_pane: sidePane,
        diff_file: diffFile,
        diff_url: diffUrl,
        updated_at: nowIso(),
      });
      // So a side pane already on screen follows a choice made elsewhere —
      // pressing "Discuss" on an issue, or another window.
      announcePanelState();
      return readPanelState();
    },
  });

  // -------------------------------------------------------------------------
  // CLI — how the review agent reports back
  // -------------------------------------------------------------------------
  const usage = [
    "Usage:",
    "  bb code-review context --review <review-id> [--json]",
    "  bb code-review diff    --review <review-id> [--file <path>]",
    "  bb code-review files   --review <review-id>",
    "  bb code-review schema",
    "  bb code-review submit  --review <review-id> --file <path-to-findings.json>",
    "  bb code-review findings --review <review-id>",
    "  bb code-review edit    --review <review-id> --file <path-to-edit.json>",
    "  bb code-review answer  --question <question-id> --file <path-to-answer.json>",
    "",
    'A review id looks like "owner/repo#123". The PR is fetched when the review',
    "starts and served from here, so reviewing needs no network access of its own.",
  ].join("\n");

  function unknownReview(reviewId: string): string {
    return (
      `No review with id ${reviewId}. Start one from the Code Review panel; ` +
      "the id is in the prompt that asked for this review."
    );
  }

  function noSnapshot(reviewId: string): string {
    return (
      `No fetched pull request for ${reviewId}. Re-run the review from the Code ` +
      "Review panel so the plugin can fetch it again."
    );
  }

  /** Trim to the CLI output budget, saying so rather than being rejected. */
  function clamp(text: string): string {
    if (Buffer.byteLength(text, "utf8") <= CLI_OUTPUT_BUDGET) return text;
    return `${text.slice(0, CLI_OUTPUT_BUDGET)}\n\n[truncated — this file's patch is too large to print in full]`;
  }

  function readFlag(argv: string[], name: string): string | null {
    const index = argv.indexOf(`--${name}`);
    if (index !== -1) return argv[index + 1] ?? null;
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    return inline === undefined ? null : inline.slice(name.length + 3);
  }

  /** A file the agent wrote, read on the machine its thread runs on. */
  async function readAgentFile(
    file: string,
    ctx: { threadId?: string; cwd?: string },
  ): Promise<{ ok: true; raw: string; absolute: string } | { ok: false; error: string }> {
    const hostId = await resolveInvokingHostId(ctx.threadId);
    const absolute = path.isAbsolute(file) ? file : path.resolve(ctx.cwd ?? ".", file);
    try {
      const result = await bb.sdk.files.read({ hostId, path: absolute });
      const raw =
        result.contentEncoding === "base64"
          ? Buffer.from(result.content, "base64").toString("utf8")
          : result.content;
      return { ok: true, raw, absolute };
    } catch (error) {
      return {
        ok: false,
        error: `Could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  bb.cli.register({
    name: "code-review",
    summary: "Report pull request review findings back to the Code Review panel",
    commands: [
      {
        name: "context",
        summary:
          "Print the PR's description, discussion, and changed files (no network needed)",
        usage: "bb code-review context --review <owner/repo#123> [--json]",
      },
      {
        name: "diff",
        summary: "Print the PR's diff, or one file of it with --file",
        usage: "bb code-review diff --review <owner/repo#123> [--file <path>]",
      },
      {
        name: "files",
        summary: "List the PR's changed files",
        usage: "bb code-review files --review <owner/repo#123>",
      },
      {
        name: "schema",
        summary: "Print the JSON schema a findings file must match",
        usage: "bb code-review schema",
      },
      {
        name: "submit",
        summary: "Submit a findings JSON file for a review",
        usage: "bb code-review submit --review <owner/repo#123> --file <path>",
      },
      {
        name: "findings",
        summary: "List a review's current findings with their ids, to edit them",
        usage: "bb code-review findings --review <owner/repo#123>",
      },
      {
        name: "edit",
        summary: "Add, change or remove findings in a review already submitted",
        usage: "bb code-review edit --review <owner/repo#123> --file <path>",
      },
      {
        name: "answer",
        summary: "Put the answer to a question about a finding on that issue in the panel",
        usage: "bb code-review answer --question <question-id> --file <path>",
      },
    ],
    async run(argv, ctx) {
      const [command] = argv;
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "schema":
          return { exitCode: 0, stdout: FINDINGS_SCHEMA_TEXT };

        case "context": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const review = getReview(reviewId);
          if (review === null) return { exitCode: 1, stderr: unknownReview(reviewId) };
          if (argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(toReviewDto(review), null, 2) };
          }
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          return { exitCode: 0, stdout: formatContext(reviewId, context.snapshot) };
        }

        case "files": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          const files = context.snapshot.files;
          return {
            exitCode: 0,
            stdout:
              files.length === 0
                ? "This pull request changes no files."
                : files
                    .map((file) => `${file.path}  +${file.additions} -${file.deletions}`)
                    .join("\n"),
          };
        }

        case "diff": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          const wanted = readFlag(argv, "file");
          const patches: FilePatch[] = splitUnifiedDiff(context.diff);
          if (wanted !== null) {
            const match = patches.find((file) => file.path === wanted);
            if (match === undefined) {
              return {
                exitCode: 1,
                stderr: [
                  `${wanted} is not in this pull request's diff. Changed files:`,
                  ...patches.map((file) => `  ${file.path}`),
                ].join("\n"),
              };
            }
            // One pathological file still beats an atomic over-size rejection
            // that would tell the agent nothing at all.
            return { exitCode: 0, stdout: clamp(match.patch) };
          }
          if (Buffer.byteLength(context.diff, "utf8") > CLI_OUTPUT_BUDGET) {
            return { exitCode: 0, stdout: formatFileList(reviewId, patches) };
          }
          return { exitCode: 0, stdout: context.diff };
        }

        case "submit": {
          const reviewId = readFlag(argv, "review");
          const file = readFlag(argv, "file");
          if (reviewId === null || file === null) return { exitCode: 1, stderr: usage };
          const review = getReview(reviewId);
          if (review === null) {
            return { exitCode: 1, stderr: unknownReview(reviewId) };
          }
          const read = await readAgentFile(file, ctx);
          if (!read.ok) return { exitCode: 1, stderr: read.error };
          const { raw, absolute } = read;
          const { report, errors } = parseReport(raw);
          if (report === null) {
            return {
              exitCode: 1,
              stderr:
                `${absolute} is not a valid findings file — ${errors.join("; ")}\n\n` +
                `Expected shape:\n${FINDINGS_SCHEMA_TEXT}`,
            };
          }
          // Enforce full repo-relative paths here, where the agent can still
          // fix them, rather than leaving the panel to resolve them later.
          const snapshot = getContext(reviewId)?.snapshot ?? null;
          if (snapshot !== null && report.findings.length > 0) {
            const repoPaths = await repoTree(reviewId, review.repo, snapshot.headSha);
            const bad = findBadPaths(report.findings, repoPaths);
            if (bad.length > 0) {
              return { exitCode: 1, stderr: formatBadPaths(bad) };
            }
          }
          touchReview(reviewId, { findings_path: absolute });
          const count = importFindings(reviewId, report.findings, report.summary);
          const lines = [
            `Submitted ${count} finding${count === 1 ? "" : "s"} for ${reviewId}.`,
            ...errors.map((problem) => `Warning: ${problem}`),
          ];
          // Dropped findings are a warning, not a failure: the rest are in.
          return { exitCode: 0, stdout: lines.join("\n") };
        }

        case "findings": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          if (getReview(reviewId) === null) return { exitCode: 1, stderr: unknownReview(reviewId) };
          return { exitCode: 0, stdout: formatFindingsForAgent(reviewId) };
        }

        case "edit": {
          const reviewId = readFlag(argv, "review");
          const file = readFlag(argv, "file");
          if (reviewId === null || file === null) return { exitCode: 1, stderr: usage };
          const read = await readAgentFile(file, ctx);
          if (!read.ok) return { exitCode: 1, stderr: read.error };
          try {
            return { exitCode: 0, stdout: await editReport(reviewId, read.raw) };
          } catch (error) {
            return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
          }
        }

        case "answer": {
          const questionId = readFlag(argv, "question");
          const file = readFlag(argv, "file");
          if (questionId === null || file === null) return { exitCode: 1, stderr: usage };
          const read = await readAgentFile(file, ctx);
          if (!read.ok) return { exitCode: 1, stderr: read.error };
          try {
            return { exitCode: 0, stdout: recordAnswer(questionId, read.raw) };
          } catch (error) {
            return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
          }
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // A gh probe at load turns a missing or unauthenticated gh into a visible
  // needs-configuration state instead of a first-click error.
  void checkAuth().catch((error) => {
    if (isNeedsConfigurationError(error)) {
      bb.status.needsConfiguration(error.message);
    } else {
      bb.log.warn(`gh probe failed: ${String(error)}`);
    }
  });

  bb.log.info("loaded");
}
