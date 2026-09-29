// Ticket-lifecycle tools used by plan / work / review / complete / conductor runs.

import { ALLOWED_EXTENSIONS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../attachments";
import { defineTool, schema } from "./util";

const attachmentsProp = {
  type: "array",
  items: { type: "string" },
  description: `Image or video files that show the result, e.g. ["shots/after.png"]: absolute paths or paths relative to your working directory. At most ${MAX_ATTACHMENTS}, each up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB; ${ALLOWED_EXTENSIONS.join(", ")}. They are copied when the summary is posted.`,
};

const attached = (n: number) => (n === 0 ? "" : n === 1 ? " with 1 attachment" : ` with ${n} attachments`);

export const postSummary = defineTool<{ summary: string; attachments?: string[] }>({
  name: "post_summary",
  description:
    "Post a short progress or result summary on the current ticket. Humans read these on the board instead of the full transcript, so keep it to a few lines of markdown: what changed, what state things are in, what is next. Attach screenshots or a short screen recording when the work has a visible result. Does not change the ticket status.",
  inputSchema: schema(
    {
      summary: { type: "string", minLength: 1, description: "Markdown summary, e.g. \"Implemented X; tests pass; next: Y\"." },
      attachments: attachmentsProp,
    },
    ["summary"],
  ),
  async run({ summary, attachments }, ctx) {
    await ctx.ops.postSummary(ctx, summary, attachments);
    return `Summary posted${attached(attachments?.length ?? 0)}.`;
  },
});

export const updatePlan = defineTool<{ plan: string; title?: string }>({
  name: "update_plan",
  description:
    "Replace the ticket's plan (its brief/description) with a new plan in markdown. Include the full plan every time, not a diff: goal, approach, numbered steps, and open questions. Optionally set a clearer ticket title. The human reviews this plan before work starts.",
  inputSchema: schema(
    {
      plan: { type: "string", minLength: 1, description: "The complete plan in markdown. Replaces the current description." },
      title: { type: "string", minLength: 1, description: "Optional new short ticket title (under ~80 characters)." },
    },
    ["plan"],
  ),
  async run({ plan, title }, ctx) {
    await ctx.ops.updatePlan(ctx, plan, title);
    return title ? `Plan updated and ticket retitled to "${title}".` : "Plan updated.";
  },
});

export const block = defineTool<{ question: string }>({
  name: "block",
  description:
    "Stop and ask the human a question when you cannot continue without their input (missing requirements, credentials, a decision only they can make). Moves the ticket to the Blocked column with your question. The human's answer arrives as a new message in a later run. Do not call this for things you can find out yourself.",
  inputSchema: schema(
    { question: { type: "string", minLength: 1, description: "The specific question for the human, with enough context to answer it without reading the transcript." } },
    ["question"],
  ),
  async run({ question }, ctx) {
    await ctx.ops.block(ctx, question);
    return "Ticket moved to blocked; the human will answer in a later message. Stop here.";
  },
});

export const submitForReview = defineTool<{ summary: string; attachments?: string[]; skip_agent_review?: boolean }>({
  name: "submit_for_review",
  description:
    "Call this when the work is complete. Moves the ticket to Review and posts your summary. The summary should say what you changed, how you verified it (tests, commands run), and anything the reviewer should look at closely. When the work has a visible result (a UI change, rendered output, a browser flow), attach screenshots or a short screen recording that show it. Make no further changes after calling it.",
  inputSchema: schema(
    {
      summary: { type: "string", minLength: 1, description: "Markdown summary of the finished work and how it was verified." },
      attachments: attachmentsProp,
      skip_agent_review: {
        type: "boolean",
        description:
          "Skip the independent agent review, so the ticket waits only on the human. Pass true when the human asked for no agent review, or when the request was conversational and you changed no files (an answer in text leaves a reviewer nothing to check). Refused when the project doesn't require a human review. Omit it to keep the ticket's setting.",
      },
    },
    ["summary"],
  ),
  async run({ summary, attachments, skip_agent_review }, ctx) {
    await ctx.ops.submitForReview(ctx, summary, attachments, skip_agent_review);
    return "Ticket moved to review. Stop here.";
  },
});

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
