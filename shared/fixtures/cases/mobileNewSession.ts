// The "Skip agent review" hint (mobile/src/lib/newSession.ts) for HarnessKit's State/NewSession.swift.
import type * as P from "../../src/protocol";
import { skipReviewHint } from "../../../mobile/src/lib/newSession";
import { cases } from "../case";

type In = { status: P.TicketStatus; agentReview: P.ReviewState; skipAgentReview?: boolean };

export const skipReviewHintCases = cases((t: In) => skipReviewHint(t), {
  "review, skipped, on: off starts it": { status: "review", agentReview: "skipped", skipAgentReview: true },
  "review, pending, off: on skips it": { status: "review", agentReview: "pending", skipAgentReview: false },
  "review, pending, missing flag: on skips it": { status: "review", agentReview: "pending" },
  "review, approved": { status: "review", agentReview: "approved", skipAgentReview: false },
  "review, changes requested": { status: "review", agentReview: "changes_requested", skipAgentReview: false },
  "review, skipped, flag off": { status: "review", agentReview: "skipped", skipAgentReview: false },
  "review, pending, flag on": { status: "review", agentReview: "pending", skipAgentReview: true },
  "in progress, pending": { status: "in_progress", agentReview: "pending", skipAgentReview: false },
  "in progress, skipped, on": { status: "in_progress", agentReview: "skipped", skipAgentReview: true },
  "planning, pending": { status: "planning", agentReview: "pending" },
  "done, skipped, on": { status: "done", agentReview: "skipped", skipAgentReview: true },
});
