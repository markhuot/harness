// Saved-server list operations (mobile/src/lib/servers.ts) for HarnessKit's Servers.swift.
// Each case runs a sequence of operations on one list, threading the list through, with a
// deterministic makeId (s1, s2, …) shared across the sequence, so a step that calls makeId when
// it shouldn't shifts every later id.
import { removeServer, renameServer, upsertServer } from "../../../mobile/src/lib/servers";
import type { SavedServer } from "../../../mobile/src/lib/storage";
import { cases } from "../case";

type Op =
  | { op: "upsert"; baseUrl: string; now: number }
  | { op: "remove"; id: string; activeId: string | null }
  | { op: "rename"; id: string; name: string };

type Step =
  | { list: SavedServer[]; server: SavedServer; added: boolean }
  | { list: SavedServer[]; active: string | null }
  | { list: SavedServer[] };

function run({ list, ops }: { list: SavedServer[]; ops: Op[] }): Step[] {
  let n = 0;
  const makeId = () => `s${++n}`;
  const steps: Step[] = [];
  let current = list;
  for (const o of ops) {
    if (o.op === "upsert") {
      const r = upsertServer(current, o.baseUrl, o.now, makeId);
      steps.push(r);
      current = r.list;
    } else if (o.op === "remove") {
      const r = removeServer(current, o.id, o.activeId);
      steps.push(r);
      current = r.list;
    } else {
      current = renameServer(current, o.id, o.name);
      steps.push({ list: current });
    }
  }
  return steps;
}

const a: SavedServer = { id: "a", name: "a", baseUrl: "http://a", addedAt: 1 };
const b: SavedServer = { id: "b", name: "b", baseUrl: "http://b", addedAt: 2 };
const c: SavedServer = { id: "c", name: "Studio Mac", baseUrl: "https://10.0.0.2:7717/harness", addedAt: 3 };

export const serverCases = cases(run, {
  "pairing the same Mac again reuses its entry; a new URL adds one": {
    list: [],
    ops: [
      { op: "upsert", baseUrl: "http://100.64.0.2:7717", now: 1 },
      { op: "upsert", baseUrl: "http://100.64.0.2:7717", now: 2 },
      { op: "upsert", baseUrl: "http://mac.local:7717", now: 3 },
    ],
  },
  "upsert matches the exact base URL only": {
    list: [a],
    ops: [
      { op: "upsert", baseUrl: "http://A", now: 5 },
      { op: "upsert", baseUrl: "http://a/", now: 6 },
      { op: "upsert", baseUrl: "http://a", now: 7 },
    ],
  },
  "upsert finds the first of duplicate URLs": {
    list: [a, { ...b, baseUrl: "http://a" }],
    ops: [{ op: "upsert", baseUrl: "http://a", now: 9 }],
  },
  "upsert names https servers by host and path": {
    list: [],
    ops: [{ op: "upsert", baseUrl: "https://mac.local/harness", now: 1_700_000_000_000 }],
  },
  "removing the active server falls back to the next one": {
    list: [a, b],
    ops: [{ op: "remove", id: "a", activeId: "a" }],
  },
  "removing another server keeps the active one": {
    list: [a, b],
    ops: [{ op: "remove", id: "a", activeId: "b" }],
  },
  "removing the last server leaves none active": {
    list: [a],
    ops: [{ op: "remove", id: "a", activeId: "a" }],
  },
  "removing with nothing active": {
    list: [a, b],
    ops: [{ op: "remove", id: "b", activeId: null }],
  },
  "removing an unknown id changes nothing": {
    list: [a, b],
    ops: [{ op: "remove", id: "zzz", activeId: "a" }],
  },
  "removing the active middle server falls back to the first": {
    list: [a, b, c],
    ops: [{ op: "remove", id: "b", activeId: "b" }],
  },
  "a stale active id is kept": {
    list: [a],
    ops: [{ op: "remove", id: "a", activeId: "gone" }],
  },
  "renaming to blank restores the host name": {
    list: [c],
    ops: [
      { op: "rename", id: "c", name: "  " },
      { op: "rename", id: "c", name: " Laptop " },
      { op: "rename", id: "c", name: "" },
    ],
  },
  "renaming an unknown id changes nothing": {
    list: [a, b],
    ops: [{ op: "rename", id: "zzz", name: "x" }],
  },
  "rename, remove and re-add in one session": {
    list: [],
    ops: [
      { op: "upsert", baseUrl: "http://h:1", now: 10 },
      { op: "upsert", baseUrl: "http://h:2", now: 11 },
      { op: "rename", id: "s1", name: "First" },
      { op: "remove", id: "s1", activeId: "s1" },
      { op: "upsert", baseUrl: "http://h:1", now: 12 },
      { op: "upsert", baseUrl: "http://h:2", now: 13 },
    ],
  },
});
