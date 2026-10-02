// Background tasks (DESIGN.md "Background tasks"): a Bash command or Monitor the agent left
// running is a subagents row of its own kind. Its output is read from the CLI's file in bounded
// slices while it runs, and its tail is kept once it ends.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tempDir } from "@harness/shared/testing";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { Database } from "bun:sqlite";
import { migrate, MIGRATIONS } from "../db";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { cleanEnd, confineOutputPath, dummyTaskOutputDir, readSnapshot, readTaskOutput, stripAnsi } from "../task-output";

// Task output has to live where the CLI keeps it, so these files go under /tmp/claude-<uid>.
const outDir = join(dummyTaskOutputDir(), `test-${randomUUID()}`);
mkdirSync(outDir, { recursive: true });
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const outFile = (name: string, text = "") => {
  const path = join(outDir, name);
  writeFileSync(path, text);
  return path;
};

function setup(script: (req: RunRequest) => AsyncGenerator<DriverEvent>) {
  const driver = new FakeDriver();
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  driver.script = (req) => (req.kind === "work" ? script(req) : (async function* () {})());
  const run = async () => {
    const t = await h.orch.createTicket({ projectId: project.id, prompt: "do it" });
    await h.orch.idle();
    return t;
  };
  return { ...h, run };
}

describe("background tasks", () => {
  test("a task is listed with its kind and command; it finishes with its summary and its output is kept", async () => {
    const path = outFile("finish.output", "line 1\n");
    const h = setup(async function* () {
      yield { type: "tool_call", callId: "c1", name: "Bash", input: { command: "bun test", run_in_background: true } };
      yield { type: "subagent", subagent: { id: "c1", kind: "bash", description: "Run the tests", command: "bun test", status: "running", outputPath: path } };
      appendFileSync(path, "line 2\n");
      yield { type: "subagent", subagent: { id: "c1", status: "succeeded", result: "exit code 0" } };
    });
    const t = await h.run();
    const [task] = h.orch.subagents(t.sessionId);
    expect(task).toMatchObject({ id: "c1", kind: "bash", command: "bun test", description: "Run the tests", status: "succeeded", result: "exit code 0", hasOutput: true });
    rmSync(path); // the CLI's /tmp is gone: the kept tail still answers
    expect(h.orch.taskOutput(t.sessionId, "c1")).toEqual({ text: "line 1\nline 2\n", start: 0, end: 14, size: 14, done: true, available: true });
    expect(h.orch.taskOutput(t.sessionId, "c1", 7)).toMatchObject({ text: "line 2\n", start: 7, end: 14 });
  });

  test("a task still running when the run ends is stopped, and its output kept then", async () => {
    const path = outFile("stop.output", "serving on :3000\n");
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "dev", kind: "bash", command: "bun dev", status: "running", outputPath: path } };
    });
    const t = await h.run();
    expect(h.orch.subagents(t.sessionId)[0]!.status).toBe("stopped");
    appendFileSync(path, "written after it stopped\n");
    expect(h.orch.taskOutput(t.sessionId, "dev").text).toBe("serving on :3000\n");
  });

  test("while it runs, output is read from the file: the tail, then what follows an offset", async () => {
    const path = outFile("live.output", "a\n");
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "c1", kind: "bash", command: "make", status: "running", outputPath: path } };
      await hold;
    });
    const project = h.orch.listProjects()[0]!;
    const t = await h.orch.createTicket({ projectId: project.id, prompt: "do it" });
    for (let i = 0; i < 50 && !h.orch.subagents(t.sessionId).length; i++) await Bun.sleep(5);
    const first = h.orch.taskOutput(t.sessionId, "c1");
    expect(first).toEqual({ text: "a\n", start: 0, end: 2, size: 2, done: false, available: true });
    appendFileSync(path, "b\n");
    expect(h.orch.taskOutput(t.sessionId, "c1", first.end)).toMatchObject({ text: "b\n", start: 2, end: 4, done: false });
    release();
    await h.orch.idle();
  });

  test("404 for an agent or an unknown id; a path outside the CLI's temp folder isn't read", async () => {
    const outside = join(tempDir("task-outside"), "secret.output");
    writeFileSync(outside, "secret");
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "ag", description: "Agent", status: "running" } };
      yield { type: "subagent", subagent: { id: "evil", kind: "bash", command: "x", status: "running", outputPath: outside } };
      yield { type: "subagent", subagent: { id: "nopath", kind: "monitor", command: "tail -f", status: "running" } };
    });
    const t = await h.run();
    expect(() => h.orch.taskOutput(t.sessionId, "ag")).toThrow(/Unknown background task/);
    expect(() => h.orch.taskOutput(t.sessionId, "nope")).toThrow(/Unknown background task/);
    expect(h.orch.taskOutput(t.sessionId, "evil")).toMatchObject({ text: "", available: false, done: true });
    expect(h.orch.taskOutput(t.sessionId, "nopath")).toMatchObject({ available: false });
    expect(h.orch.subagents(t.sessionId).find((s) => s.id === "nopath")!.hasOutput).toBe(false);
  });

  test("a later report fills in the output path once and never moves it", async () => {
    const a = outFile("first.output", "first");
    const h = setup(async function* () {
      yield { type: "subagent", subagent: { id: "m1", kind: "monitor", command: "watch", status: "running" } };
      yield { type: "subagent", subagent: { id: "m1", outputPath: a } };
      yield { type: "subagent", subagent: { id: "m1", outputPath: "/tmp/elsewhere.output" } };
      yield { type: "subagent", subagent: { id: "m1", status: "succeeded" } };
    });
    const t = await h.run();
    expect(h.orch.taskOutput(t.sessionId, "m1").text).toBe("first");
  });
});

