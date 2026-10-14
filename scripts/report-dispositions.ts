// Where each old test or check went. The report script (scripts/report.ts) asks `dispositionOf` for every row;
// this file is the work list. A row is `open` until someone moves it here with a reason.
//
//   new          covered by a test in the new suite (next/); the old test may be deleted once a mutation
//                check shows the new one can fail (named in the ticket's Status)
//   walkthrough  covered by a screen of the one iPhone or Mac walkthrough
//   loss         accepted loss; the reason is what the human signs off on
//   kept         not part of the retired suite (it stays and keeps running as it does today)
//   open         no decision yet

import type { Row } from "./report-extract";

export type Disposition =
  | { status: "open" }
  | { status: "new"; ref: string }
  | { status: "walkthrough"; ref: string }
  | { status: "loss"; reason: string }
  | { status: "kept"; reason: string };

/** Rows covered by the new suite: file pattern (and optionally the test name) → new test file. */
export const COVERED_BY_NEW: { file: RegExp; name?: RegExp; ref: string }[] = [];

/** sim-check functions whose behaviour the single walkthrough can't carry: the ticket's expected losses. */
const SIM_LOSSES: { group: RegExp; reason: string }[] = [
  { group: /^sheetChecks$|^dockStackChecks$|^panelChecks$|^fileDockChecks$/, reason: "sheets and docked panels: sheet detents, dock stacking and panel resizing need real gestures; the walkthrough only jumps to screens" },
  { group: /^keyboardChecks/, reason: "keyboard handling: needs the software keyboard and real focus, which a deep-link walkthrough doesn't drive" },
  { group: /^stickChecks$|^pagingChecks$|^cardStackChecks$/, reason: "scrolling and drag behaviour: scroll-to-bottom, paging and card dragging need real touches" },
];

const SIM_NAME_LOSSES: { name: RegExp; reason: string }[] = [
  { name: /relaunch|restor/i, reason: "relaunch and restore: the walkthrough launches once, so it can't relaunch" },
  { name: /ipad/i, reason: "iPad layouts: the walkthrough runs on one iPhone" },
];

export function dispositionOf(row: Row): Disposition {
  for (const c of COVERED_BY_NEW) {
    if (c.file.test(row.file) && (!c.name || c.name.test(row.name))) return { status: "new", ref: c.ref };
  }
  if (row.kind === "swift") return { status: "kept", reason: "HarnessKit's swift test needs no simulator and stays; it also decodes the service's golden files" };
  if (row.kind === "sim-check") {
    for (const l of SIM_NAME_LOSSES) if (l.name.test(row.name)) return { status: "loss", reason: l.reason };
    for (const l of SIM_LOSSES) if (l.group.test(row.group)) return { status: "loss", reason: l.reason };
  }
  if (row.kind === "snapshot" && row.file.endsWith("SnapshotAssertTests.swift")) {
    return { status: "loss", reason: "tests the snapshot diff helper, which retires with the snapshots; the walkthrough's reference diff gets its own bun test" };
  }
  return { status: "open" };
}

export const label = (d: Disposition): string =>
  d.status === "open" ? "open"
  : d.status === "new" ? `new: ${d.ref}`
  : d.status === "walkthrough" ? `walkthrough: ${d.ref}`
  : d.status === "loss" ? "accepted loss"
  : "kept";
