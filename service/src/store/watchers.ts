import type { Database } from "bun:sqlite";
import type { Watcher } from "@harness/shared";
import { bool, fromJson, int, newId, now } from "./util";

interface WatcherRow {
  id: string;
  name: string;
  command: string;
  args: string;
  prompt: string;
  cwd: string | null;
  env: string;
  mode: string;
  interval_sec: number;
  enabled: number;
  driver: string | null;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const toWatcher = (r: WatcherRow): Watcher => ({
  id: r.id,
  name: r.name,
  command: r.command,
  args: fromJson<string[]>(r.args, []),
  prompt: r.prompt ?? "",
  cwd: r.cwd,
  env: fromJson<Record<string, string>>(r.env, {}),
  mode: r.mode === "interval" ? "interval" : "loop",
  intervalSec: r.interval_sec,
  enabled: bool(r.enabled),
  driver: r.driver,
  lastRunAt: r.last_run_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type WatcherInput = Partial<Omit<Watcher, "id" | "createdAt" | "updatedAt">>;

export class WatcherRepo {
  constructor(private db: Database) {}

  list(): Watcher[] {
    return (this.db.query("SELECT * FROM watchers ORDER BY created_at").all() as WatcherRow[]).map(toWatcher);
  }

  get(id: string): Watcher | null {
    const r = this.db.query("SELECT * FROM watchers WHERE id = $id").get({ id }) as WatcherRow | null;
    return r ? toWatcher(r) : null;
  }

  create(input: WatcherInput & { name: string; command: string }): Watcher {
    const id = newId();
    const t = now();
    this.db
      .query(
        `INSERT INTO watchers (id, name, command, args, prompt, cwd, env, mode, interval_sec, enabled, driver, last_run_at, last_error, created_at, updated_at)
         VALUES ($id, $name, $command, $args, $prompt, $cwd, $env, $mode, $intervalSec, $enabled, $driver, NULL, NULL, $t, $t)`,
      )
      .run({
        id,
        name: input.name,
        command: input.command,
        args: JSON.stringify(input.args ?? []),
        prompt: input.prompt ?? "",
        cwd: input.cwd ?? null,
        env: JSON.stringify(input.env ?? {}),
        mode: input.mode ?? "loop",
        intervalSec: input.intervalSec ?? 300,
        enabled: int(input.enabled ?? true),
        driver: input.driver ?? null,
        t,
      });
    return this.get(id)!;
  }

  update(id: string, patch: WatcherInput): Watcher | null {
    const w = this.get(id);
    if (!w) return null;
    const next = { ...w, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Watcher;
    this.db
      .query(
        `UPDATE watchers SET name = $name, command = $command, args = $args, prompt = $prompt, cwd = $cwd, env = $env, mode = $mode,
           interval_sec = $intervalSec, enabled = $enabled, driver = $driver, last_run_at = $lastRunAt, last_error = $lastError, updated_at = $t
         WHERE id = $id`,
      )
      .run({
        id,
        name: next.name,
        command: next.command,
        args: JSON.stringify(next.args),
        prompt: next.prompt,
        cwd: next.cwd,
        env: JSON.stringify(next.env),
        mode: next.mode,
        intervalSec: next.intervalSec,
        enabled: int(next.enabled),
        driver: next.driver,
        lastRunAt: next.lastRunAt,
        lastError: next.lastError,
        t: now(),
      });
    return this.get(id);
  }

  delete(id: string) {
    this.db.query("DELETE FROM watchers WHERE id = $id").run({ id });
  }
}
