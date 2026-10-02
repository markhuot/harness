// The exported constants and helpers of shared/src/protocol.ts, as the Swift port
// (HarnessKit/Protocol/HarnessProtocol.swift) must reproduce them.
import {
  CLASSIFIER_BACKENDS,
  COMPLETION_ACTIONS,
  DEFAULT_PORT,
  isConductor,
  LISTEN_MODES,
  PERMISSION_MODES,
  PROMPT_IDS,
  RENAMED_PROMPT_IDS,
  reviewPassed,
  TICKET_STATUSES,
  type Ticket,
} from "../../src/protocol";
import { cases } from "../case";

export const constants = {
  DEFAULT_PORT,
  PERMISSION_MODES,
  CLASSIFIER_BACKENDS,
  TICKET_STATUSES,
  COMPLETION_ACTIONS,
  PROMPT_IDS,
  RENAMED_PROMPT_IDS,
  LISTEN_MODES,
};

export const reviewPassedCases = cases(reviewPassed, {
  pending: "pending",
  approved: "approved",
  "changes requested": "changes_requested",
  skipped: "skipped",
});

export const isConductorCases = cases((t: Pick<Ticket, "kind" | "childCount">) => isConductor(t), {
  "task without childCount (older service)": { kind: "task" },
  "task with no children": { kind: "task", childCount: 0 },
  "task with one child": { kind: "task", childCount: 1 },
  "task with many children": { kind: "task", childCount: 12 },
  "conductor without childCount": { kind: "conductor" },
  "conductor with no children yet": { kind: "conductor", childCount: 0 },
  "conductor with children": { kind: "conductor", childCount: 3 },
});
