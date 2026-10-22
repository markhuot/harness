import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppReply, AppRequest } from "@harness/shared";
import { MacRequests } from "../../../service/src/api/mac-requests";
import { parsePaneOp } from "../../../service/src/tools/panes";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";
import { tempDir } from "../../builders/tmp";

afterEach(stopAll);

const LAYOUT = { panes: [], others: 0, zoomed: false };
const OK: AppReply = { ok: true, result: { outcome: "applied", message: "Opened it.", scope: "group:g", layout: LAYOUT } };

/** A Mac that records what it is asked and answers with `answer` (or never, with null). */
function rig(answer: AppReply | null | "no-mac") {
  const macs = new MacRequests();
  const asked: AppRequest[] = [];
  macs.bind((id, request) => {
    if (answer === "no-mac") return null;
    asked.push(request);
    if (answer) queueMicrotask(() => macs.reply("mac-1", id, answer));
    return "mac-1";
  });
  return { macs, asked };
}

async function chief(macs: MacRequests | undefined, calls: [string, unknown][]) {
  const root = tempDir();
  const h = makeOrchestrator({ tools: undefined, macRequests: macs });
  const ticket = async (key: string, group: string) => {
    const dir = join(root, key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    const p = h.orch.createProject({ path: dir, name: key, key, useWorktrees: false, group });
    const t = await h.orch.createTicket({ projectId: p.id, spec: `${key} ticket`, start: false });
    await h.settle();
    return t;
  };
  const work = await ticket("WORK1", "Work");
  const home = await ticket("HOME1", "Home");
  const cos = h.orch.openCos({ group: h.store.groups.findByName("Work")!.id });
  const { steps, results } = callTools(calls);
  h.driver.script(steps);
  await h.orch.sendMessage(cos.key, "go");
  await h.settle();
  return { results, work, home };
}

test("an op names tickets as the board knows them and carries the covered set; the Mac's layout comes back as the result", async () => {
  const { macs, asked } = rig(OK);
  const { results, work } = await chief(macs, [["arrange_panes", { op: "open", pane: { ticket: "work1-1" } }]]);
  expect(results[0]!.isError).toBe(false);
  expect(JSON.parse(results[0]!.text)).toMatchObject({ outcome: "applied", message: "Opened it.", board: "group:g" });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ kind: "panes.arrange", op: { op: "open", pane: { ticket: work.key } }, allowed: { tickets: [work.key], terminals: [] } });
});

test("a ticket in another group and a missing one read the same, and the Mac is never asked", async () => {
  const { macs, asked } = rig(OK);
  const { results, home } = await chief(macs, [
    ["arrange_panes", { op: "open", pane: { ticket: "HOME1-1" } }],
    ["arrange_panes", { op: "close", pane: { ticket: "NOPE-9" } }],
    ["arrange_panes", { op: "split", pane: { ticket: "WORK1-1" }, target: { ticket: "HOME1-1" }, zone: "left" }],
  ]);
  expect(home.key).toBeTruthy();
  expect(results.map((r) => r.isError)).toEqual([true, true, true]);
  expect(results[0]!.text.replace("HOME1-1", "X")).toBe(results[1]!.text.replace("NOPE-9", "X"));
  expect(asked).toEqual([]);
});

test("an unknown terminal is not found without asking the Mac", async () => {
  const { macs, asked } = rig(OK);
  const { results } = await chief(macs, [["arrange_panes", { op: "focus", pane: { terminal: "t-nope" } }]]);
  expect(results[0]!).toMatchObject({ isError: true, text: expect.stringContaining("Unknown terminal: t-nope") });
  expect(asked).toEqual([]);
});

test("no connected Mac, a Mac that refuses and a Mac that never answers are three different errors", async () => {
  const none = await chief(rig("no-mac").macs, [["arrange_panes", { op: "get_layout" }]]);
  expect(none.results[0]).toMatchObject({ isError: true, text: expect.stringContaining("No Mac app is connected") });

  const refuse = await chief(rig({ ok: false, error: "ticket WORK1-1 isn't open." }).macs, [["arrange_panes", { op: "focus", pane: { ticket: "WORK1-1" } }]]);
  expect(refuse.results[0]).toMatchObject({ isError: true, text: expect.stringContaining("isn't open") });

  const silent = rig(null);
  const slow = await chief(
    {
      request: (r: AppRequest) => silent.macs.request(r, 20),
    } as MacRequests,
    [["arrange_panes", { op: "get_layout" }]],
  );
  expect(slow.results[0]!.isError).toBe(true);
  expect(slow.results[0]!.text).toContain("unknown whether the change was applied");
});

test("without a Mac wired up the tool says so", async () => {
  const { results } = await chief(undefined, [["arrange_panes", { op: "get_layout" }]]);
  expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("No Mac app is connected") });
});

test("parsePaneOp turns a call into the wire op and explains what is wrong with one that can't be", () => {
  expect(parsePaneOp({ op: "resize", pane: { ticket: "A-1", tab: "spec" }, width: 0.3 })).toEqual({ op: "resize", pane: { ticket: "A-1", tab: "spec" }, width: 0.3 });
  expect(parsePaneOp({ op: "split", pane: { terminal: "t1" }, target: { board: true }, zone: "below" })).toEqual({ op: "split", pane: { terminal: "t1" }, target: { board: true }, zone: "below" });
  expect(parsePaneOp({ op: "get_layout", pane: { ticket: "A-1" } })).toEqual({ op: "get_layout" });
  expect(parsePaneOp({ op: "open" })).toMatch(/pane must be an object/);
  expect(parsePaneOp({ op: "open", pane: { ticket: "A-1", terminal: "t1" } })).toMatch(/exactly one/);
  expect(parsePaneOp({ op: "resize", pane: { ticket: "A-1" } })).toMatch(/needs width/);
  expect(parsePaneOp({ op: "move", pane: { ticket: "A-1" }, target: { ticket: "A-2" }, zone: "up" })).toMatch(/needs zone/);
  expect(parsePaneOp({ op: "move", pane: { ticket: "A-1" }, zone: "left" })).toMatch(/target must be an object/);
});
