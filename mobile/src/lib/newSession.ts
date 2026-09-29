// The New session screen's POST /tickets body, and the Details tab's "Skip agent review" hint.
import type { CreateTicketBody, PermissionMode, Ticket, TicketKind } from "@harness/shared";

export interface NewSessionForm {
  projectId: string;
  prompt: string;
  start: boolean;
  kind: TicketKind;
  driver: string | undefined;
  model: string | null;
  permissionMode: PermissionMode | null;
  /** The project is (or may be) a git repo, so the Use worktree switch shows. */
  canWorktree: boolean;
  worktree: boolean;
  /** A git project whose ticket gets a worktree: the Branch picker shows. */
  showBranch: boolean;
  branch: string | null;
  isGit: boolean;
  base: string;
  skipAgentReview: boolean;
}

/**
 * Hidden fields stay out of the body (or null) so the service follows the project: no worktree
 * choice off git, no branch without a worktree, no base branch off git, and skipAgentReview only
 * when the switch is on.
 */
export function newSessionBody(f: NewSessionForm): CreateTicketBody {
  return {
    projectId: f.projectId,
    prompt: f.prompt.trim(),
    start: f.start,
    kind: f.kind,
    driver: f.driver,
    model: f.model,
    permissionMode: f.permissionMode,
    useWorktree: f.canWorktree ? f.worktree : null,
    branch: f.showBranch ? f.branch : undefined,
    baseBranch: f.isGit ? f.base.trim() || null : undefined,
    ...(f.skipAgentReview ? { skipAgentReview: true } : {}),
  };
}

/** What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview). */
export function skipReviewHint(t: Pick<Ticket, "status" | "agentReview" | "skipAgentReview">): string {
  if (t.status === "review" && t.skipAgentReview && t.agentReview === "skipped") return "Off starts the review";
  if (t.status === "review" && !t.skipAgentReview && t.agentReview === "pending") return "On skips the pending review";
  return "When it's submitted";
}
