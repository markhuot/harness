// Stands in for `curl <events API>` in watcher tests and the claude-code watcher check: no
// network. Each run prints the next event the state file hasn't recorded yet, as one JSON line,
// and prints nothing once they've all been seen, like an API polled with `?since=`.
//
//   bun events-api.ts --state <file> [--events <file.json>] [--fail <message>]
//
// --events: a JSON array of events (default: EVENTS below). --fail: print the message on
// stderr and exit 2, like a request that failed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** One event per triage outcome: E1 is actionable for mark, E2 isn't his, E3 has nothing to do. */
export const EVENTS = [
  {
    id: "E1",
    type: "ticket.assigned",
    title: "Checkout button does nothing on Safari",
    assignee: "mark",
    next_steps: ["Reproduce on Safari 18", "Fix the click handler in checkout.ts", "Add a regression test"],
  },
  {
    id: "E2",
    type: "ticket.assigned",
    title: "Rotate the staging database password",
    assignee: "sam",
    next_steps: ["Rotate the password", "Update the vault entry"],
  },
  {
    id: "E3",
    type: "ticket.assigned",
    title: "FYI: the design review moved to Thursday",
    assignee: "mark",
    next_steps: [],
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const fail = arg("fail");
  if (fail !== undefined) {
    console.error(fail);
    process.exit(2);
  }
  const statePath = arg("state");
  if (!statePath) {
    console.error("events-api: --state <file> is required");
    process.exit(2);
  }
  const eventsPath = arg("events");
  const events: { id: string }[] = eventsPath ? JSON.parse(readFileSync(eventsPath, "utf8")) : EVENTS;
  const seen = existsSync(statePath) ? readFileSync(statePath, "utf8").split("\n").filter(Boolean) : [];
  const next = events.find((e) => !seen.includes(e.id));
  if (next) {
    writeFileSync(statePath, [...seen, next.id].join("\n") + "\n");
    console.log(JSON.stringify(next));
  }
}
