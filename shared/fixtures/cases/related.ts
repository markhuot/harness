// Remote IDs: the tickets that share one (mobile/src/lib/related.ts) for HarnessKit's Related.swift.
// Ticket maps are passed as arrays (in insertion order) since order decides ties and duplicates.
import { depOpens, relatedLabel, relatedOf, remoteIdPatch, remoteMatchesOf } from "../../../mobile/src/lib/related";
import { HarnessApiError } from "../../src/client";
import { isTicketKey } from "../../src/keys";
import type { RelatedTicket, Ticket } from "../../src/protocol";
import { cases } from "../case";

const T0 = 1759190400000;
let n = 0;
const tk = (key: string, remote: string | null, extra: Partial<Ticket> = {}): Ticket => ({
  id: `id-${key}-${++n}`,
  key,
  projectId: "p",
  kind: "task",
  title: key,
  description: "",
  status: "in_progress",
  sessionId: `ses-${n}`,
  driver: "claude-code",
  parentId: null,
  dependsOn: [],
  autoStart: false,
  agentReview: "pending",
  humanReview: "pending",
  externalRef: remote === null ? null : { source: "jira", key: remote, url: null, raw: null },
  workdir: null,
  branch: null,
  blockedReason: null,
  busy: false,
  pendingApproval: null,
  allowedTools: [],
  permissionMode: null,
  model: null,
  position: 0,
  createdAt: T0 + n,
  updatedAt: T0 + n,
  ...extra,
});
const rel = (key: string, externalKey: string, extra: Partial<RelatedTicket> = {}): RelatedTicket => ({ key, title: key, status: "done", projectId: "p", externalKey, ...extra });

interface RelatedIn {
  tickets: Ticket[];
  ticket: Ticket;
  fetched?: RelatedTicket[];
}

const byId = (ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));

function relatedInputs(): Record<string, RelatedIn> {
  const out: Record<string, RelatedIn> = {};
  {
    const native = tk("MH-62", null);
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "mh-62");
    const other = tk("MH-131", "MH-99");
    out["a native key lists tickets linked to it, newest first"] = { tickets: [native, a, b, other], ticket: native, fetched: [] };
  }
  {
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "MH-62");
    const draft = tk("MH-131", "MH-62", { draft: true });
    out["a linked ticket lists the others on its remote ID, skipping drafts"] = { tickets: [a, b, draft], ticket: a };
  }
  {
    const a = tk("MH-124", "MH-62");
    const unlinked = tk("MH-130", null);
    out["a fetched unloaded entry stays; a loaded one unlinked since drops"] = {
      tickets: [a, unlinked],
      ticket: a,
      fetched: [rel("MH-130", "MH-62"), rel("MH-12", "MH-62"), rel("MH-124", "MH-62")],
    };
  }
  {
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "MH-62", { status: "review", title: "Stage 2" });
    out["a loaded ticket's live fields replace the fetched ones"] = { tickets: [a, b], ticket: a, fetched: [rel("MH-130", "MH-62", { status: "planning", title: "old" })] };
  }
  {
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "MH-62");
    const c = tk("MH-140", "MH-62");
    out["loaded ones the fetch didn't know about come first"] = { tickets: [a, b, c], ticket: a, fetched: [rel("MH-12", "MH-62"), rel("MH-130", "MH-62")] };
  }
  {
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "MH-62", { createdAt: T0 });
    const c = tk("MH-140", "MH-62", { createdAt: T0 });
    const d = tk("MH-150", "MH-62", { createdAt: T0 });
    out["equal createdAt keeps insertion order (stable sort)"] = { tickets: [a, b, c, d], ticket: a };
  }
  {
    const a = tk("MH-124", "MH-62");
    out["no fetch and nothing loaded"] = { tickets: [a], ticket: a };
    out["self in the fetched list, any case, is skipped"] = { tickets: [a], ticket: a, fetched: [rel("mh-124", "MH-62"), rel("MH-1", "MH-62")] };
    out["duplicate fetched keys: the first wins"] = { tickets: [a], ticket: a, fetched: [rel("MH-1", "MH-62", { title: "first" }), rel("mh-1", "MH-62", { title: "second" })] };
  }
  {
    const a = tk("MH-124", "MH-62");
    const draft = tk("MH-130", "MH-62", { draft: true });
    out["a fetched entry for a loaded draft drops"] = { tickets: [a, draft], ticket: a, fetched: [rel("MH-130", "MH-62")] };
  }
  {
    const native = tk("MH-62", "");
    const a = tk("MH-124", "MH-62");
    const blank = tk("MH-125", "");
    out["an empty remote ID links nothing"] = { tickets: [native, a, blank], ticket: native };
  }
  {
    const self = tk("mh-62", null);
    const a = tk("MH-124", "MH-62");
    const sameKey = tk("MH-62", "MH-62");
    out["a ticket whose key matches self case-insensitively is self"] = { tickets: [self, a, sameKey], ticket: self };
  }
  {
    const old = tk("MH-130", "MH-62", { title: "older copy" });
    const a = tk("MH-124", "MH-62");
    const fresh = tk("mh-130", null, { title: "newer copy" });
    out["duplicate loaded keys: the later one decides"] = { tickets: [old, a, fresh], ticket: a, fetched: [rel("MH-130", "MH-62")] };
  }
  {
    const a = tk("\u00c9-1", "X-1");
    const b = tk("\u00c9-2", "X-1");
    out["precomposed and decomposed keys are different keys"] = { tickets: [a, b], ticket: a, fetched: [rel("E\u0301-1", "X-1")] };
  }
  {
    const a = tk("straße-1", null);
    const b = tk("MH-2", "STRASSE-1");
    out["toUpperCase maps ß to SS"] = { tickets: [a, b], ticket: a };
  }
  {
    const a = tk("MH-124", "MH-62");
    const b = tk("MH-130", "MH-62");
    out["a ticket not in the loaded map"] = { tickets: [b], ticket: a, fetched: [rel("MH-1", "MH-62")] };
  }
  return out;
}

