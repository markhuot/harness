// Per-driver model list cache (GET /drivers/:id/models). Listing can be slow (claude-code
// spawns the CLI) or fail (no API key), so results are cached with a TTL, concurrent
// requests share one lookup, and failures come back as data instead of exceptions.

import type { DriverModels } from "@harness/shared";
import { ModelListError, type Driver } from "./types";

export interface ModelCatalogOptions {
  /** How long a successful list is reused (default 10 min) */
  ttlMs?: number;
  /** How long a failed lookup is reused before retrying (default 30 s) */
  errorTtlMs?: number;
  now?: () => number;
}

interface Entry {
  value: DriverModels;
  expiresAt: number;
}

export class ModelCatalog {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<DriverModels>>();
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly now: () => number;

  constructor(opts: ModelCatalogOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.errorTtlMs = opts.errorTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  async get(driver: Driver, opts: { refresh?: boolean } = {}): Promise<DriverModels> {
    const hit = this.cache.get(driver.id);
    if (!opts.refresh && hit && hit.expiresAt > this.now()) return hit.value;
    const pending = this.inflight.get(driver.id);
    if (pending) return pending;
    const p = this.load(driver).finally(() => this.inflight.delete(driver.id));
    this.inflight.set(driver.id, p);
    return p;
  }

  /** Drop cached lists (all, or one driver), e.g. after a login or an API key change. */
  invalidate(driverId?: string) {
    if (driverId) this.cache.delete(driverId);
    else this.cache.clear();
  }

  private async load(driver: Driver): Promise<DriverModels> {
    let value: DriverModels;
    try {
      const models = await driver.listModels();
      value = { driverId: driver.id, models, error: null, fetchedAt: this.now() };
    } catch (err) {
      value = {
        driverId: driver.id,
        models: err instanceof ModelListError ? err.fallback : [],
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: this.now(),
      };
    }
    this.cache.set(driver.id, { value, expiresAt: this.now() + (value.error ? this.errorTtlMs : this.ttlMs) });
    return value;
  }
}
