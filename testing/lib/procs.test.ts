import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killRecords, parseRecords, processStart, reapRuns, RunFile, spawnTracked, stillRunning } from "./procs";

const dirs: string[] = [];
const spawned: number[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "procs-test-"));
  dirs.push(d);
  return d;
};
const alive = (pid: number) => processStart(pid) !== null;

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

test("a run file read after a crash skips the torn last line and records without a pid", () => {
  const text = [JSON.stringify({ pid: 1, start: "a", name: "x" }), JSON.stringify({ name: "no pid" }), '{"pid": 2, "sta'].join("\n");
  expect(parseRecords(text)).toEqual([{ pid: 1, start: "a", name: "x" }]);
});

test("a record whose pid now belongs to another process (different start time) is not running", () => {
  const records = [
    { pid: 10, start: "Mon 10:00", name: "same" },
    { pid: 11, start: "Mon 10:00", name: "reused" },
    { pid: 12, start: "Mon 10:00", name: "gone" },
  ];
  const startOf = (pid: number) => ({ 10: "Mon 10:00", 11: "Tue 09:00" })[pid] ?? null;
  expect(stillRunning(records, startOf).map((r) => r.name)).toEqual(["same"]);
});

test("killRecords stops a running process group, children included", async () => {
  const run = new RunFile(join(temp(), "a.pids"));
  const s = spawnTracked(run, "sleeper", ["sh", "-c", "sleep 60 & wait"]);
  spawned.push(s.proc.pid);
  await killRecords(run.records());
  await s.proc.exited;
  expect(alive(s.proc.pid)).toBe(false);
});

test("killRecords leaves alone a process that merely reused the recorded pid", async () => {
  const run = new RunFile(join(temp(), "a.pids"));
  const s = spawnTracked(run, "bystander", ["sleep", "60"]);
  spawned.push(s.proc.pid);
  await killRecords([{ pid: s.proc.pid, start: "Thu Jan  1 00:00:00 1970", name: "stale record" }]);
  expect(alive(s.proc.pid)).toBe(true);
});

test("reapRuns kills what a dead run's file lists, removes the file, and skips the run asking", async () => {
  const dir = temp();
  const dead = new RunFile(join(dir, "1.pids"), { pid: 2 ** 22 + 1, start: "gone" });
  const mine = new RunFile(join(dir, "2.pids"));
  const orphan = spawnTracked(dead, "orphan", ["sleep", "60"]);
  const live = spawnTracked(mine, "mine", ["sleep", "60"]);
  spawned.push(orphan.proc.pid, live.proc.pid);

  const reaped = await reapRuns(dir, mine.path);
  expect(reaped.map((r) => r.name)).toEqual(["orphan"]);
  await orphan.proc.exited;
  expect(alive(orphan.proc.pid)).toBe(false);
  expect(existsSync(dead.path)).toBe(false);
  expect(alive(live.proc.pid)).toBe(true);
  expect(existsSync(mine.path)).toBe(true);
});

test("reapRuns leaves a file alone while its owner is still running, and reaps it once the owner is gone", async () => {
  const dir = temp();
  const ownerAlive = new RunFile(join(dir, "1.pids"));
  const bystander = spawnTracked(ownerAlive, "daemon of a live run", ["sleep", "60"]);
  spawned.push(bystander.proc.pid);

  expect(await reapRuns(dir)).toEqual([]);
  expect(alive(bystander.proc.pid)).toBe(true);
  expect(existsSync(ownerAlive.path)).toBe(true);

  const gone = (pid: number) => (pid === process.pid ? null : processStart(pid));
  const reaped = await reapRuns(dir, undefined, gone);
  expect(reaped.map((r) => r.name)).toEqual(["daemon of a live run"]);
  await bystander.proc.exited;
  expect(alive(bystander.proc.pid)).toBe(false);
});

test("killRecords reaps group members left behind by a leader that already exited", async () => {
  const run = new RunFile(join(temp(), "a.pids"));
  const s = spawnTracked(run, "leader", ["sh", "-c", "sleep 60 & echo $!; exit 0"]);
  spawned.push(s.proc.pid);
  const child = Number((await s.line(/^\d+$/, "the child pid", 5000))[0]);
  await s.proc.exited;
  expect(alive(child)).toBe(true);
  await killRecords(run.records());
  await Bun.sleep(100);
  expect(alive(child)).toBe(false);
});

test("line() resolves on output that arrived before the wait began, and names the output when the process exits first", async () => {
  const run = new RunFile(join(temp(), "a.pids"));
  const s = spawnTracked(run, "talker", ["sh", "-c", "echo listening on 4242; echo done"]);
  await s.proc.exited;
  const m = await s.line(/listening on (\d+)/, "the talker to listen", 5000);
  expect(m[1]).toBe("4242");
  await expect(s.line(/never printed/, "a line that never comes", 5000)).rejects.toThrow(/talker exited before a line that never comes.*listening on 4242/s);
});