describe("readTaskOutput", () => {
  test("the tail is capped; reading on from an offset skips ahead to the tail after a burst", () => {
    const path = outFile("big.output", "x".repeat(100) + "\n" + "y".repeat(50));
    expect(readTaskOutput(path, undefined, false, 60)).toMatchObject({ start: 91, end: 151, size: 151, text: "x".repeat(9) + "\n" + "y".repeat(50) });
    expect(readTaskOutput(path, 140, false, 60)).toMatchObject({ start: 140, end: 151, text: "y".repeat(11) });
    expect(readTaskOutput(path, 10, false, 60)).toMatchObject({ start: 91, end: 151 });
    expect(readTaskOutput(path, 151, false, 60)).toMatchObject({ text: "", start: 151, end: 151 });
    expect(readTaskOutput(path, 999, false, 60)).toMatchObject({ text: "", start: 151, end: 151 });
  });

  test("a running task's read stops before a cut-off character or escape; the next read picks it up", () => {
    const path = outFile("cut.output");
    writeFileSync(path, Buffer.concat([Buffer.from("ok "), Buffer.from("é").subarray(0, 1)]));
    const first = readTaskOutput(path, undefined, false);
    expect(first).toMatchObject({ text: "ok ", end: 3 });
    appendFileSync(path, Buffer.concat([Buffer.from("é").subarray(1), Buffer.from("\u001b[3")]));
    const second = readTaskOutput(path, first.end, false);
    expect(second).toMatchObject({ text: "é", end: 5 });
    appendFileSync(path, "1mred\u001b[0m");
    expect(readTaskOutput(path, second.end, false).text).toBe("red");
  });

  test("a tail that starts mid-character skips to the next whole one", () => {
    const path = outFile("mid.output", "ééé");
    expect(readTaskOutput(path, undefined, true, 5)).toMatchObject({ text: "éé", start: 2, end: 6 });
  });

  test("a missing file is unavailable", () => {
    expect(readTaskOutput(join(outDir, "gone.output"), 4, false)).toEqual({ text: "", start: 4, end: 4, size: 0, done: false, available: false });
  });

  test("the kept tail answers offsets inside it, and from its start for earlier ones", () => {
    const snap = { text: "abc\ndef\n", start: 100, size: 108 };
    expect(readSnapshot(snap, undefined)).toMatchObject({ text: "abc\ndef\n", start: 100, end: 108, size: 108, done: true });
    expect(readSnapshot(snap, 104)).toMatchObject({ text: "def\n", start: 104 });
    expect(readSnapshot(snap, 3)).toMatchObject({ start: 100, text: "abc\ndef\n" });
    expect(readSnapshot(snap, 500)).toMatchObject({ text: "", start: 108, end: 108 });
  });

  test("cleanEnd and stripAnsi", () => {
    expect(cleanEnd(Buffer.from("abc\u001b]0;title"))).toBe(3);
    expect(cleanEnd(Buffer.from("abc\u001b]0;title\u0007"))).toBe(13);
    expect(cleanEnd(Buffer.from("€").subarray(0, 2))).toBe(0);
    expect(cleanEnd(Buffer.from("€"))).toBe(3);
    expect(stripAnsi("\u001b[1;32m✓\u001b[0m pass \u001b]0;bun\u0007done")).toBe("✓ pass done");
  });

  test("confineOutputPath refuses paths outside the CLI's temp folders, symlinks included", () => {
    const inside = outFile("in.output", "x");
    expect(confineOutputPath(inside)).not.toBeNull();
    const outside = join(tempDir("task-outside"), "o.output");
    writeFileSync(outside, "x");
    expect(confineOutputPath(outside)).toBeNull();
    const link = join(outDir, "link.output");
    require("node:fs").symlinkSync(outside, link);
    expect(confineOutputPath(link)).toBeNull();
    expect(confineOutputPath(join(outDir, "..", "..", "etc", "passwd"))).toBeNull();
  });
});

test("migration 21 keeps existing sub-agents as agents", () => {
  const db = new Database(":memory:", { strict: true });
  for (const [v, sql] of MIGRATIONS.slice(0, 20).entries()) {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  db.query("INSERT INTO sessions (id, key, kind, driver, cwd, created_at, updated_at) VALUES ('s1', 'K-1', 'ticket', 'fake', '/', 0, 0)").run();
  db.query("INSERT INTO subagents (session_id, id, status, started_at, updated_at) VALUES ('s1', 'a', 'succeeded', 0, 0)").run();
  migrate(db);
  expect(db.query("SELECT kind, command, output FROM subagents").get()).toEqual({ kind: "agent", command: null, output: null });
});
