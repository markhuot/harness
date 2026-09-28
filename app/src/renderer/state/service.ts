// Is the service running older code than this app? It says so itself (`stale`: its checkout
// changed since it started), and a service from before it reported a build at all is older than
// any app that asks.

import type { Health, ServiceStatus } from "@harness/shared";

/** What the app knows about the service's code: null until the first /health answer. */
export type ServiceCode = { build: string | null | undefined; stale: boolean } | null;

export function serviceCodeOf(health: Health | ServiceStatus): NonNullable<ServiceCode> {
  return { build: health.build, stale: health.stale ?? false };
}

export function isServiceStale(code: ServiceCode): boolean {
  return !!code && (code.build === undefined || code.stale);
}
