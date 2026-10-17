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
