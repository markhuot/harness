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

/** How long the socket can be down before the window says it can't reach the service. */
export const UNREACHABLE_AFTER_MS = 8000;

/**
 * The service notice a window shows, most urgent first: "unreachable" (the socket has been down
 * for UNREACHABLE_AFTER_MS; `downSince` is when it dropped, null while connected), "deferred" (a
 * new build's login item waits for running agents before it reloads the service), or "stale".
 */
export type ServiceNotice = "unreachable" | "deferred" | "stale" | null;

export function serviceNotice(o: { stale: boolean; deferred: boolean; downSince: number | null; now: number }): ServiceNotice {
  if (o.downSince !== null && o.now - o.downSince >= UNREACHABLE_AFTER_MS) return "unreachable";
  if (o.deferred) return "deferred";
  return o.stale ? "stale" : null;
}
