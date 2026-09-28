// Tool registry. toolsForRun() is the single source of truth for which tools a run gets.

import type { RunKind } from "@harness/shared";
import type { Driver } from "../drivers/types";
import { getTicket, listInbox, listProjects, listTickets, searchTickets } from "./board";
import { browserClick, browserContent, browserEval, browserOpen, browserScreenshot, browserType } from "./browser";
import { cancelTicket, createTicket, messageTicket, moveTicket, reopenTicket, startTicket, updateTicket } from "./board-write";
import { configReadTools, configWriteTools } from "./config";
import { completeTicket, reviewTicket } from "./conductor";
import { nativeTools, readOnlyNativeTools } from "./native";
import { permissionPrompt } from "./permission";
import { block, postSummary, reviewDecision, submitForReview, updatePlan } from "./ticket";
import { declineWork, dispatchTicket } from "./triage";
import type { ToolDefinition } from "./types";

export * from "./board";
export * from "./board-write";
export * from "./browser";
export * from "./conductor";
export * from "./config";
export * from "./native";
export * from "./permission";
export * from "./ticket";
export * from "./triage";
export { defineGatedTool, defineTool, validateInput } from "./util";

export const browserTools: ToolDefinition[] = [browserOpen, browserContent, browserClick, browserType, browserEval, browserScreenshot];
/** Read-only board tools: every run kind gets these (DESIGN.md "Tools"). */
export const boardTools: ToolDefinition[] = [listTickets, getTicket, searchTickets, listProjects, listInbox];
/** Board tools that change other tickets: work and conductor runs only (DESIGN.md "Board changes by agents"). */
export const boardWriteTools: ToolDefinition[] = [createTicket, updateTicket, moveTicket, startTicket, messageTicket, cancelTicket, reopenTicket];
export const conductorTools: ToolDefinition[] = [reviewTicket, completeTicket];
export const triageTools: ToolDefinition[] = [dispatchTicket, declineWork];

/** Every tool definition, for lookup/documentation. */
export const allTools: ToolDefinition[] = [
  postSummary,
  updatePlan,
  block,
  submitForReview,
  reviewDecision,
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
// Config writes, all human-gated, go to work and conductor runs only: plan/review/triage have no
// human in the loop to approve them.

/**
 * Harness tools per run kind (see DESIGN.md "Tools"), plus which native set the
 * kind gets when the driver has no built-in tools:
 *  - "full": bash, read_file, write_file, edit_file, list_files
 *  - "read": read_file, list_files, bash (review and chat; also plan and conductor, which
 *    shouldn't edit the tree: plan runs are read-only in claude-code's plan mode too,
 *    and a conductor's children work in the same checkout)
 *  - "none": triage only routes work
 */
const RUN_TOOLS: Record<RunKind, { harness: ToolDefinition[]; native: "full" | "read" | "none" }> = {
  plan: { harness: [postSummary, updatePlan, ...boardTools, ...configReadTools, ...browserTools], native: "read" },
  work: { harness: [postSummary, block, submitForReview, ...boardTools, ...boardWriteTools, ...configReadTools, ...configWriteTools, ...browserTools], native: "full" },
  review: { harness: [postSummary, reviewDecision, ...boardTools, ...configReadTools, ...browserTools], native: "read" },
  complete: { harness: [postSummary, ...boardTools, ...configReadTools], native: "full" },
  conductor: {
    harness: [postSummary, submitForReview, ...boardTools, ...boardWriteTools, ...conductorTools, ...configReadTools, ...configWriteTools, ...browserTools],
    native: "read",
  },
  triage: { harness: [...boardTools, ...triageTools, ...configReadTools], native: "none" },
  chat: { harness: [postSummary, ...boardTools, ...configReadTools, ...browserTools], native: "read" },
};

/**
 * permission_prompt is added for every run kind of a driver with usesPermissionPromptTool:
 * requestApproval decides per kind (review/plan/triage are denied with guidance).
 */
export function toolsForRun(kind: RunKind, driver: Pick<Driver, "hasBuiltinTools" | "usesPermissionPromptTool">): ToolDefinition[] {
  const entry = RUN_TOOLS[kind];
  if (!entry) throw new Error(`Unknown run kind: ${kind}`);
  const tools = [...entry.harness];
  if (driver.usesPermissionPromptTool) tools.push(permissionPrompt);
  if (driver.hasBuiltinTools || entry.native === "none") return tools;
  return [...tools, ...(entry.native === "full" ? nativeTools : readOnlyNativeTools)];
}
