// The shared world: one small, fixed set of data that every L4 test and the walkthrough render.
// Mac L4 answers a fake client from it, iPhone/iPad L4 load world.json (generated from it) through
// a fake transport, and the walkthrough loads the same data into the real daemon.
// Change a value here and every layer's render changes with it.

import type { ActivityEntry, Run, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { activityLog, runs, sessions, transcript } from "./conversations";
import { changes, files } from "./files";
import { projects } from "./projects";
import { drivers, settings } from "./settings";
import { LOCALE, NOW, TIME_ZONE } from "./time";
import { tickets } from "./tickets";
import { watchers } from "./watchers";

export { NOW, TIME_ZONE, LOCALE } from "./time";

/** What GET /tickets/:key answers for each ticket, assembled from the rest of the world, not written by hand. */
export function ticketDetail(key: string): TicketDetail {
  const ticket = tickets.find((t) => t.key === key);
  if (!ticket) throw new Error(`world has no ticket ${key}`);
  const session = sessions.find((s) => s.id === ticket.sessionId);
  if (!session) throw new Error(`world has no session for ${key}`);
  return {
    ticket,
    session,
    activity: activityLog.filter((a) => a.ticketId === ticket.id).sort((a, b) => a.createdAt - b.createdAt),
    runs: runs.filter((r) => r.sessionId === ticket.sessionId),
    dependents: tickets.filter((t) => t.dependsOn.includes(key)).map((t) => t.key),
    children: tickets.filter((t) => t.parentId === ticket.id),
    parent: tickets.find((t) => t.id === ticket.parentId) ?? null,
    subagents: [],
    relatedTickets: [],
    attachments: [],
  };
}

export const world = {
  now: NOW,
  timeZone: TIME_ZONE,
  locale: LOCALE,
  projects,
  tickets,
  sessions,
  runs,
  transcript,
  activity: activityLog,
  watchers,
  settings,
  drivers,
  files,
  changes,
  details: Object.fromEntries(tickets.map((t) => [t.key, ticketDetail(t.key)])) as Record<string, TicketDetail>,
};

export type World = typeof world;
export type { ActivityEntry, Run, Ticket, TranscriptEntry };
