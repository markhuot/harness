import type { LabelInfo } from "@harness/shared";
import { hoursAgo, minutesAgo } from "./time";
import { tickets } from "./tickets";

/** Colors and recency of the labels the tickets carry; the counts come from the tickets, whatever their status. "Archive" carries no ticket, so its count is 0 and the sidebar lists it last. */
const specs: Pick<LabelInfo, "name" | "color" | "lastUsedAt">[] = [
  { name: "Bugfix", color: "red", lastUsedAt: minutesAgo(5) },
  { name: "Performance", color: "orange", lastUsedAt: minutesAgo(20) },
  { name: "Release 1.2.3", color: "indigo", lastUsedAt: minutesAgo(45) },
  { name: "Design", color: "purple", lastUsedAt: hoursAgo(2) },
  { name: "Settings", color: "teal", lastUsedAt: hoursAgo(3) },
  { name: "Reference", color: "green", lastUsedAt: hoursAgo(5) },
  { name: "Docs", color: "blue", lastUsedAt: hoursAgo(6) },
  { name: "Archive", color: "pink", lastUsedAt: hoursAgo(8) },
];

/** GET /labels: every label, most recently used first, with its count of tickets in any status. */
export const labels: LabelInfo[] = specs.map((s) => ({
  ...s,
  createdAt: s.lastUsedAt - 60_000,
  count: tickets.filter((t) => (t.labels ?? []).includes(s.name)).length,
}));
