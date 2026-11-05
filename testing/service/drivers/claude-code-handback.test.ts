import { expect, test } from "bun:test";
import { StreamJsonParser, versionAtLeast } from "../../../service/src/drivers/claude-code";

// The stream claude 2.1.316 sends around background tasks, shaped after a live capture: every
// result names what started its turn (`origin`), a background agent's report comes in a "peer"
// turn, and its <task-notification> in a turn of its own that is often empty (num_turns 0).
const init = (version?: string) => ({ type: "system", subtype: "init", session_id: "s1", ...(version ? { claude_code_version: version } : {}) });
const started = (taskId: string, call: string, description: string, taskType = "local_agent") => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: call,
  description,
  task_type: taskType,
  is_backgrounded: true,
});
const tasksChanged = (tasks: [taskId: string, runId: string][]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: tasks.map(([task_id, run_id]) => ({ task_id, run_id })),
});
const notified = (taskId: string) => ({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed" });
const result = (numTurns: number, origin?: Record<string, unknown>) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "s1",
  num_turns: numTurns,
  result: "",
  ...(origin ? { origin } : {}),
});
const peer = (taskId: string) => ({ kind: "peer", from: taskId, senderTaskId: taskId });
const notificationTurn = (runId: string) => ({ kind: "task-notification", producer: "session-task", runId });

const unreported = (p: StreamJsonParser) => [...p.unreported.keys()];

// HARNESS-653 (ACAMD-146): the code agent's report turn ran while the logs agent finished. The
// next init opened an empty task-notification turn, which cleared the logs agent as heard; that
// turn's result then closed stdin while the logs agent's report turn was starting, and the exit
// grace killed it 15s later.
test("an empty task-notification turn doesn't count as handing over another agent's report", () => {
  const p = new StreamJsonParser();
  for (const m of [
    init("2.1.316"),
    started("code", "c1", "md6 ACH and invoice flow code"),
    started("logs", "c2", "md6 logs and SF data"),
    tasksChanged([["code", "run-code"], ["logs", "run-logs"]]),
    result(3),
    notified("code"),
    init(),
    notified("logs"),
    result(1, peer("code")),
  ]) p.handle(m);
  expect(unreported(p)).toEqual(["logs"]);

  p.handle(init());
  p.handle(result(0, notificationTurn("run-code")));
  expect(unreported(p)).toEqual(["logs"]);

  p.handle(init());
  p.handle(result(1, peer("logs")));
  expect(unreported(p)).toEqual([]);
});

test("a background Bash task is handed over by its task-notification turn, not by an empty one", () => {
  const p = new StreamJsonParser();
  for (const m of [init("2.1.316"), started("b1", "c1", "sleep 6", "local_bash"), tasksChanged([["b1", "run-b1"]]), result(2), notified("b1"), init()]) p.handle(m);
  p.handle(result(0, notificationTurn("run-b1")));
  expect(unreported(p)).toEqual(["b1"]);
  p.handle(init());
  p.handle(result(1, notificationTurn("run-b1")));
  expect(unreported(p)).toEqual([]);
});

test("a CLI that doesn't tag origins still hands over every queued task at the next turn's init", () => {
  const p = new StreamJsonParser();
  for (const m of [init("2.1.299"), started("a", "c1", "A"), started("b", "c2", "B"), result(3), notified("a"), notified("b")]) p.handle(m);
  expect(unreported(p)).toEqual(["a", "b"]);
  p.handle(init("2.1.299"));
  expect(unreported(p)).toEqual([]);
});

test("a result's origin switches to per-task handover even when the init gave no version", () => {
  const p = new StreamJsonParser();
  for (const m of [init(), started("a", "c1", "A"), started("b", "c2", "B"), result(3), notified("a"), init()]) p.handle(m);
  // The first init without a version clears as before; the origin then marks the CLI as tagging.
  p.handle(notified("b"));
  p.handle(result(1, peer("a")));
  p.handle(init());
  expect(unreported(p)).toEqual(["b"]);
});

test("versionAtLeast compares dotted versions numerically", () => {
  expect(versionAtLeast("2.1.316", "2.1.316")).toBe(true);
  expect(versionAtLeast("2.1.1000", "2.1.316")).toBe(true);
  expect(versionAtLeast("2.2.0", "2.1.316")).toBe(true);
  expect(versionAtLeast("2.1.299", "2.1.316")).toBe(false);
  expect(versionAtLeast("1.9.999", "2.1.316")).toBe(false);
});
