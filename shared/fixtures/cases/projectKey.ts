// Project key rename preview (shared/src/state/projectKey.ts) for HarnessKit's ProjectKey.swift.
// Projects and tickets carry only the fields projectKey.ts reads; the Swift side decodes them into
// ProjectKey.ProjectInfo / TicketInfo.
import type { Project, Ticket } from "../../src";
import { formatRuns, nativeTickets, previewProjectKey } from "../../src/state/projectKey";
import { cases } from "../case";

type P = { id: string; key: string; name: string; nextSeq: number };
type T = { id: string; key: string; projectId: string; externalRef: { key: string } | null };

const project = (over: Partial<P> = {}): P => ({ id: "p1", key: "HELLOHARNESS", name: "hello-harness", nextSeq: 4, ...over });

let n = 0;
const ticket = (key: string, projectId = "p1", remote: string | null = null): T => ({
  id: `t${++n}`,
  key,
  projectId,
  externalRef: remote === null ? null : { key: remote },
});
/** A legacy mirror: its key is its remote ID. */
const mirror = (key: string, projectId = "p1"): T => ticket(key, projectId, key);

const base = project();
const other = project({ id: "p2", key: "OTHER", name: "Other" });
const seeded = () => [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-3"), mirror("FOO-123")];

type Input = { project: P; projects: P[]; tickets: T[]; draft: string };
const input = (draft: string, over: Partial<Input> = {}): Input => ({ project: base, projects: [base, other], tickets: seeded(), draft, ...over });

export const previewProjectKeyCases = cases(
  ({ project, projects, tickets, draft }: Input) => previewProjectKey(project as Project, projects as Project[], tickets as unknown as Ticket[], draft),
  {
    // projectKey.test.ts
    "rename with a mirror kept": input(" hel "),
    "linked ticket renames, mirror kept": input("HEL", {
      projects: [base],
      tickets: [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-4", "p1", "MH-62"), mirror("FOO-123")],
    }),
    "unchanged key": input("helloharness"),
    "empty draft": input(""),
    "starts with a digit": input("2X"),
    "dash in draft": input("he-l"),
    "too long": input("A".repeat(17)),
    reserved: input("triage"),
    "used by another project": input("other"),
    "rename lands on an existing ticket": input("HEL", { tickets: [...seeded(), mirror("HEL-2", "p2")] }),
    "renamed ticket doesn't clash with itself": input("Y", { project: project({ key: "X" }), projects: [project({ key: "X" })], tickets: [ticket("X-1")] }),
    "next numbers skip taken keys": input("HEL", { tickets: [...seeded(), mirror("HEL-4", "p2")] }),
    "gaps summarized as runs": input("H", {
      project: project({ nextSeq: 9 }),
      projects: [project({ nextSeq: 9 })],
      tickets: [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-5"), ticket("HELLOHARNESS-7")],
    }),
    "one native ticket becomes": input("H", { project: project({ nextSeq: 9 }), projects: [project({ nextSeq: 9 })], tickets: [ticket("HELLOHARNESS-3")] }),
    // extra
    "two clashes": input("HEL", { tickets: [...seeded(), mirror("HEL-1", "p2"), mirror("HEL-3", "p2")] }),
    "four clashes are cut to three": input("HEL", {
      tickets: [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-3"), ticket("HELLOHARNESS-4"), ...["HEL-1", "HEL-2", "HEL-3", "HEL-4"].map((k) => mirror(k, "p2"))],
    }),
    "several mirrors kept": input("HEL", { tickets: [ticket("HELLOHARNESS-1"), mirror("FOO-1"), mirror("BAR-2")] }),
    "mirrors only, nothing renamed": input("HEL", { tickets: [mirror("FOO-1")] }),
    "no tickets at all": input("HEL", { tickets: [] }),
    "other project's tickets aren't renamed": input("HEL", { tickets: [ticket("HELLOHARNESS-1", "p2"), ticket("HELLOHARNESS-2")] }),
    "non-numeric suffix isn't native": input("HEL", { tickets: [ticket("HELLOHARNESS-1a"), ticket("HELLOHARNESS-"), ticket("HELLOHARNESS-2")] }),
    "other prefix in the project isn't native": input("HEL", { tickets: [ticket("OLD-1"), ticket("HELLOHARNESSX-1"), ticket("HELLOHARNESS-2")] }),
    "native tickets sort by number": input("HEL", { tickets: [ticket("HELLOHARNESS-10"), ticket("HELLOHARNESS-9"), ticket("HELLOHARNESS-1")] }),
    "leading zeros keep their suffix": input("HEL", { tickets: [ticket("HELLOHARNESS-007"), ticket("HELLOHARNESS-8")] }),
    "unchanged key skips taken next numbers": input("HELLOHARNESS", { tickets: [...seeded(), ticket("HELLOHARNESS-4"), ticket("HELLOHARNESS-6")] }),
    "renaming ticket frees its next number": input("HEL", {
      project: project({ key: "HEL", nextSeq: 1 }),
      projects: [project({ key: "HEL", nextSeq: 1 })],
      tickets: [ticket("HEL-1"), ticket("HEL-2")],
    }),
    "unchanged with lower case": input("  HelloHarness\n"),
    "mirror under the project's own prefix": input("HEL", { tickets: [ticket("HELLOHARNESS-1"), mirror("HELLOHARNESS-2")] }),
    "another project with the same key as itself is fine when unchanged": input("HELLOHARNESS", { projects: [base, project({ id: "p3", name: "Dup" })] }),
    "huge ticket number": input("HEL", { tickets: [ticket("HELLOHARNESS-99999999999999999999"), ticket("HELLOHARNESS-1")] }),
    "duplicate ticket keys": input("HEL", { tickets: [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-1")] }),
  },
);

export const nativeTicketsCases = cases(
  ({ project, tickets }: { project: P; tickets: T[] }) =>
    nativeTickets(project as Project, tickets as unknown as Ticket[]).map((x) => ({ id: x.ticket.id, suffix: x.suffix, n: x.n })),
  {
    seeded: { project: base, tickets: seeded() },
    "sorted by number, stable for equal numbers": { project: base, tickets: [ticket("HELLOHARNESS-02"), ticket("HELLOHARNESS-10"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-1")] },
    "skips other projects, mirrors and foreign prefixes": {
      project: base,
      tickets: [ticket("HELLOHARNESS-1", "p2"), mirror("HELLOHARNESS-2"), ticket("X-3"), ticket("HELLOHARNESS-4", "p1", "MH-1")],
    },
    "non-ASCII digits aren't native": { project: base, tickets: [ticket("HELLOHARNESS-١"), ticket("HELLOHARNESS-+1"), ticket("HELLOHARNESS- 1")] },
    empty: { project: base, tickets: [] },
  },
);

export const formatRunsCases = cases(formatRuns, {
  empty: [],
  one: [4],
  runs: [1, 2, 3, 5, 7, 8],
  "pair is a run": [1, 2],
  "no runs": [1, 3, 5],
  "duplicates break runs": [1, 1, 2],
  "huge numbers": [1e20, 1e20 + 1],
  "zero": [0, 1],
});
