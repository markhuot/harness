// The Settings field for how long events are kept (Settings.eventRetentionDays), shared by the Mac's field and the iOS port.
import { MAX_EVENT_RETENTION_DAYS } from "../protocol";

/** The retention days a Settings field's text means: rounded and kept within 1…365; null (nothing is saved) when it's blank or not a number. */
export function parseEventRetentionDays(text: string): number | null {
  if (!text.trim()) return null;
  const n = Math.round(Number(text));
  return Number.isFinite(n) ? Math.min(MAX_EVENT_RETENTION_DAYS, Math.max(1, n)) : null;
}
