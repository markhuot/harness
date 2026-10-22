import { expect, test } from "bun:test";
import type { AppRequest, PaneOp } from "@harness/shared";
import { arrangeOnBoard } from "../../app/src/renderer/state/arrangeRequest";
import { getPanes, updatePanes } from "../../app/src/renderer/state/panes";
import { board, row, st, ticket } from "../l0/renderer/paneBuild";

const area = { width: 1600, height: 900 };
const allowed = { tickets: ["A-1", "A-2"], terminals: ["t1"] };
const ask = (scope: string, op: PaneOp) => arrangeOnBoard({ kind: "panes.arrange", op, allowed } satisfies AppRequest, scope, area, (id) => (id === "t1" ? { id, cwd: "/w" } : undefined));
const keys = (scope: string) => getPanes(scope).root.type === "split" ? (getPanes(scope).root as { children: { id: string }[] }).children.map((c) => c.id) : [];

test("an op changes the board's panes in the store and the reply is the layout it left", () => {
  const scope = "arrange-open";
  updatePanes(scope, () => st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a"));
  const reply = ask(scope, { op: "open", pane: { terminal: "t1" } });
  expect(reply).toMatchObject({ ok: true, result: { outcome: "applied", scope } });
  expect(keys(scope)).toHaveLength(3);
  if (reply.ok) expect(reply.result.layout.panes.map((p) => p.pane)).toEqual([{ board: true }, { ticket: "A-1", tab: "spec" }, { terminal: "t1" }]);
});

test("a ticket outside the set is refused and the panes stay as they were; the layout hides other panes", () => {
  const scope = "arrange-scope";
  updatePanes(scope, () => st(row("r", [board("B"), ticket("o", "OTHER-1")], [0.5, 0.5]), "o"));
  const before = JSON.stringify(getPanes(scope));
  expect(ask(scope, { op: "open", pane: { ticket: "OTHER-1" } })).toEqual({ ok: false, error: "Unknown ticket: OTHER-1" });
  expect(JSON.stringify(getPanes(scope))).toBe(before);
  const layout = ask(scope, { op: "get_layout" });
  expect(layout).toMatchObject({ ok: true, result: { layout: { others: 1 } } });
  expect(JSON.stringify(layout)).not.toContain("OTHER-1");
});

test("an op that changes nothing reports unchanged and writes nothing", () => {
  const scope = "arrange-noop";
  updatePanes(scope, () => st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a"));
  const before = getPanes(scope);
  expect(ask(scope, { op: "close", pane: { ticket: "A-2" } })).toMatchObject({ ok: true, result: { outcome: "unchanged", message: expect.stringContaining("wasn't open") } });
  expect(getPanes(scope)).toBe(before);
});
