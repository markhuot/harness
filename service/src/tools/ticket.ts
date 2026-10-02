// Ticket-lifecycle tools used by plan / work / review / complete / conductor / chat runs.

import { ALLOWED_EXTENSIONS, MAX_ATTACHMENT_BYTES } from "../attachments";
import { defineTool, schema } from "./util";

/** What the spec tools say about images: the same files the attachments accept. */
const IMAGES = `Images and videos: write them as markdown images pointing at local files, e.g. ![After](shots/after.png) (absolute, or relative to your working directory; ${ALLOWED_EXTENSIONS.join(", ")}, each up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB). The harness stores each file and rewrites its src to attachment:<id>; leave attachment: and https: srcs as they are.`;

export const postNote = defineTool<{ note: string }>({
  name: "post_note",
  description:
    "Add a short note to the ticket's Activity: at most three short lines on what changed since your last note or submit, without repeating the spec or earlier activity. The spec holds the full current state; keep it current with edit_spec. Does not change the ticket status.",
  inputSchema: schema({ note: { type: "string", minLength: 1, description: 'Markdown, at most three short lines, e.g. "Fixed the retry backoff; `bun test` passes."' } }, ["note"]),
  async run({ note }, ctx) {
    await ctx.ops.postNote(ctx, note);
    return "Note added to Activity.";
  },
});

export const readSpec = defineTool<{ revision?: number }>({
  name: "read_spec",
  description:
    "Read the ticket's spec: its revision number, then the text with line numbers (like Read). edit_spec takes that revision as base_revision and those line numbers. Pass revision to read an earlier one.",
  inputSchema: schema({ revision: { type: "integer", minimum: 1, description: "An earlier revision to read; omit for the current one." } }),
  async run({ revision }, ctx) {
    return ctx.ops.readSpec(ctx, revision);
  },
});

export const editSpec = defineTool<{ base_revision: number; note: string; edits: unknown[] }>({
  name: "edit_spec",
  description: `Change parts of the ticket's spec, like Edit: every edit applies or none does, and the result is a new revision. base_revision is the revision you read (read_spec); if the spec has moved on since (a human edited it), the call fails with the current revision, so read it again and redo the edits. Two edit forms:
* { old_string, new_string, replace_all? }: old_string must match the spec exactly and be unique unless replace_all is true.
* { start_line, end_line, new_text, expected? }: replace lines start_line-end_line (inclusive, numbered as in base_revision, even after earlier edits in the same call) with new_text; end_line = start_line - 1 inserts before start_line, and new_text "" deletes the lines. expected, when given, must equal those lines' current text.
Change only what changed: the spec's history keeps the earlier revisions. ${IMAGES}`,
  inputSchema: schema(
    {
      base_revision: { type: "integer", minimum: 1, description: "The revision your edits are based on (from read_spec)." },
      note: { type: "string", minLength: 1, description: 'A few words on what changed, kept with the revision, e.g. "Status: retry fixed, tests pass".' },
      edits: {
        type: "array",
        minItems: 1,
        description: "The edits, applied in order.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Its replacement." },
            replace_all: { type: "boolean", description: "Replace every occurrence of old_string." },
            start_line: { type: "integer", minimum: 1, description: "First line to replace (base_revision numbering)." },
            end_line: { type: "integer", minimum: 0, description: "Last line to replace, inclusive; start_line - 1 to insert." },
            new_text: { type: "string", description: "The lines that replace them." },
            expected: { type: "string", description: "The current text of those lines, as a check." },
          },
        },
      },
    },
    ["base_revision", "note", "edits"],
  ),
  async run({ base_revision, note, edits }, ctx) {
    return ctx.ops.editSpec(ctx, { baseRevision: base_revision, note, edits });
  },
});

