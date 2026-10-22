import { activity, entry, run, session } from "./build";
import { tickets } from "./tickets";
import { hoursAgo, minutesAgo } from "./time";

/** One session per ticket. */
export const sessions = [
  ...tickets.map((t) => session({ key: t.key, kind: "ticket", busy: t.busy, cwd: t.workdir ?? "/Users/dev/harness", updatedAt: t.updatedAt })),
];

export const runs = [
  run({ id: "run-HARNESS-2-plan", sessionId: "session-HARNESS-2", kind: "plan", status: "succeeded", createdAt: hoursAgo(30), startedAt: hoursAgo(30), endedAt: hoursAgo(29), model: "claude-opus-5-5", inputTokens: 40_000, outputTokens: 6_000, costUsd: 0.62 }),
  run({ id: "run-HARNESS-2-work", sessionId: "session-HARNESS-2", kind: "work", status: "running", createdAt: minutesAgo(25), startedAt: minutesAgo(25), model: "claude-opus-5-5", inputTokens: 210_000, outputTokens: 9_400, costUsd: 1.87 }),
  run({ id: "run-HARNESS-5-work", sessionId: "session-HARNESS-5", kind: "work", status: "succeeded", createdAt: hoursAgo(4), startedAt: hoursAgo(4), endedAt: hoursAgo(2), model: "claude-sonnet-5-5", inputTokens: 90_000, outputTokens: 12_000, costUsd: 0.74 }),
  run({ id: "run-HARNESS-5-review", sessionId: "session-HARNESS-5", kind: "review", status: "succeeded", createdAt: minutesAgo(40), startedAt: minutesAgo(40), endedAt: minutesAgo(16), model: "claude-opus-5-5" }),
  run({ id: "run-HARNESS-6-work", sessionId: "session-HARNESS-6", kind: "work", status: "failed", error: "The agent exited with code 1", createdAt: hoursAgo(5), startedAt: hoursAgo(5), endedAt: hoursAgo(4) }),
  run({ id: "run-WEB-2-work", sessionId: "session-WEB-2", kind: "work", status: "running", createdAt: minutesAgo(9), startedAt: minutesAgo(9), model: "claude-sonnet-5-5" }),
];

const S2 = "session-HARNESS-2";
export const transcript = [
  entry({ id: "tr-1", sessionId: S2, runId: "run-HARNESS-2-work", seq: 1, role: "user", content: { type: "text", text: "The socket doesn't reconnect after the laptop sleeps. Please fix it." } }),
  entry({ id: "tr-2", sessionId: S2, runId: "run-HARNESS-2-work", seq: 2, role: "assistant", content: { type: "thinking", text: "The reconnect timer is cleared on close, so a sleep that drops the socket never schedules a retry." } }),
  entry({ id: "tr-3", sessionId: S2, runId: "run-HARNESS-2-work", seq: 3, role: "assistant", content: { type: "text", text: "I'll look at how the socket schedules its retries." } }),
  entry({ id: "tr-4", sessionId: S2, runId: "run-HARNESS-2-work", seq: 4, role: "tool", content: { type: "tool_call", callId: "call-1", name: "Read", input: { file_path: "shared/src/client.ts" } } }),
  entry({ id: "tr-5", sessionId: S2, runId: "run-HARNESS-2-work", seq: 5, role: "tool", content: { type: "tool_result", callId: "call-1", name: "Read", output: [{ type: "text", text: "class HarnessSocket { /* … */ }" }], isError: false } }),
  entry({ id: "tr-6", sessionId: S2, runId: "run-HARNESS-2-work", seq: 6, role: "assistant", content: { type: "text", text: "The retry is only scheduled from `onclose`; I'll also schedule it when the ping goes unanswered." } }),
  entry({ id: "tr-7", sessionId: S2, runId: "run-HARNESS-2-work", seq: 7, role: "system", content: { type: "status", text: "Run started (work)" } }),
  entry({ id: "tr-8", sessionId: S2, runId: "run-HARNESS-2-work", seq: 8, role: "tool", content: { type: "tool_result", callId: "call-2", name: "Bash", output: [{ type: "text", text: "bun test: 3 failed" }], isError: true } }),
  entry({ id: "tr-9", sessionId: S2, runId: "run-HARNESS-2-work", seq: 9, role: "system", content: { type: "error", text: "The test run reported failures" } }),
];

const S5 = "session-HARNESS-5";
/** A finished run's transcript on a ticket nothing is working on, so screens that show it hold still (no "Working…" spinner). */
export const finishedTranscript = [
  entry({ id: "tr5-1", sessionId: S5, runId: "run-HARNESS-5-work", seq: 1, role: "user", content: { type: "text", text: "The board takes two seconds to paint on a cold start. Can you cache the first page?" } }),
  entry({ id: "tr5-2", sessionId: S5, runId: "run-HARNESS-5-work", seq: 2, role: "assistant", content: { type: "text", text: "I'll keep the last page of tickets on disk and paint it before the socket connects." } }),
  entry({ id: "tr5-3", sessionId: S5, runId: "run-HARNESS-5-work", seq: 3, role: "tool", content: { type: "tool_call", callId: "c5-1", name: "Edit", input: { file_path: "src/board.ts" } } }),
  entry({ id: "tr5-4", sessionId: S5, runId: "run-HARNESS-5-work", seq: 4, role: "tool", content: { type: "tool_result", callId: "c5-1", name: "Edit", output: [{ type: "text", text: "Edited src/board.ts" }], isError: false } }),
  entry({ id: "tr5-5", sessionId: S5, runId: "run-HARNESS-5-work", seq: 5, role: "assistant", content: { type: "text", text: "Done: the board now paints from the cache, then refreshes when the socket connects." } }),
];

export const activityLog = [
  activity({ id: "act-1", ticketId: "ticket-HARNESS-5", kind: "submitted", author: "agent", body: "Cached the first page of tickets; the board now paints before the socket connects.", createdAt: minutesAgo(45), meta: { round: 1, commit: "a1b2c3d" } }),
  activity({ id: "act-2", ticketId: "ticket-HARNESS-5", kind: "review_approved", author: "agent", body: "The review found nothing to change.", createdAt: minutesAgo(16) }),
  activity({ id: "act-3", ticketId: "ticket-HARNESS-6", kind: "changes_requested", author: "human", body: "The palette should keep its query when it reopens.", createdAt: minutesAgo(70) }),
  activity({ id: "act-4", ticketId: "ticket-HARNESS-4", kind: "blocked", author: "agent", body: "Postgres or SQLite for the hosted tier?", createdAt: minutesAgo(25), meta: { question: "Postgres or SQLite for the hosted tier?" } }),
  activity({ id: "act-5", ticketId: "ticket-HARNESS-7", kind: "approved", author: "human", body: "Merged into main.", createdAt: hoursAgo(5), meta: { by: "human" } }),
  activity({ id: "act-6", ticketId: "ticket-HARNESS-2", kind: "note", author: "agent", body: "Reproduced the missed reconnect with a paused socket.", createdAt: minutesAgo(12) }),
];
