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

/**
 * Old test files that moved into the new suite. The old file is gone, so its rows come from `now` (each row keeps the
 * old path, so the area and the progress table stay where they were). A test that moved to a different file than its
 * neighbours (it needs a real process, say, so it lives in next/contract) is a second entry for the same `old`.
 */
export interface Ported {
  old: string;
  now: string;
}
const ORCH = "service/src/orchestrator/";
const NEXT_ORCH = "next/orchestrator/";
export const PORTED: Ported[] = [
  ...[
    "activity-lines", "adviser", "approvals", "attachments", "classifier-denials", "context-usage", "message-drafts", "model-selection", "models",
    "permissions", "prompt-annotations", "prompt-attachments", "prompt-overrides", "prompts-builtin", "prompts", "remote-ids", "review-activity",
    "ticket-detail-parent", "usage-limit-restart", "usage-limit",
    "config-tools", "context-gauge", "key-aliases", "message-annotations", "message-attachments", "plan-usage", "steering", "subagents", "tasks",
    "board-ops",
    "replan",
    "run-recovery",
    "watchers",
    "watchers-integration",
    "watcher-inbox",
    "generic-watcher-e2e",
    "branches",
    "missing-worktree",
    "drafts",
    "spec",
    "completion",
    "files",
    "file-view",
    "board-write",
    "orchestrator",
  ].map((f) => ({ old: `${ORCH}${f}.test.ts`, now: `${NEXT_ORCH}${f}.test.ts` })),
  // Three real-process watcher tests became one contract test that runs bunSpawn against /bin/sh
  { old: `${ORCH}watchers.test.ts`, now: "next/contract/watcher-spawn.test.ts" },
];

/**
 * Old tests that were not carried over because what they checked isn't ours (the shell, the OS) or another
 * ported test already covers it. Each is a loss row with its reason, for the human to sign off on.
 */
export interface Dropped {
  file: string;
  group: string;
  name: string;
  reason: string;
}
const WATCHERS = `${ORCH}watchers.test.ts`;
const SPAWN_GROUP = "WatcherRunner with Bun.spawn";
export const DROPPED: Dropped[] = [
  {
    file: WATCHERS,
    group: SPAWN_GROUP,
    name: "a shell command line gets pipes, variables and the watcher env",
    reason: "pipes and $VAR expansion are the shell's job; the ported fake-spawn test pins that a command line reaches `[shell, -lc, line]` whole, with the watcher env",
  },
  {
    file: WATCHERS,
    group: SPAWN_GROUP,
    name: "a looping shell command printing pretty JSON without a newline gives one item per response",
    reason: "the chunking is ours and the ported fake-spawn test 'pretty JSON without a trailing newline' covers it; a real shell loop only added the OS printing text",
  },
  {
    file: WATCHERS,
    group: SPAWN_GROUP,
    name: "a missing executable is reported, not thrown",
    reason: "Bun.spawn throwing ENOENT is the OS; our catch is covered by the ported 'spawn that throws' tests",
  },
];

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

/** sim-check checks the iPhone walkthrough carries now, by the screen that asserts them. */
const SIM_WALKTHROUGH: { name: RegExp; screen: string }[] = [
  { name: /agent notes start collapsed/, screen: "ticket details" },
  { name: /Save on blur switch/, screen: "settings" },
  { name: /bottom bar's field opens the palette/, screen: "command palette" },
  { name: /⌘K over a ticket sheet/, screen: "ticket commands" },
  { name: /^Agents & tasks: the filter survives/, screen: "agents & tasks filter" },
  { name: /a relative file link in a spec opens the file viewer/, screen: "file link" },
  { name: /a Terraform file opens highlighted/, screen: "terraform highlight" },
  { name: /^Open file… \(⌘P\) finds a file/, screen: "open file palette" },
  { name: /the gauge's 44 pt tap target sits on the ticket key's row/, screen: "context gauge" },
  { name: /a gauge opens its menu and its About popover/, screen: "context gauge" },
  { name: /New session asks first, and Limit… opens the limit sheet/, screen: "context gauge limit" },
  { name: /the misses row in the gauge menu opens its explanation/, screen: "context gauge states" },
  { name: /a compacting session shows the spinner gauge/, screen: "context gauge states" },
  { name: /^usage: /, screen: "plan usage" },
  { name: /routes open without crashing the app/, screen: "routes" },
  { name: /^composer answers a blocked ticket/, screen: "blocked composer" },
  { name: /^Approve menu → Approve and… takes typed instructions/, screen: "approve and…" },
  { name: /^prompt editor: a bad variable shows inline/, screen: "prompt editor" },
  { name: /^prompt editor: a tapped variable goes in at the cursor/, screen: "prompt variable chip" },
  { name: /tapping a model in the Models picker saves it to the phase/, screen: "models picker" },
  { name: /^the file editor edits, shows the unsaved dot and writes the file with Save/, screen: "file editor save" },
  { name: /^New session: @READ lists README\.md/, screen: "mentions and commands" },
  { name: /^New session: the toolbar's Plan first opens the launched ticket/, screen: "mentions and commands" },
  { name: /^composer: @src\/a lists src\/app\.ts/, screen: "mentions and commands" },
  { name: /^New session: \/co lists the agent's commands/, screen: "mentions and commands" },
  { name: /^composer: moving the caret keeps what's typed/, screen: "composer draft" },
  { name: /^touch and hold on a card previews its ticket/, screen: "card preview" },
  { name: /^tapping an inline image opens the viewer on it/, screen: "attachments" },
  { name: /^an image smaller than the screen opens centred/, screen: "attachments" },
  { name: /^swiping down closes the viewer/, screen: "attachments" },
  { name: /^the video page plays and swiping down closes it too/, screen: "attachments" },
];

export function dispositionOf(row: Row): Disposition {
  if (row.lossReason) return { status: "loss", reason: row.lossReason };
  if (row.ref) return { status: "new", ref: row.ref };
  if (row.kind === "swift") return { status: "kept", reason: "HarnessKit's swift test needs no simulator and stays; it also decodes the service's golden files" };
  if (row.kind === "sim-check") {
    for (const l of SIM_NAME_LOSSES) if (l.name.test(row.name)) return { status: "loss", reason: l.reason };
    for (const l of SIM_LOSSES) if (l.group.test(row.group)) return { status: "loss", reason: l.reason };
    for (const c of SIM_WALKTHROUGH) if (c.name.test(row.name)) return { status: "walkthrough", ref: `next/walkthrough/ios.ts › ${c.screen}` };
    if (/leading > shows only commands/.test(row.name)) return { status: "kept", reason: "the > prefix is pure logic that HarnessKit's PaletteTests already pin (greaterThanListsOnlyCommandsEvenWhenATicketAndAPathMatch); a typed query on a simulator added only the keystrokes" };
    if (row.group === "memoryChecks") return { status: "loss", reason: "a memory measurement of docked tickets, not behaviour a screen shows; the dock itself is an accepted loss" };
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
