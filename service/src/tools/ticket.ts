// Ticket-lifecycle tools used by plan / work / review / complete / conductor runs.

import { defineTool, schema } from "./util";

export const postSummary = defineTool<{ summary: string }>({
  name: "post_summary",
  description:
    "Post a short progress or result summary on the current ticket. Humans read these on the board instead of the full transcript, so keep it to a few lines of markdown: what changed, what state things are in, what is next. Does not change the ticket status.",
  inputSchema: schema(
    { summary: { type: "string", minLength: 1, description: "Markdown summary, e.g. \"Implemented X; tests pass; next: Y\"." } },
    ["summary"],
  ),
  async run({ summary }, ctx) {
    await ctx.ops.postSummary(ctx, summary);
    return "Summary posted.";
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

export const submitForReview = defineTool<{ summary: string }>({
  name: "submit_for_review",
  description:
    "Call this when the work is complete. Moves the ticket to Review and posts your summary. The summary should say what you changed, how you verified it (tests, commands run), and anything the reviewer should look at closely. Make no further changes after calling it.",
  inputSchema: schema(
    { summary: { type: "string", minLength: 1, description: "Markdown summary of the finished work and how it was verified." } },
    ["summary"],
  ),
  async run({ summary }, ctx) {
    await ctx.ops.submitForReview(ctx, summary);
    return "Ticket moved to review. Stop here.";
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