export const updateSpec = defineTool<{ spec: string; note: string; base_revision: number; title?: string }>({
  name: "update_spec",
  description: `Replace the ticket's whole spec with new markdown, as a new revision: mostly for planning, when you write the spec from the brief. Include everything worth keeping, since it replaces the text. For later changes use edit_spec, which changes only the parts that changed. base_revision is the revision you read (the run's context names the current one); a spec that moved on since fails the call with the current revision. Optionally set a clearer ticket title. ${IMAGES}`,
  inputSchema: schema(
    {
      spec: { type: "string", minLength: 1, description: "The complete spec in markdown: Goal, Plan, Status, Open questions." },
      note: { type: "string", minLength: 1, description: 'A few words on what changed, kept with the revision, e.g. "Plan drafted".' },
      base_revision: { type: "integer", minimum: 1, description: "The revision you're replacing (from read_spec or the run's context)." },
      title: { type: "string", minLength: 1, description: "Optional new short ticket title (under ~80 characters)." },
    },
    ["spec", "note", "base_revision"],
  ),
  async run({ spec, note, base_revision, title }, ctx) {
    return ctx.ops.updateSpec(ctx, { spec, note, baseRevision: base_revision, title });
  },
});

export const block = defineTool<{ question: string }>({
  name: "block",
  description:
    "Stop and ask the human a question when you cannot continue without their input (missing requirements, credentials, a decision only they can make). Moves the ticket to the Blocked column with your question. The human's answer arrives as a new message in a later run; when it resolves the block, call unblock and carry on. Do not call this for things you can find out yourself.",
  inputSchema: schema(
    { question: { type: "string", minLength: 1, description: "The specific question for the human, with enough context to answer it without reading the transcript." } },
    ["question"],
  ),
  async run({ question }, ctx) {
    await ctx.ops.block(ctx, question);
    return "Ticket moved to blocked; the human will answer in a later message. Stop here.";
  },
});

export const unblock = defineTool<{ note?: string }>({
  name: "unblock",
  description:
    "Move your blocked ticket back to In progress. Call it as soon as the human's message resolves what the ticket was blocked on, before you continue the work, so the board shows the ticket being worked on. Then finish with submit_for_review, or block again with a new question. Don't call it when their message doesn't resolve the block (a side question, say): answer it and leave the ticket blocked. Refused unless the ticket is blocked, and while a tool approval is waiting on the human.",
  inputSchema: schema({ note: { type: "string", description: "Optional: what resolved the block, shown on the ticket's timeline." } }, []),
  async run({ note }, ctx) {
    await ctx.ops.unblock(ctx, note);
    return "Ticket moved to in progress. Carry on with the work, then call submit_for_review (or block with a new question).";
  },
});

export const resumeWork = defineTool<{ note?: string }>({
  name: "resume_work",
  description:
    "Move your ticket from Review back to In progress, because you're about to change the work again: editing code, fixing a bug, adding to what was submitted. Call it before you start, so the board shows the ticket being worked on; it stops a running agent review and both reviews start over. Then finish with submit_for_review (or block). It's your call: answering a question, explaining the work or a tiny fix you resubmit right away doesn't need it. Refused unless the ticket is in review, and while a tool approval is waiting on the human.",
  inputSchema: schema({ note: { type: "string", description: "Optional: why the work is picked back up, shown on the ticket's timeline." } }, []),
  async run({ note }, ctx) {
    await ctx.ops.resumeWork(ctx, note);
    return "Ticket moved to in progress. Make the changes, then call submit_for_review (or block with a question).";
  },
});

