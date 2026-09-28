// Notices when the service's own source changes on disk (a merge into the checkout launchd runs
// it from) so it can restart onto the new code once no agents are running. Until then /health
// reports it stale and the app shows a banner. DESIGN.md "Service updates".

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ServiceStatus } from "@harness/shared";

/** The repo checkout this process was loaded from. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** What the daemon loads: its own code, the shared package, builtin plugins, and dependencies. */
const SOURCE_DIRS = ["service/src", "shared/src", "plugins"];
const SOURCE_FILES = ["package.json", "bun.lock", "service/package.json", "shared/package.json"];
const SKIP_DIRS = new Set(["node_modules", "dist", "out"]);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|css|html)$/;
const TEST_FILE = /\.test\.(ts|tsx|js)$/;

/**
 * Content hash of the files the service runs. Tests, build output and dotfiles don't count, so
 * a merge that only touches them doesn't make the service stale.
 */
export function sourceFingerprint(root: string = REPO_ROOT): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path);
      } else if (e.isFile() && SOURCE_EXT.test(e.name) && !TEST_FILE.test(e.name)) {
        files.push(path);
      }
    }
  };
  for (const d of SOURCE_DIRS) walk(join(root, d));
  for (const f of SOURCE_FILES) {
    const path = join(root, f);
    try {
      if (statSync(path).isFile()) files.push(path);
    } catch {}
  }
  const hash = createHash("sha256");
  for (const path of files.map((p) => relative(root, p)).sort()) {
    let content: Buffer;
    try {
      content = readFileSync(join(root, path));
    } catch {
      continue; // removed mid-walk: the next check sees the settled tree
    }
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export interface CodeWatchOptions {
  fingerprint: () => string;
  /** No runs queued, running or starting. */
  isIdle: () => boolean;
  /** Called when `stale` flips (either way). */
  onChange: (status: ServiceStatus) => void;
  /** Exit so the supervisor starts the new code. Omit when nothing would restart the process. */
  restart?: () => void;
  log?: (msg: string) => void;
}

export class CodeWatch {
  /** Fingerprint of the code this process loaded. */
  readonly build: string;
  private current: string;
  private restarting = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private o: CodeWatchOptions) {
    this.build = o.fingerprint();
    this.current = this.build;
  }

  get stale() {
    return this.current !== this.build;
  }

  status(): ServiceStatus {
    return { build: this.build, stale: this.stale };
  }

  /**
   * Re-hash the source. Restarts only once the new code is settled (the same fingerprint two
   * checks in a row, so a checkout that's still writing files isn't loaded half-done) and the
   * service is idle.
   */
  check(): void {
    if (this.restarting) return;
    const wasStale = this.stale;
    const previous = this.current;
    this.current = this.o.fingerprint();
    if (this.stale !== wasStale) {
      this.o.log?.(this.stale ? `source changed on disk (${this.build} → ${this.current})` : "source is back to the loaded version");
      this.o.onChange(this.status());
    }
    if (!this.stale || this.current !== previous || !this.o.restart || !this.o.isIdle()) return;
    this.restarting = true;
    this.o.log?.(`restarting onto the new code (${this.current}): no runs active`);
    this.o.restart();
  }

  start(intervalMs: number) {
    this.stop();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