export const relatedOfCases = cases(({ tickets, ticket, fetched }: RelatedIn) => relatedOf(byId(tickets), ticket, fetched), relatedInputs());

export const relatedLabelCases = cases(relatedLabel, {
  "remote ID first, then the local key": rel("MH-124", "MH-62"),
  "a legacy mirror shows once": rel("JIRA-9", "JIRA-9"),
  "different case shows both": rel("JIRA-9", "jira-9"),
  "empty remote ID shows the key": rel("MH-1", ""),
});

type ErrIn = { status: number; message: string; data?: unknown } | { plain: string };

export const remoteMatchesOfCases = cases((e: ErrIn) => remoteMatchesOf("plain" in e ? new Error(e.plain) : new HarnessApiError(e.status, e.message, e.data)), {
  "a 404 with matches": { status: 404, message: "Unknown ticket", data: { requested: "JIRA-9", relatedTickets: [rel("MH-124", "JIRA-9")] } },
  "extra fields are dropped": { status: 404, message: "Unknown ticket", data: { requested: "JIRA-9", relatedTickets: [rel("MH-124", "JIRA-9")], extra: 1 } },
  "a 404 without data": { status: 404, message: "Unknown ticket" },
  "a 404 with null data": { status: 404, message: "Unknown ticket", data: null },
  "no related tickets": { status: 404, message: "Unknown ticket", data: { requested: "JIRA-9", relatedTickets: [] } },
  "requested isn't a string": { status: 404, message: "x", data: { requested: 9, relatedTickets: [rel("MH-124", "JIRA-9")] } },
  "relatedTickets isn't an array": { status: 404, message: "x", data: { requested: "JIRA-9", relatedTickets: { 0: rel("MH-124", "JIRA-9") } } },
  "data is a string": { status: 404, message: "x", data: "JIRA-9" },
  "data is an array": { status: 404, message: "x", data: [rel("MH-124", "JIRA-9")] },
  "a 500 with matches": { status: 500, message: "boom", data: { requested: "JIRA-9", relatedTickets: [rel("MH-124", "JIRA-9")] } },
  "not a service error": { plain: "offline" },
} as Record<string, ErrIn>);

interface PatchIn {
  current: { key: string; url: string | null } | null;
  input: { key: string; url: string };
}

const linked = { key: "MH-62", url: "https://jira/MH-62" };
export const remoteIdPatchCases = cases(({ current, input }: PatchIn) => remoteIdPatch(current, input, isTicketKey), {
  "link, trimmed and upper-cased": { current: null, input: { key: " mh-62 ", url: "" } },
  "unchanged": { current: linked, input: { key: "MH-62", url: "https://jira/MH-62" } },
  "unchanged, current key in lower case": { current: { key: "mh-62", url: null }, input: { key: "MH-62", url: "  " } },
  "drop the URL": { current: linked, input: { key: "MH-62", url: "" } },
  "relink": { current: linked, input: { key: "MH-63", url: "https://jira/MH-62" } },
  "unlink": { current: linked, input: { key: "", url: "" } },
  "nothing to unlink": { current: null, input: { key: "", url: "" } },
  "whitespace-only key unlinks": { current: linked, input: { key: "  ", url: "" } },
  "a URL without a key": { current: null, input: { key: "", url: "https://x" } },
  "not a key": { current: null, input: { key: "not a key", url: "" } },
  "not a URL": { current: null, input: { key: "MH-62", url: "jira/MH-62" } },
  "upper-case scheme": { current: null, input: { key: "MH-62", url: "HTTPS://Jira/MH-62" } },
  "plain http": { current: null, input: { key: "MH-62", url: " http://j/1 " } },
  "a scheme with nothing after it": { current: null, input: { key: "MH-62", url: "https://" } },
  "a space inside the URL": { current: null, input: { key: "MH-62", url: "https://a b" } },
  "an NBSP inside the URL": { current: null, input: { key: "MH-62", url: "https://a b" } },
  "a NEL inside the URL is not whitespace": { current: null, input: { key: "MH-62", url: "https://a\u0085b" } },
  "ftp is refused": { current: null, input: { key: "MH-62", url: "ftp://a" } },
  "ß upper-cases to SS": { current: null, input: { key: "straße-1", url: "" } },
  "key error before URL error": { current: null, input: { key: "nope", url: "jira" } },
});

export const depOpensCases = cases(
  ({ dep, byRemoteKey }: { dep: { key: string; missing?: boolean }; byRemoteKey: Record<string, RelatedTicket[]> }) => depOpens(dep, byRemoteKey),
  (() => {
    const byRemoteKey = { "JIRA-9": [rel("MH-124", "JIRA-9")], "GONE-1": [] };
    return {
      "a dependency that exists": { dep: { key: "MH-3", missing: false }, byRemoteKey },
      "missing unset counts as present": { dep: { key: "MH-3" }, byRemoteKey },
      "a missing remote ID with linked tickets, any case": { dep: { key: "jira-9", missing: true }, byRemoteKey },
      "a remote ID with no tickets": { dep: { key: "GONE-1", missing: true }, byRemoteKey },
      "an unknown key": { dep: { key: "NOPE-2", missing: true }, byRemoteKey },
    };
  })(),
);
