import { project } from "./build";

/** Four projects: a busy git one, one with triage waiting, one that isn't a git checkout, and an empty one. */
export const projects = [
  project({ key: "HARNESS", name: "Harness", path: "/Users/dev/harness", color: "blue", group: "Work", nextSeq: 11, baseBranch: "main" }),
  project({ key: "WEB", name: "Marketing site", path: "/Users/dev/site", color: "green", group: "Work", nextSeq: 4 }),
  project({ key: "NOTES", name: "Notes", path: "/Users/dev/notes", isGit: false, useWorktrees: false, group: "Personal", nextSeq: 3 }),
  project({ key: "SCRATCH", name: "Scratch", path: "/Users/dev/scratch", color: "#aa66cc", group: null }),
];
