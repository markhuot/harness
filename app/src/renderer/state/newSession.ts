// The New session modal's POST /tickets body, and the ticket Details' "Skip agent review" hint.
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
  /** A git project whose ticket gets a worktree: the branch pickers show. */
  showBranches: boolean;
  /** null = the default (harness/<key>; the project's / app's base). */
  branch: string | null;
  baseBranch: string | null;
  skipAgentReview: boolean;
}

/**
 * Hidden fields stay out of the body (or null) so the service follows the project: no worktree
 * choice off git, no branches without a worktree, and skipAgentReview only when the switch is on.
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
    ...(f.showBranches ? { branch: f.branch, baseBranch: f.baseBranch } : {}),
    ...(f.skipAgentReview ? { skipAgentReview: true } : {}),
  };
}

/** What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview). */
export function skipReviewHint(t: Pick<Ticket, "status" | "agentReview" | "skipAgentReview">): string {
  if (t.status === "review" && t.skipAgentReview && t.agentReview === "skipped") return "Turning it off starts the agent review now";
  if (t.status === "review" && !t.skipAgentReview && t.agentReview === "pending") return "Turning it on skips the pending agent review";
  return "Goes straight to your review when it's submitted";
}
