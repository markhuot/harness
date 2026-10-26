import { describe, expect, test } from "bun:test";
import { blockedCallout } from "../../../app/src/renderer/state/blockedCallout";
import { makeTicket } from "../../builders/ticket";

const blocked = (o = {}) => makeTicket({ status: "blocked", blockedReason: "  Postgres or SQLite?\n", ...o });

describe("blockedCallout", () => {
  test("only a blocked ticket has one", () => {
    expect(blockedCallout(makeTicket({ status: "in_progress", blockedReason: "stale" }))).toEqual({ kind: "none" });
    expect(blockedCallout(blocked({ draft: true }))).toEqual({ kind: "none" });
  });
  test("a block waiting on the human shows the trimmed question and offers Unblock", () => {
    expect(blockedCallout(blocked())).toEqual({ kind: "question", question: "Postgres or SQLite?", unblock: true });
  });
  test("a block with no reason still shows, with Unblock", () => {
    expect(blockedCallout(blocked({ blockedReason: null }))).toEqual({ kind: "question", question: "", unblock: true });
  });
  test("a block while a run is going shows the question without Unblock", () => {
    expect(blockedCallout(blocked({ busy: true }))).toMatchObject({ kind: "question", unblock: false });
  });
  test("a restart time shows when it restarts, with the run's error, and no Unblock", () => {
    expect(blockedCallout(blocked({ resumeAt: 5000, blockedReason: "Usage limit reached" }))).toEqual({ kind: "restart", at: 5000, reason: "Usage limit reached" });
  });
  test("a pending approval wins over the reason and the restart time", () => {
    const pendingApproval = { id: "a1", runId: "r", toolName: "Bash", input: {}, requestedAt: 1 } as never;
    expect(blockedCallout(blocked({ pendingApproval, resumeAt: 5000 }))).toMatchObject({ kind: "approval", approval: { id: "a1" } });
  });
});
