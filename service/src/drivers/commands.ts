// Per-driver, per-folder cache of the slash commands and skills a driver's agent offers (the
// composers' `/command` autocomplete, DESIGN.md "Slash commands"). Listing is slow (claude-code
// starts the CLI: two to four seconds) and every keystroke asks, so only the first lookup for a
// folder waits. After that the list answers at once, and a stale one is refreshed in the
// background, so a new skill shows up on a later keystroke. Concurrent lookups share one listing,
// and a failure is an empty list (or the last good one) until the retry.

import type { CommandMatch } from "@harness/shared";
import type { Driver } from "./types";

export interface CommandCatalogOptions {
  /** How long a list is fresh (default 60 s); after that it's still answered while it refreshes */
  ttlMs?: number;
  /** How long a failed lookup waits before retrying (default 15 s) */
  errorTtlMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class CommandCatalog {
  /** `listed`: the value came from a listing (maybe an earlier one), not a failure's empty list. */
  private cache = new Map<string, { value: CommandMatch[]; expiresAt: number; listed: boolean }>();
  private inflight = new Map<string, Promise<CommandMatch[]>>();
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CommandCatalogOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.errorTtlMs = opts.errorTtlMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  /** The driver's commands for `cwd`; [] when it has none or listing them failed. Never throws. */
  async get(driver: Driver, cwd: string): Promise<CommandMatch[]> {
    if (!driver.listCommands) return [];
    const key = `${driver.id}\0${cwd}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.load(driver, cwd, key, hit?.listed ? hit.value : undefined).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return hit?.listed ? hit.value : pending;
  }

  private async load(driver: Driver, cwd: string, key: string, stale: CommandMatch[] | undefined): Promise<CommandMatch[]> {
    try {
      const value = await driver.listCommands!(cwd);
      this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs, listed: true });
      return value;
    } catch (err) {
      this.opts.log?.(`couldn't list ${driver.id} commands in ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
      this.cache.set(key, { value: stale ?? [], expiresAt: this.now() + this.errorTtlMs, listed: !!stale });
      return stale ?? [];
    }
  }
}
