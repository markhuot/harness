// Where each old test or check went. The report script (scripts/report.ts) asks `dispositionOf` for every row;
// this file is the work list. A row is `open` until someone moves it here with a reason.
//
//   new          covered by a test in the new suite (next/); the old test may be deleted once a mutation
//                check shows the new one can fail (named in the ticket's Status)
//   walkthrough  covered by a screen of the one iPhone or Mac walkthrough
//   harnesskit   covered by a HarnessKit swift test (no simulator); the ref names the tests
//   loss         accepted loss; the reason is what the human signs off on
//   kept         not part of the retired suite (it stays and keeps running as it does today)
//   open         no decision yet

import type { Row } from "./report-extract";

export type Disposition =
  | { status: "open" }
  | { status: "new"; ref: string }
  | { status: "walkthrough"; ref: string }
  | { status: "harnesskit"; ref: string }
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

// The blockers behind the accepted losses. Each names what the walkthrough (deep links, rest-gated accessibility
// reads, a few taps) can't do, so the human signs off on a real reason.
const IPAD =
  "dropped (human decision): the iPad's corner cards, panel resize and docking, and New session in the panel are not driven on a simulator; the rules are HarnessKit's (DockMetricsTests, DockCardsTests, TicketPanelWidthTests, RouterSheetTests). The iPad pass asserts the board columns, the sidebar and the side panel";
const GESTURE =
  "dropped (human decision): the sheet's drag, flick, back-swipe and scroll gestures (UIKit gesture arbitration, needing velocity that axe.swipe has no --delta for) are not driven on a simulator; the rules they reach are HarnessKit's (DockArmingTests, RouterSheetTests, StickToBottomTests, RunSectionsTests)";
const DOCK_DRAG =
  "dropped (human decision): a swipe-away of the presented sheet needs a flick AXe can't send with velocity; the rule is HarnessKit's (RouterSheetTests.aSystemDismissalClosesTheTicketAndDocksOnlyOnTheArmedRelease)";
const ANIMATION = "dropped (human decision): pixel or video evidence of an animation (frames recorded across the transition) is not carried";
const KEYBOARD =
  "dropped (human decision): the prompt editor's cursor-follow above the keyboard and the pixel check of the screen edge behind the keyboard's corners are not carried; the walkthrough's keyboard screen asserts the composer's and New session's geometry";
const SCENE = "real UIScene creation: a window of its own (the pop-out) is made by the system, not by anything a screen shows";
const MEMORY = "process memory footprint, measured on the running app rather than shown by a screen (accepted: the human said fine)";
const RELAUNCH = "a real quit-and-relaunch of the app: the walkthrough is one launch with no relaunch pass; what is saved across a launch is pinned in HarnessKit where it is logic";

/** sim-check functions whose behaviour the single walkthrough can't carry: the ticket's expected losses. */
const SIM_LOSSES: { group: RegExp; reason: string }[] = [
  { group: /^sheetChecks$|^stickChecks$|^pagingChecks$/, reason: GESTURE },
  { group: /^dockStackChecks$|^fileDockChecks$/, reason: `docked tickets and files: ${DOCK_DRAG}` },
  { group: /^panelChecks$|^cardStackChecks$/, reason: IPAD },
  { group: /^keyboardChecks/, reason: KEYBOARD },
  { group: /^memoryChecks$/, reason: MEMORY },
];

