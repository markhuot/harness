// Tool registry. toolsForRun() is the single source of truth for which tools a run gets.

import type { RunKind, Ticket } from "@harness/shared";
import type { Driver } from "../drivers/types";
import { getTicket, listInbox, listProjects, listTickets, searchTickets } from "./board";
import {
  browserClick,
  browserCloseTab,
  browserContent,
  browserEval,
  browserKeys,
  browserOpen,
  browserResize,
  browserScreenshot,
  browserSelect,
  browserSnapshot,
  browserTabs,
  browserType,
  browserUpload,
  browserWait,
} from "./browser";
import { browserRun, browserRunStatus, browserRunStop } from "./browser-run";
import { cancelTicket, createTicket, messageTicket, moveTicket, reopenTicket, startTicket, updateTicket } from "./board-write";
import { configReadTools, configWriteTools } from "./config";
import { completeTicket, reviewTicket } from "./conductor";
import { nativeTools, readOnlyNativeTools } from "./native";
import { permissionPrompt } from "./permission";
import { block, editSpec, postNote, readSpec, recordPullRequest, resumeWork, reviewDecision, submitForReview, unblock, updateBranch, updateSpec } from "./ticket";
import { declineWork, dispatchTicket } from "./triage";
import type { ToolDefinition } from "./types";

export * from "./board";
export * from "./board-write";
export * from "./browser";
export * from "./browser-run";
export * from "./conductor";
export * from "./dispatch";
export * from "./config";
export * from "./native";
export * from "./permission";
export * from "./ticket";
export * from "./triage";
export { defineGatedTool, defineTool, validateInput } from "./util";

export const browserTools: ToolDefinition[] = [
  browserOpen,
  browserTabs,
  browserResize,
  browserCloseTab,
  browserContent,
  browserSnapshot,
  browserClick,
  browserType,
  browserKeys,
  browserSelect,
  browserUpload,
  browserEval,
  browserScreenshot,
  browserWait,
  browserRun,
  browserRunStatus,
  browserRunStop,
];
/** Read-only board tools: every run kind gets these (DESIGN.md "Tools"). */
export const boardTools: ToolDefinition[] = [listTickets, getTicket, searchTickets, listProjects, listInbox];
/** Board tools that change other tickets: work and conductor runs only (DESIGN.md "Board changes by agents"). */
export const boardWriteTools: ToolDefinition[] = [createTicket, updateTicket, moveTicket, startTicket, messageTicket, cancelTicket, reopenTicket];
/** Reviewing and completing the caller's own children: work and conductor runs (any ticket may have children). */
export const conductorTools: ToolDefinition[] = [reviewTicket, completeTicket];
export const triageTools: ToolDefinition[] = [dispatchTicket, declineWork];

/** Every tool definition, for lookup/documentation. */
export const allTools: ToolDefinition[] = [
  postNote,
  readSpec,
  editSpec,
  updateSpec,
  block,
  unblock,
  resumeWork,
  submitForReview,
  updateBranch,
  reviewDecision,
  recordPullRequest,
  ...boardTools,
  ...boardWriteTools,
  ...conductorTools,
  ...triageTools,
  ...configReadTools,
  ...configWriteTools,
  ...browserTools,
  permissionPrompt,
  ...nativeTools,
];

// Config reads (watchers, settings, drivers) go to every run kind, like the board reads.
// Config writes, all human-gated, go to work, conductor and chat runs only: plan/review/triage have
// no human in the loop to approve them.

/**
 * Harness tools per run kind (see DESIGN.md "Tools"), plus which native set the
 * kind gets when the driver has no built-in tools:
 *  - "full": bash, read_file, write_file, edit_file, list_files
 *  - "read": read_file, list_files, bash (review; also plan and conductor, which
 *    shouldn't edit the tree: plan runs are read-only in claude-code's plan mode too,
 *    and a conductor's children work in the same checkout)
 *  - "none": triage only routes work
 * A plan run's update_ticket edits only its own ticket (the orchestrator checks).
 * A chat (a human's message to a blocked, review or done ticket) gets its ticket's work tools:
 * see toolsForRun.
 */
/**
 * The spec tools (DESIGN.md "Spec revisions and attachments"): plan, work, chat, conductor and
 * complete runs. Review runs read it and edit_spec it (to record what the review found), but never
 * replace it whole.
 */
export const specTools: ToolDefinition[] = [readSpec, editSpec, updateSpec];

const RUN_TOOLS: Record<Exclude<RunKind, "chat">, { harness: ToolDefinition[]; native: "full" | "read" | "none" }> = {
  plan: { harness: [postNote, ...specTools, updateTicket, ...boardTools, ...configReadTools, ...browserTools], native: "read" },
  work: {
    harness: [postNote, ...specTools, block, unblock, resumeWork, submitForReview, updateBranch, ...boardTools, ...boardWriteTools, ...conductorTools, ...configReadTools, ...configWriteTools, ...browserTools],
    native: "full",
  },
  review: { harness: [postNote, readSpec, editSpec, reviewDecision, ...boardTools, ...configReadTools, ...browserTools], native: "read" },
  complete: { harness: [postNote, ...specTools, recordPullRequest, ...boardTools, ...configReadTools], native: "full" },
  conductor: {
    harness: [postNote, ...specTools, unblock, resumeWork, submitForReview, updateBranch, ...boardTools, ...boardWriteTools, ...conductorTools, ...configReadTools, ...configWriteTools, ...browserTools],
    native: "read",
  },
  triage: { harness: [...boardTools, ...triageTools, ...configReadTools], native: "none" },
};

/**
 * permission_prompt is added for every run kind of a driver with usesPermissionPromptTool:
 * requestApproval decides per kind (review/plan/triage are denied with guidance). A chat run gets
 * the same tools as its ticket's work runs (a conductor ticket's: the conductor tools).
 */
export function toolsForRun(
  kind: RunKind,
  driver: Pick<Driver, "hasBuiltinTools" | "usesPermissionPromptTool">,
  ticket: Pick<Ticket, "kind"> | null = null,
): ToolDefinition[] {
  const entry = kind === "chat" ? RUN_TOOLS[ticket?.kind === "conductor" ? "conductor" : "work"] : RUN_TOOLS[kind as Exclude<RunKind, "chat">];
  if (!entry) throw new Error(`Unknown run kind: ${kind}`);
  const tools = [...entry.harness];
  if (driver.usesPermissionPromptTool) tools.push(permissionPrompt);
  if (driver.hasBuiltinTools || entry.native === "none") return tools;
  return [...tools, ...(entry.native === "full" ? nativeTools : readOnlyNativeTools)];
}
