import type { Database } from "bun:sqlite";
import { now } from "./util";

/** Watch items already handled, keyed by (source, key, version). */
export class SeenRepo {
  constructor(private db: Database) {}

  /** Record the item; returns false when it had been seen before. */
  markSeen(source: string, key: string, version: string | null): boolean {
    const res = this.db
      .query("INSERT OR IGNORE INTO seen_items (source, key, version, created_at) VALUES ($source, $key, $version, $t)")
      .run({ source, key, version: version ?? "", t: now() });
    return res.changes > 0;
  }

  forget(source: string) {
    this.db.query("DELETE FROM seen_items WHERE source = $source").run({ source });
  }
}

/** Key/value JSON settings. */
export class SettingsRepo {
  constructor(private db: Database) {}

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {}
    }
    return out;
  }

  set(values: Record<string, unknown>) {
    const q = this.db.query("INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) q.run({ key, value: JSON.stringify(value) });
      }
    })();
  }

  delete(keys: readonly string[]) {
    const q = this.db.query("DELETE FROM settings WHERE key = $key");
    for (const key of keys) q.run({ key });
  }
}

/** Named monotonic counters (e.g. TRIAGE-n). */
export class CounterRepo {
  constructor(private db: Database) {}

  next(name: string): number {
    const row = this.db
      .query("INSERT INTO counters (name, value) VALUES ($name, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value")
      .get({ name }) as { value: number };
    return row.value;
  }
}
