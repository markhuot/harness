// Project group names, the sidebar's group list and the Group picker's rows (shared/src/projectGroups.ts,
// shared/src/state/groups.ts) for HarnessKit's ProjectGroups.swift.
import { canonicalGroup, normalizeProjectGroup, PROJECT_GROUP_MAX, projectGroups } from "../../src/projectGroups";
import { groupRowIds, groupRows } from "../../src/state";
import { cases } from "../case";

// undefined (refused) and null (no group) both become null in JSON, so the output says which.
export const normalizeCases = cases((v: string | null) => {
  const name = normalizeProjectGroup(v);
  return name === undefined ? { refused: true } : { name };
}, {
  "trimmed, inner whitespace collapsed": "  Day \t  job ",
  "only spaces is no group": "   ",
  "empty is no group": "",
  null: null,
  "at the limit": "x".repeat(PROJECT_GROUP_MAX),
  "over the limit": "x".repeat(PROJECT_GROUP_MAX + 1),
  "spaces around don't count toward the limit": `  ${"y".repeat(PROJECT_GROUP_MAX)}  `,
  "astral characters count as two code units": "😀".repeat(31),
  "NBSP and ideographic space are whitespace": " Side　projects ",
});

export const canonicalCases = cases(({ name, existing }: { name: string; existing: string[] }) => canonicalGroup(name, existing), {
  "a different case joins the group": { name: "work", existing: ["Personal", "Work"] },
  "accents still differ": { name: "Cafe", existing: ["Café"] },
  "no match keeps the name": { name: "Side", existing: ["Work"] },
  "first match wins": { name: "WORK", existing: ["Work", "work"] },
});

export const listCases = cases(projectGroups, {
  "once each, alphabetically without case": [{ group: "work" }, { group: null }, { group: "Personal" }, {}, { group: "work" }, { group: "Archive" }],
  "accents sort with their base letter": [{ group: "Zeta" }, { group: "Éclair" }, { group: "Apple" }],
  "spellings that differ only by case both list, upper case first": [{ group: "work" }, { group: "Work" }],
  "none": [],
});

const groups = ["Personal", "Side projects", "Work"];
const rows = (q: string, gs: string[] = groups) => ({ groups: gs, query: q });
export const rowCases = cases(({ groups, query }: ReturnType<typeof rows>) => {
  const list = groupRows(groups, query);
  return { rows: list.map((r) => ({ kind: r.kind, value: r.value, label: r.label })), ids: groupRowIds(list) };
}, {
  "nothing typed": rows(""),
  "a prefix completes first, then the new name": rows("wor"),
  "words in any order": rows("proj side"),
  "an existing name in any case isn't new": rows("  WORK "),
  "a brand-new name, spaces tidied": rows("  Open   source "),
  "No group stays reachable": rows("no"),
  "No group after a group that matches": rows("no", ["Notes"]),
  "the exact name first, whatever sorts before it": rows("work", ["Client Work", "Work"]),
  "a name prefix beats a match inside a word": rows("wo", ["Network", "Work"]),
  "ranks: exact, name prefix, word prefix, elsewhere": rows("work", ["Artwork", "Client Work", "Home-work", "Work stuff", "Workshop"]),
  "a multi-word name prefix": rows("side proj", ["My side projects", "Projects on the side", "Side projects"]),
  "too long": rows("x".repeat(PROJECT_GROUP_MAX + 1)),
  "no groups yet": rows("", []),
  "no groups, a name": rows("Home", []),
});