const submitTool = defineTool<{ note: string; spec_is_up_to_date?: unknown; skip_agent_review?: boolean; skip_human_review?: boolean }>({
  name: "submit_for_review",
  description:
    "Call this when the work is complete, after you brought the spec up to date in an earlier call (edit_spec or update_spec: Status, decisions, verification, screenshots). Moves the ticket to Review with a short note on this round only: what changed since the last submit, not a recap of the spec. Make no further changes after calling it.",
  inputSchema: schema(
    {
      note: { type: "string", minLength: 1, description: "This round only, at most three short lines: what changed and how you verified it." },
      spec_is_up_to_date: {
        type: "boolean",
        description: "Required, and must be true: the spec already describes the finished work (its Status, decisions, verification and screenshots). Bring it up to date with edit_spec or update_spec first.",
      },
      skip_agent_review: {
        type: "boolean",
        description:
          "Skip the independent agent review, so the ticket waits only on the human. Pass true when the human asked for no agent review, or when the request was conversational and you changed no files (an answer in text leaves a reviewer nothing to check). When the ticket skips its human review too, the work lands as soon as you submit, so pass true then only when the human asked for that. Omit it to keep the ticket's setting.",
      },
      skip_human_review: {
        type: "boolean",
        description:
          "Skip the human review, so the work lands as soon as the agent review approves it. Pass true only when the human asked for that (for example \"merge it once the review passes\" or \"no need for me to look\"). When the ticket skips its agent review too, the work lands as soon as you submit. Omit it to keep the ticket's setting.",
      },
    },
    ["note"],
  ),
  async run({ note, spec_is_up_to_date, skip_agent_review, skip_human_review }, ctx) {
    await ctx.ops.submitForReview(ctx, note, spec_is_up_to_date, { skipAgentReview: skip_agent_review, skipHumanReview: skip_human_review });
    return "Ticket moved to review. Stop here.";
  },
});

/**
 * spec_is_up_to_date is advertised as required, so models always pass it, but validated by
 * submitForReview rather than the schema check: a missing or false value gets the message that
 * says what to do (bring the spec up to date first), not a generic "is required".
 */
export const submitForReview = { ...submitTool, inputSchema: { ...submitTool.inputSchema, required: ["note", "spec_is_up_to_date"] } };

export const updateBranch = defineTool<{ branch?: string; base_branch?: string }>({
  name: "update_branch",
  description:
    "Change this ticket's own branches (update_ticket can't act on your own ticket). branch re-points the ticket to another branch: when that branch is checked out in another worktree, the ticket moves into that worktree (your next run works there; integrate your commits there first, e.g. with git -C <path> cherry-pick or merge); otherwise this ticket's worktree switches to it, creating it at the current commit when it doesn't exist (refused with git's message when uncommitted changes are in the way). base_branch sets the branch the work merges into when the ticket completes (\"inherit\" or \"\" uses the project's). Never deletes a branch or worktree: the old ones are left for cleanup.",
  inputSchema: schema({
    branch: { type: "string", minLength: 1, description: "Branch name to move the ticket to, e.g. \"medl-1223-ai-app\"." },
    base_branch: { type: "string", description: "Branch to merge into on completion; \"inherit\" or \"\" uses the project's base branch." },
  }),
  async run({ branch, base_branch }, ctx) {
    return ctx.ops.updateBranch(ctx, {
      branch,
      baseBranch: base_branch === undefined ? undefined : base_branch.trim() === "inherit" ? null : base_branch.trim() || null,
    });
  },
});

export const reviewDecision = defineTool<{ decision: "approve" | "request_changes"; notes: string }>({
  name: "review_decision",
  description:
    "Record your review verdict on the ticket's work. \"approve\" if the change does what the ticket asks and is correct; \"request_changes\" sends the ticket back to the implementing agent with your notes. Notes should be specific and actionable (file, problem, expected fix). Call exactly once, as your final action.",
  inputSchema: schema(
    {
      decision: { type: "string", enum: ["approve", "request_changes"], description: "Your verdict." },
      notes: { type: "string", description: "Review notes. Required detail when requesting changes; a short rationale when approving." },
    },
    ["decision", "notes"],
  ),
  async run({ decision, notes }, ctx) {
    await ctx.ops.reviewDecision(ctx, decision, notes);
    return decision === "approve"
      ? "Review recorded: approved. Stop here."
      : "Review recorded: changes requested. The ticket goes back to the implementer. Stop here.";
  },
});

export const recordPullRequest = defineTool<{ url: string }>({
  name: "record_pull_request",
  description:
    "Record the pull request this completion opened or updated, e.g. https://github.com/acme/web/pull/42. Only for completion runs that land the work as a pull request: the ticket moves to done only once one is recorded, and the board links to it.",
  inputSchema: schema({ url: { type: "string", minLength: 1, description: "The pull request's link, as gh printed it." } }, ["url"]),
  async run({ url }, ctx) {
    return ctx.ops.recordPullRequest(ctx, url);
  },
});