/** Checks decided by what they do, ahead of their function's reason. */
const SIM_NAME_LOSSES: { name: RegExp; reason: string }[] = [
  { name: /quit and relaunched|survives a relaunch/i, reason: RELAUNCH },
  { name: /^the pop-out button moves the panel's ticket into a window/, reason: SCENE },
  { name: /^the dock's close button sends it away without opening it/, reason: ANIMATION },
  { name: /keyboard/i, reason: KEYBOARD },
  { name: /ipad/i, reason: IPAD },
];

/**
 * Old sim-check checks whose decisive logic a HarnessKit swift test pins, matched by the check's name. Each lists the
 * tests as `Suite.function` (scripts/report.test.ts checks they exist). These win over every loss rule below: the
 * simulator only added the taps, scrolls and keyboard that reached the logic.
 */
export const HARNESSKIT: { name: RegExp; tests: string[] }[] = [
  { name: /^the Done column scrolls into older pages$/, tests: ["BoardLoaderTests.endReachedTwiceBeforeARenderAsksOnce", "BoardLoaderTests.shouldAutoFill"] },
  {
    name: /^search finds a done ticket that isn't loaded$/,
    tests: ["BoardLoaderTests.searchIsDebouncedToOneRequestForTheLastTextOfABurst", "BoardLoaderTests.searchLoadMorePagesWithTheCursorOnce", "BoardLoaderTests.aSlowResponseForAnEarlierQueryNeverOverwritesANewerOne"],
  },
  // The hide on scrolling forward, the show on scrolling back and the clamp that doesn't bring it back are the state machine;
  // the 4+10+4 pt title alignment the check also measured is layout and is not pinned.
  { name: /^the hero collapses on scrolling the Spec and stays collapsed scrolling back$/, tests: ["HeroCollapseTests.step", "HeroCollapseTests.drivenByPhases"] },
  { name: /^the dock survives a tab change, and a tap restores the sheet where it was$/, tests: ["RouterSheetTests.dockingKeepsThePathAndRestoringBringsItBack", "RouterSheetTests.aTabLinkDocksThePresentedSheetAndKeepsTheDock"] },
  {
    name: /^with 3 docked, two cards and .*1 more….* expand into the list, whose oldest opens at its saved path$/,
    tests: ["DockCardsTests.pastTheLimitAMoreCardCountsTheRest", "RouterSheetTests.liveShownAndOverflowSheetsSplitTheDock", "RouterSheetTests.aCardChosenFromTheMoreListOpensAtItsSavedPath"],
  },
  { name: /^a card's ✕ closes only that ticket$/, tests: ["RouterSheetTests.closingADockedCardLeavesTheOtherCardsAndOpensNoPanel", "RouterSheetTests.closingTheTopLeavesTheNextDocked"] },
  { name: /^the dock comes back after the app is quit and relaunched$/, tests: ["RouterDockPersistenceTests.theDockRoundTripsDockedWithItsOrderAndPaths"] },
  { name: /^Projects closes every docked ticket$/, tests: ["RouterSheetTests.projectsClosesTheTicketSheetPresentedOrDocked"] },
  { name: /^a file opened from a link is its own card next to the ticket's$/, tests: ["RouterSheetTests.aFileOpensAsItsOwnSheetNextToTheTickets"] },
  { name: /^tapping the ticket's card and the file's card switches between them$/, tests: ["RouterSheetTests.filesAndTicketsWaitInTheSameDock"] },
  { name: /^opening the docked file again focuses it instead of adding a card$/, tests: ["RouterSheetTests.openingADockedFileAgainFocusesItWithoutDuplicating"] },
  { name: /^a dirty file card's Close asks, and Discard closes the card$/, tests: ["FileEditRulesTests.leavingADirtyFileSavesOrAsksButNeverDrops", "FileEditorModelTests.discardedEditsIgnoreLateEditorEvents"] },
  {
    name: /^a failed save as a file card closes keeps the edits/,
    tests: ["FileEditorModelTests.editsAFailedLeaveSaveKeptComeBackDirtyAndSaveable", "FileEditorModelTests.aFailedSaveStaysDirtyAndSaysWhy"],
  },
  { name: /^a file card's ✕ closes only it$/, tests: ["RouterSheetTests.closingAFileCardKeepsTheOthersAndDocksTheNext"] },
  {
    name: /^a slow drag along the panel's top edge short of halfway, or a 10pt flick, springs back; a fast fling closes the ticket$/,
    tests: ["PanelReleaseTests.shortFlicksSpringBackWhateverTheMomentum", "PanelReleaseTests.aLongSlowDragShortOfHalfwaySpringsBack", "PanelReleaseTests.fortyPointsWithAProjectionPastHalfCloses"],
  },
  { name: /^a card's ✕ closes just its ticket without opening it$/, tests: ["RouterSheetTests.closingADockedCardLeavesTheOtherCardsAndOpensNoPanel"] },
  // The check asserts only the bar-to-dock gap and never looks at a keyboard.
  {
    name: /^the bar keeps its place above the dock after the palette's keyboard comes and goes$/,
    tests: ["DockMetricsTests.theComposerSitsABarGapAboveTheDockOnlyWithCardsAndNoKeyboard", "DockCardsTests.theDockHidesUnderAnythingOverTheTicket"],
  },
  {
    name: /^a ticket docked with the keyboard up reopens from its card at its scroll position with its draft$/,
    tests: [
      "ScrollRestoreTests.theFirstReadingScrollsToTheSavedOffsetAndKeepsAskingUntilItIsThere",
      "ScrollRestoreTests.itGivesUpAfterTheWindow",
      "ScrollRestoreTests.thePersonScrollingCancelsTheRestore",
      "RouterSheetTests.dockingKeepsThePathAndRestoringBringsItBack",
    ],
  },
  {
    name: /^the composer sits on the keyboard with another ticket docked, and the dock steps aside$/,
    tests: [
      "DockMetricsTests.theSheetKeepsRoomForTheDockOnlyWithCardsAndNoKeyboard",
      "DockMetricsTests.theComposerSitsABarGapAboveTheDockOnlyWithCardsAndNoKeyboard",
      "DockMetricsTests.onlyAKeyboardTallerThan100PointsIsTheSoftwareKeyboard",
      "DockLabelsTests.theDockHidesUnderAnythingOverTheTicket",
    ],
  },
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
  { name: /^\$\{tab\} opens at the bottom$/, screen: "transcript and activity stick" },
  { name: /^\$\{tab\} follows new content while at the bottom$/, screen: "transcript and activity stick" },
  { name: /opens its ticket in a sheet over the board$/, screen: "ticket sheet" },
  { name: /^a second ticket joins the dock as a second card, the newest at the bottom with its ref and title$/, screen: "dock stack" },
  { name: /^with a ticket open and another docked, the card shows over the sheet and the composer sits above it$/, screen: "dock stack" },
  { name: /^switching cards while a ticket is open keeps the dock mounted: only the swapped card changes$/, screen: "dock stack" },
  { name: /^a picker the ticket screen opens itself \(not the Router\) hides the dock over the sheet and gives it back on Done$/, screen: "dock stack" },
  { name: /^linking other lines of the docked file scrolls its editor there$/, screen: "file relink" },
  { name: /^a tap at the bottom of New session's prompt row focuses it$/, screen: "new session prompt focus" },
  { name: /^dragging the sheet to the bottom docks it under the board, titled by the ticket on top$/, screen: "sheet dock drag" },
  { name: /^a sideways swipe changes tab and back$/, screen: "transcript and activity stick" },
  { name: /^ticket composer sits on top of the keyboard$/, screen: "keyboard geometry" },
  { name: /^New session's prompt grows with every line typed$/, screen: "keyboard geometry" },
  { name: /^a board card opens its ticket in the side panel against the trailing edge$/, screen: "ipad side panel" },
];

export function dispositionOf(row: Row): Disposition {
  if (row.lossReason) return { status: "loss", reason: row.lossReason };
  if (row.ref) return { status: "new", ref: row.ref };
  if (row.kind === "swift") return { status: "kept", reason: "HarnessKit's swift test needs no simulator and stays; it also decodes the service's golden files" };
  if (row.kind === "sim-check") {
    for (const h of HARNESSKIT) if (h.name.test(row.name)) return { status: "harnesskit", ref: h.tests.join(", ") };
    // Asserted by a walkthrough screen although its name says relaunch: the screen checks the saved choice after leaving it.
    if (/^usage: the filter shows one driver, and the choice survives a relaunch$/.test(row.name)) return { status: "walkthrough", ref: "next/walkthrough/ios.ts › plan usage" };
    // A screen that asserts a check carries it, whatever loss rule its function or name would otherwise have got.
    for (const c of SIM_WALKTHROUGH) if (c.name.test(row.name)) return { status: "walkthrough", ref: `next/walkthrough/ios.ts › ${c.screen}` };
    for (const l of SIM_NAME_LOSSES) if (l.name.test(row.name)) return { status: "loss", reason: l.reason };
    for (const l of SIM_LOSSES) if (l.group.test(row.group)) return { status: "loss", reason: l.reason };
    if (/leading > shows only commands/.test(row.name)) return { status: "kept", reason: "the > prefix is pure logic that HarnessKit's PaletteTests already pin (greaterThanListsOnlyCommandsEvenWhenATicketAndAPathMatch); a typed query on a simulator added only the keystrokes" };
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
  : d.status === "harnesskit" ? `HarnessKit: ${d.ref}`
  : d.status === "loss" ? "accepted loss"
  : "kept";
