// What the walkthrough (`bun run testing walk`) needs on top of the screens' world: a project on a
// real git checkout (the file edit saves into it), a ticket to create and move, and the markers the
// dummy driver's finite stream ends in. The walkthrough seeds these through the real API.

export const WALK_PROJECT = { key: "WALK", name: "walk-project" };

/** The checkout's files. `EDITED_FILE` is the one the journey edits in the Mac app's editor. */
export const WALK_FILES: Record<string, string> = {
  "README.md": "# walk-project\n\nA project for the walkthrough.\n",
  "src/greeting.ts": 'export const greeting = "hello";\n',
};
export const EDITED_FILE = "src/greeting.ts";
export const EDIT_TEXT = "// edited in the walkthrough\n";

/** The ticket created on the Mac. Its key is the project's first. */
export const WALK_TICKET = {
  key: "WALK-1",
  spec: "Walk the journey: say hello from the dummy driver",
};

/**
 * The dummy driver's work run on a plain prompt opens with this line (it echoes the prompt after
 * it), posts a note, and ends in a submit for review. The stream is finite: this is the marker
 * every screen waits for.
 */
export const DUMMY_HELLO = "Hello from the dummy driver!";
/** The note the dummy driver submits the work with; it appears on the finished ticket only. */
export const DUMMY_DONE_NOTE = "The dummy driver finished the work.";

/** Typed into the terminal: the shell must compute it, so the answer can't be the echoed command. */
export const TERMINAL_COMMAND = "echo walk-$((6*7))";
export const TERMINAL_ANSWER = "walk-42";

/**
 * The chief-of-staff steps: the walk project's group already exists (step 4d names it); a second
 * project in it where the chief may not unblock, and a project in another group. Each has a ticket
 * the dummy driver blocks with a question (`/block`), so the chief's reach shows by what it can answer.
 */
export const COS_GROUP = "Walk group";
export const COS_OFF_PROJECT = { key: "OFFP", name: "off-project" };
export const COS_AWAY_GROUP = "Away group";
export const COS_AWAY_PROJECT = { key: "AWAY", name: "away-project" };
export const COS_BLOCKED_SPEC = (what: string) => `/block Which ${what}?`;

/** What the chief is asked to create (a spike, then a build that waits on it) and what its chat shows. */
export const COS_SPIKE_TITLE = "Spike: pick a cache";
export const COS_BUILD_TITLE = "Build: the cache layer";

/** Output a watcher printed: it lands in the Inbox of the All chief. */
export const COS_WATCHER_SOURCE = "github";
export const COS_WATCHER_TEXT = "PR 12 has review feedback from Dana";

/** A reminder the chief sets for itself; the service fires it a few seconds later. */
export const COS_REMINDER_TITLE = "Stand-up";
