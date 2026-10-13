# Changelog

This file tracks releases of the Harness Mac and iPhone/iPad apps. Each release is an annotated git tag
named `app-YYYYMMDD.HHMM` (the UTC minute the release was prepared) with a GitHub release of the
same name that carries the iPhone IPA and the Mac zip. CLAUDE.md has the release steps.

Add entries under [Unreleased] as changes land on `main`, grouped as Added, Changed, Fixed, or
Removed. `bun run release:prepare` moves them into a section for the next tag.

## [Unreleased]

### Added

- For people working on Harness: `bun run verify` now also runs the iPhone snapshot tests (a real app build) when you change HarnessKit sources or `ios/Tools/build.ts`, `build-cache.ts` or `snapshots.ts`; HarnessKit tests alone still run only `swift test`.
- For people working on Harness: a test checks that the simulator build sets `SIM_CHECK` and the device build doesn't.

- For people working on Harness: `bun run verify` runs only the test layers your diff needs. It maps the changed files (against `main`, or `--base=<ref>`, plus the working tree) to bun tests (scoped to the package when that is safe), typecheck, `swift test`, the closest Mac app check, and the iPhone snapshot tests and sim-check chain for the screens touched, runs the light layers together, checks `bun run sim disk` before any simulator layer, prints one line per layer and exits 1 if any failed. `--dry-run` prints the plan with the reason for each layer, `--all` runs everything, and a file no rule knows falls back to bun tests plus typecheck. The mapping is one tested module, `scripts/verify-plan.ts`, and `bun run test` now runs the repo-root scripts' tests too.
- For people working on Harness: CLAUDE.md's verification and simulator guidance is rewritten around `bun run verify` and the lowest test layer that can see a bug (HarnessKit tests, then snapshot tests, then a narrow sim-check with `--only --grep --reuse --no-build`), so agents stop over-running slow layers. The hard rules (iOS 27.0 only, shared simulators, the lock, the disk check, no runtime installs) are unchanged.
- For people working on Harness: agents no longer queue on one shared simulator. `bun run sim with-lock` (and `sim-check`, `dev-sim`) takes the first free simulator of a pool of two (`harness-shared`, which already exists and is reused, and `harness-shared-2`; `HARNESS_SIM_POOL_SIZE` changes the count). The second simulator is created only when the first is held and 8 GiB of disk is free (a simulator grows 3–8 GB), one creation at a time, and a Mac short on disk waits on the existing simulators instead of failing. `sim-check --reuse` goes back to the simulator its kept run (with a live daemon) used when it's free, and otherwise takes another. `sim shutdown` and `status` cover every `harness-shared-N` simulator that exists, and `ensure --all` the configured pool; `--ipad` keeps its single simulator.
- For people working on Harness: one way to run the real service in tests and check scripts. `@harness/shared/testing/daemon` starts `service/src/daemon.ts` with the dummy driver in a throwaway home, waits until it answers (and has written its token), hands back its base URL, token and an API client, and stops it with its Chrome. A daemon that never becomes ready, or exits early, is stopped and its home removed before the error (which carries the tail of its stderr) is thrown. `until` and `freePort` live there too.
- For people working on Harness: `@harness/shared/testing/seed` (git-init'd seed repos that seed once, direct database writes for settings, session context and compact runs) and `@harness/shared/testing/proxy` (a proxy in front of a test daemon that can answer a route, report what a socket sends, or push an event). sim-check, dev-sim and the app's check scripts use them instead of each carrying its own copy.
- For people working on Harness: `bun run --cwd app world` boots the seeded world the Mac checks run in (the real daemon, five projects, a ticket in every state) and leaves it running, so `HARNESS_URL=… HARNESS_TOKEN=… bun run --cwd app dev` opens the app on realistic data. It replaces `bun run --cwd app mock`.
- For people working on Harness: the iPhone and iPad app built for the simulator by `ios/Tools/build.ts` (`sim-check`, `dev-sim`; compiled in only with `SIM_CHECK`, so never a device build, even a Debug one, or a release build) writes a debug state probe to its container: the router, dock and editor state (marked lines, selection, dirty flag, scroll) and whether the screen is at rest, as JSON documented in `ios/ARCHITECTURE.md`. `sim-check` asserts on it, so the editor-link check reads the marked lines directly instead of an accessibility value that was added only for tests (that `file-editor` element is gone).
- For people working on Harness: `sim-check` waits for the app to settle (no animation or scroll in flight, nothing changing) instead of sleeping, in most of the places that used fixed `Bun.sleep` waits (112 before, 33 now), so the modes run faster and a slow machine no longer needs longer sleeps.
- For people working on Harness: `bun run sim snapshots` renders the iPhone and iPad app's main screens (board, a ticket's Spec and Activity tabs, a sheet, the dock, light and dark) in-process from fixture models and compares them with reference images, in seconds and with no daemon, install or pairing. A mismatch prints the reference, actual and diff image paths; `--record` updates the references and `--out=<dir>` writes the renders for a spec's Status screenshots.
- For people working on Harness: `sim-check --grep=<pattern>` runs just the checks whose names match (a case-insensitive substring, or `/regex/flags`), so debugging one new check no longer reruns a whole `--sheets` pass. A check that starts from what an earlier one left on screen declares it, and those earlier checks run first as setup; a pattern that matches nothing fails and lists the nearest check names.
- For people working on Harness: `sim-check --reuse` attaches to what the last `--keep` run left (its daemon, seeded tickets and paired app), skipping the build, install, keychain reset, seeding and pairing, so editing and rerunning one check takes seconds instead of minutes. It reinstalls (keeping the daemon and seeds) when the built app's hash changed, falls back to a full run with a stated reason when no kept state fits, and keeps its state for the next run. `--rebuild` builds first, `sim-check --help` prints every flag, and `bun run sim reap --kept` stops kept daemons and removes their folders.
- For people working on Harness: `sim-check --reuse` is safer. It attaches only to a kept daemon running this checkout's unedited `service/src`, reinstalls when the app on the simulator was installed over by dev-sim or by hand, keeps `bun run sim reap --kept` from stopping a daemon a run is using, no longer mixes `--memory` state with `--sheets`, picks a daemon port nothing is listening on, and a failure before the daemon starts now prints its real error.
- For people working on Harness: `bun run nightly` runs every test layer (bun tests, typecheck, `swift test`, all Mac app checks and the full sim-check on two shards) and prints a report only when something fails: the failing layer, the failing check names and the tail of its log. An example `nightly` watcher (`service/examples/watchers/nightly.json`) runs it once a day, so regressions that slip past a ticket's agent review land in the Inbox and get dispatched to a HARNESS ticket instead of waiting for someone to rerun sim-check.

### Changed

- For people working on Harness: sim-check no longer re-proves logic that a faster test already covers. The context-gauge checks stop reading the gauge's text and menu items (`ContextGaugeTests`), the Models picker check stops asserting the adviser and Defaults patches (`ModelsTests`, `model-selection.test.ts`), and the Approve-and… check stops asserting the stored action and instructions. That last one moved to a service test (`completion.test.ts`) that sends the service every request body HarnessKit's `ApproveTests` fixture builds, so the app and the service can't drift apart. The checks keep the taps and the popovers. The New session mention, Plan first and `/co` checks, the composer's blocked-ticket answer and the Save on blur switch likewise stop reading back what the daemon stored or received: `drafts.test.ts` now covers a draft launched with an `@` file or a slash command, and `http.test.ts` sends the service the launch, Save on blur and message bodies in `Fixtures/launchBodies.json`, which `HarnessClientTests` builds from the app's types. The prompt editor's Save rule and the docked card's label moved into HarnessKit (`Prompts.canSave`, `DockLabels`) with tests.
- The sidebar's Claude plan usage is checked every 10 minutes instead of every 5, and after Claude's usage endpoint answers 429 (or a server error) Harness now leaves it alone for at least the wait the endpoint asks for, doubling up to an hour. Runs finishing and rate-limit warnings no longer re-ask during that wait, which was what kept the "usage endpoint answered 429" error coming back.
- For people working on Harness: the Mac `smoke` and `shoot` scripts, and the plan-usage, browser-size, pop-out, ⌘-click, card-menu, agent-notes, pane-resize, context-gauge and terminal-pane checks, now run against the real daemon with the dummy driver on a seeded database (`app/scripts/lib/world.ts`) instead of an in-memory copy of the service. A check that passes now tells you the service does it, not that a copy of it does. The few things a real daemon can't be asked for (a fixed plan-usage report, a log of the browser input the app sends) go through the world's proxy.
- For people working on Harness: every app script that starts a daemon (`real`, `agents`, `changes`, `approve-plan`, the attachments, groups, tear-off and other checks) starts it through the shared daemon helper. It no longer inherits the app's `HARNESS_LAUNCHD` and `HARNESS_SUPERVISOR_PID`, which had rewritten the daemon's PATH and sent its output to a log file.
- For people working on Harness: the dummy driver's completion run now does what a real agent's git commands do for a worktree ticket: it merges the branch (for "merge") and removes the worktree and branch, so the service's cleanup check passes and the ticket reaches Done.
- For people working on Harness: `ios/Tools/build.ts` no longer reruns XcodeGen on every build: it runs only when `project.yml` or the list of source files under `Harness/` and `Widgets/` changed (the hash is kept in `ios/build/xcodegen.hash`). The "Bundle highlighter" and "Bundle editor" build phases now declare their inputs and outputs, so Xcode skips them while the bundle is current (their inputs include `shared/src`, which both bundles import; a test checks the lists against the bundler's own module graph). A plain Xcode build needs `ios/build/bundle-*.xcfilelist`, which `build.ts` writes. An unchanged rebuild takes about 2 s instead of about 5 s. Seeding a worktree's DerivedData from the main checkout's was tried and doesn't help (the Swift compile is keyed by absolute path, so a copy at another path builds cold in the same ~130 s), so it isn't done.
- For people working on Harness: `build.ts device` skips the `devicectl` install when the built app is byte-identical to the one this checkout last installed on that device and the device still reports the same install location (another worktree, Xcode or TestFlight installing over it forces a reinstall). `--launch` now restarts a running app, and a damaged install record is ignored.
- For people working on Harness: `sim-check` no longer waits out its 12 s "no settled screen" timeout when a link leads to the screen that is already up; with the debug probe it sees the app has settled and goes on, which took about 35 s off `--only=sheet-checks`.
- For people working on Harness: the real-Chrome browser tests are split into smaller files (`manager*.test.ts`, `wait-run`, `wait-timeout` and `browser-run`, with shared fixtures in `test-support.ts` and `wait-support.ts`), so the parallel runner spreads them across workers, each file with its own Chrome and profile. The slowest single file drops from about 50 s to about 20 s when the machine is idle, and the Chrome shutdown hooks wait up to 30 s so a busy machine no longer fails them.
- For people working on Harness: `bun run typecheck` runs its seven `tsc` projects at once (`scripts/typecheck.ts`), about half the wall time. It still exits 1 when any project fails and prints that project's errors under its name.
- For people working on Harness: `bun run test` ends with a "Skipped:" line that counts the tests skipped and says why (no Chrome, no LAN address, no Electron, the opt-in Chrome Web Store test, and so on). Tests declare the reason through `describeIf`/`testIf` in `@harness/shared/testing/skip`, and a skip with no declared reason is reported as such.

### Fixed

- For people working on Harness: `bun run sim snapshots` (and `bun run verify`'s snapshot layer) now takes any free simulator of the pool, or the one a parent `sim with-lock` already holds, instead of always waiting on `harness-shared` while `harness-shared-2` sits idle.
- For people working on Harness: a simulator lock can no longer be deleted out from under the process that just took it (a race when two runs cleared the same dead holder), and a run whose new pool simulator was refused for low disk now creates it once disk frees up instead of waiting up to 30 minutes on a held one.
- For people working on Harness: two `sim-check --reuse` runs started in the same checkout no longer attach to the same kept daemon at once; the second stops with a message naming the run that holds it. The claim re-checks the home after taking the lock, so a run that just ended can't leave the next one attached to a deleted home.
- For people working on Harness: `sim-check` falls back to a fixed wait when an iPhone app's debug probe file is left over from an earlier launch or the app crashed, instead of failing with "timed out: the app to settle" after 10 seconds. It waits for a probe that isn't up yet, and only a probe that never answers turns the probe off for the run; a stale file costs one fixed wait.
- For people working on Harness: `sim-check --reuse` prints a note when Swift files under `ios/Harness` or `ios/HarnessKit` are newer than the built app it is about to install, so a stale build isn't mistaken for current code. Add `--rebuild` to build the current sources.
- For people working on Harness: a check script or dev tool that is killed (Ctrl-C, a tool timeout, `verify` stopping it) no longer leaves its test daemon and Chrome running. `startDaemon` stops the daemon and sweeps its Chrome on exit, SIGINT, SIGTERM and SIGHUP before the temp home is removed (for every check script, whatever home it passes; only `sim-check --keep` opts out), and `sim reap` now also stops orphaned daemons from `harness-daemon-*` homes after 5 minutes and removes their folders. `verify` and `nightly` give a killed layer 10 s to clean up, never signal a bare pid, and no longer hang on a leftover process holding the output pipes.
- For people working on Harness: `sim-check --reuse` no longer attaches to the wrong daemon when a pid was recycled and another kept daemon sits on the port. It confirms the daemon accepts the home's own token before reusing it.
- For people working on Harness: `bun run verify` and `bun run nightly` forward Ctrl-C/SIGTERM to the layer they are running and kill its whole process group, so sim-check and snapshot children release their simulator locks and the run stops instead of starting the next layer. Each layer also has a time limit (45 minutes; `HARNESS_LAYER_TIMEOUT_MS` changes it) after which it is killed and reported as timed out.
- For people working on Harness: the clone-sweep test in `browser/chrome.test.ts` no longer fails when other test files launch Chrome at the same moment. It relaunches until Chrome's code-sign clone is attributed to it, which is best-effort when several Chromes start together.

### Removed

- For people working on Harness: `app/scripts/mock-service.ts` (2,800 lines that re-implemented the service in memory) and `bun run --cwd app mock`.
- For people working on Harness: the stray `service/smoke3.tmp.ts` scratch script.

## [app-20261013.0325](https://github.com/markhuot/harness/releases/tag/app-20261013.0325) - 2026-10-13

### Added

- On iPhone and iPad, a file you open from a link is now its own card in the dock next to your open tickets, instead of a screen stacked on whatever ticket was up. Swipe along the dock (iPhone) or tap its card (iPad) to move between a file and tickets, open the same file again and it comes forward instead of adding a second card, and a file's ✕ closes just it. A file you leave with unsaved edits is saved (or, with Save on blur off, asked whether to save or discard when you close it) and never dropped, and a docked file comes back after a relaunch. A ticket you open from a file's "Open" menu gets a card of its own.
- For people working on Harness: `TicketSheet.Root` has a `.file` case, so the router's docked list holds tickets, New session and files; `Router.push(.file)` presents or focuses a file's card (a ticket window still pushes it on its stack), older saved docks decode unchanged, and sim-check's `--sheets` and `--ipad --sheets` runs now cover a docked file.
- The Mac file pane is now an editor. Files from tickets and projects open in a CodeMirror editor with syntax colors in your theme, and a link like `harness://file/src/app.ts#L10-L20` opens scrolled to and highlighting those lines without selecting anything. Save from the header button or ⌘S; a dot in the header marks unsaved edits. Closing a pane, replacing it with another file, moving it or popping it out with unsaved edits asks first, as does reloading the window; switching to the Diff tab or a failed refresh (which shows a banner) never drops them. A clean pane reloads from disk when the app regains focus, keeping its cursor, scroll and highlight, while one with edits keeps them. Files keep their line endings when saved, CRLF or LF, and a file that mixes them is written back exactly as it was, with only your edits changed. Settings → General has a new "Save files on blur" switch that saves when the editor, the pane or the app loses focus, and when the pane closes.
- On iPhone and iPad, a file you open from a link is now an editor. Tap into the code and type: an amber dot shows unsaved changes and Save (or Cmd+S on an iPad keyboard) writes the file back. A new "Save on blur" switch in Settings → General saves whenever the editor loses focus, you leave the file, or the app goes to the background. With it off, leaving an edited file asks whether to save or discard. A file you haven't edited reloads quietly when you return to the app, and one you have keeps your edits. Autocorrect, smart quotes and auto-capitalization are off in the editor, and a file link still opens scrolled to its lines and marks them. Nothing is selected, so typing never replaces them.
- On iPhone and iPad, the Diff tab of a file is now a side-by-side view of the last commit and the file as it is, and it refreshes after you save.
- For people working on Harness, a new `editor/` package holds a CodeMirror 6 editor and side-by-side merge view that the Mac renderer imports and the iPhone and iPad web view load as a single bundle (`bun run --cwd editor build`). It themes from the app's CSS variables or a token map, picks a language from the file name, reveals a line range without leaving a selection, and reports change, dirty, save (Cmd/Ctrl+S) and blur events, with a `mount(window, post)` bridge for the web view. It is covered by unit tests in `editor/`. Saving confirms the exact contents that were written, so keystrokes typed during an async save stay dirty; a reload from disk can't be undone back to the stale text; diff colours follow the theme tokens (red on the original side, green on the modified); and the web view bridge remembers the last theme and reports bad commands as `error` events.
- The service can now save files the file viewer shows: `PUT /projects/:id/file` and `PUT /tickets/:key/file` take `{path, contents}` and replace the file, last write wins. The file keeps its BOM, CRLF line endings, trailing newline and mode, and the write is atomic. Paths stay inside the project or ticket folder, `.git` is refused (in any letter case, or through a symlink), and binary, non-UTF-8, too-large (over 2 MiB, counted as saved) or NUL-containing files are rejected. A read-only file or a full disk answers with a clear 403 or 507, and a created file shows up in file search right away. Settings also gain a synced `saveOnBlur` switch (off by default) for editors to read, and the Swift and TypeScript clients can call both. The bearer token now also grants file writes. The Mac and iPhone editors that use this come in follow-up changes.
- On the Mac, iPhone and iPad, every tool call in the transcript shows its elapsed time (42s, 3m 5s) just left of the spinner or ✓/✗. It counts up each second while the tool runs and freezes at its final time when it finishes.

### Changed

- The file pane's Diff tab now uses the same editor's side-by-side merge view in your theme, so the Unified/Split switch is gone. Clicking line numbers no longer picks lines; Copy link links to the lines you've selected instead.
- For people working on Harness: `app/scripts/file-pane-check.ts` now drives the editor (range, edit, ⌘S, save on blur, close prompts, diff, theme switch) instead of the old diffs viewer. `@pierre/diffs` stays for the Changes tab and chat code.
- On iPhone and iPad, the file viewer no longer has pull to refresh or line-by-line VoiceOver labels, since the file is now a web view editor. It reloads when the app returns to the foreground.
- For people working on Harness: the iOS build gets a "Bundle editor" step that builds `editor/` into the app next to the syntax highlighter's, `editor/scripts/build.ts` takes `--out <file>`, and the editor opens with unsaved edits as dirty when given what is on disk. The custom file list and its scroll benchmark are gone, and sim-check's `file-link` and new `file-edit` checks cover the editor. The Shiki highlighter stays for chat code blocks and the Changes tab.
- On iPhone, swiping the ticket sheet away now always closes the ticket, however fast or far you swipe, with the system's own momentum and dismissal. To dock it, drag the sheet down and hold your finger in the bottom 40% of the screen for about half a second: a "Dock" card appears at the bottom with a haptic, and letting go docks the ticket and slides its card up. VoiceOver has a Dock action on the sheet instead. Docked tickets are cards over the board. Reopening a docked ticket restores its scroll position, composer draft and keyboard.
- On iPad, dragging the ticket panel by its top edge now closes it only when the drag moved at least 40 points and was headed past the panel's halfway point, carrying your finger's momentum into the slide; a shorter drag springs back. Docking is a hold in the trailing 40% of the screen while dragging, which shows a "Dock" card in the card stack; the panel's dock button and a VoiceOver Dock action still work.
- On the Mac, a file you open from a link or the palette's file browser now gets a new pane on the far right of the window, running its full height at the same fixed width (about 70em) as New session and terminals, wherever focus is, instead of splitting the pane you opened it from. A file already open, or a file pane next to where you opened it, still shows the new file in place. For people working on Harness, New session, terminals and files now share one placement path (`appendAtRightEdge` with `fixedWidthShare`), covered by unit tests in `panes.test.ts` and by `file-pane-check.ts`.

### Fixed

- A file that mixes line endings (say CRLF and LF) now reads as saved after you save it, on Mac, iPhone and iPad, and again when you undo back to what was on disk. Before, it stayed marked unsaved, so leaving it kept saving or asking.
- On iPhone and iPad, edits a card couldn't save when you left can no longer come back later over newer text: nothing is kept while the file is open again, and any successful save clears them. Choosing Discard changes also ignores keyboard commits that land as the dialog opens, so they aren't saved. A link to an open file's other lines now scrolls it there even when the card was parked, still loading, or its editor restarted.
- On iPhone and iPad, a file card that closes while its save fails (a write error with Save on blur on, a card swiped away or closed with ✕) no longer loses your edits: the card comes back with them and "Save failed" showing, and Save tries again. A save that already failed makes closing ask, like Save on blur off does, and the iPad panel's ✕ saves first and stays open if the save fails.
- On iPhone, a docked file whose save failed as the ticket sheet went to the dock keeps its edits: tapping its ✕ on the dock card brings the file back with the edits and "Save failed" showing, instead of closing it and losing them.
- On iPhone and iPad, a link to other lines of a file that's already docked (`harness://file/…#L40-L50`) now scrolls its open editor to those lines and marks them, keeping any edits, instead of only bringing the card forward.
- For people working on Harness: sim-check's Save on blur check now holds the switch down briefly, since the switch ignores the instant tap it sent before and the check could never pass, and `--sheets` covers re-linking lines of a docked file and a failed save as a card closes.
- On iPhone and iPad, closing a docked file card with unsaved edits (Save on blur off) now always asks to save or discard, from the card's Close button or the iPad panel's ✕, and the answer closes that card even if you switched cards while it saved. Before, the iPad panel's ✕ closed an edited file without asking, Discard could leave the card open with later edits lost, and a dirty file behind another card could stop that card's swipe down.
- For people working on Harness: the file pane's saves, its write on closing and a reopened pane's read of the file now run in one order per file, so an older save can't land over a newer one and a save-on-blur fired by both the editor and the window writes once. Typing while a save-then-close is in flight keeps the pane open. `file-pane-check` covers the Diff tab, a failed refresh, replacing a dirty pane and a CRLF file.
- On iPhone and iPad, the file editor is safer with your edits. A save keeps running if you switch apps right after tapping it, "Try again" after a file failed to load now gives you an editor you can save, a file that reloads while you save can't put old text back over your newer edits, a failed reload after a save leaves the editor on screen instead of an error, and leaving the file (or opening a link over it) saves through the same path as Save. Switching to the Diff tab puts the keyboard down.
- On iPad, the ticket panel's content ignores the horizontal safe area, so dragging the panel toward the trailing edge can't squeeze it into the visible sliver. The iPad sim-check now drags the panel partly off the window and fails if its title reflows.
- On the iPad, a ticket panel with its header collapsed no longer leaves an empty band under the title: the tab strip sits right below it.
- On the iPad, docking tickets no longer shortens the board (or any other screen). The docked cards sit over it, the board keeps the full screen height, and its last items still scroll clear of the cards.
- On the iPad, the ticket panel's background now runs up behind the status bar to the top of the screen. The title and buttons stay where they were. For people working on Harness, sim-check's iPad panel checks cover the collapsed header gap and the status bar's colour.
- Flicking the ticket sheet away on iPhone no longer stutters on release, and a tiny flick no longer closes the iPad ticket panel.
- Hold-to-dock is sturdier: an interrupted drag on the iPad panel no longer leaves the "Dock" card stuck, a dismissal the system cancels after an armed release still docks, a small flick can't make the panel's spring-back overshoot, and a reopened ticket no longer snaps back a scroll you make right away, raises the keyboard when you come Back from a child ticket, or keeps stale scroll positions for tickets you pushed inside a closed sheet.
- On the Mac, dragging an open pane now previews the drop on the pane under the pointer, where it is on screen, instead of on the layout as if the dragged pane had already left. The box is the size the pane will have: half of the pane, 40% of the board, or, when you reorder a pane within its own row or column, the dragged pane's own width or height. For people working on Harness, `pane-resize-check` holds a drag and checks the preview's position and size.

## [app-20261012.0049](https://github.com/markhuot/harness/releases/tag/app-20261012.0049) - 2026-10-12

### Added

- The service log (`service.log`) now records every push decision: the ticket, the event, and whether it was sent or skipped and why. When a Mac or iPhone was showing the ticket, the line names the device that held the push back, so a missing push can be explained from the log.
- `GET /notifications` also lists who is connected right now: each client's device id, platform, whether it is visible and the tickets it shows.
- A ticket can have several pull requests. Agents set the list with `update_ticket`'s `pull_request_urls` (including their own ticket during a work run, for a pull request they opened outside the completion), and a completion's `record_pull_request` adds to it instead of replacing it. Each pull request shows its title, fetched from GitHub with `gh`: the Mac and web app's Details tab has a "Pull requests" row to add, remove and refresh them, the iPhone and iPad Details tab has the same, and the ticket shows one "PR #n" badge per link, with the title as its tooltip. `get_ticket` and `list_tickets` return each pull request's URL and title. A title stays empty when `gh` is missing, not logged in to the host, or the link isn't a pull request; refresh tries again.

### Changed

- The Agent notes on a ticket's Details tab start collapsed, on the Mac and on iPhone and iPad. Click or tap "Agent notes" to open them and again to close them; a ticket with no notes still shows no field. For people working on Harness, `app/scripts/agent-notes-check.ts` covers the Mac toggle and a sim-check `agent-notes` chain covers the iPhone one, so a change that opens the notes by default fails them.
- Recording a pull request the ticket already lists moves it to the end of the list, so the Changes tab's commit and the card's PR badge name the same pull request. The completion and reopen prompts quote each pull request title on one line, cut at 120 characters, so a long or odd title on GitHub can't change what the agent is told.
- For the people working on Harness: the pull request title lookup and refresh now have tests for failed lookups, retries on start, the four-lookup limit and repeated refreshes.
- On iPhone and iPad, the ticket detail sheet now shows the status indicator (colored dot and label) on its own line above the title when expanded, pushing the title down. When collapsed, the status indicator is hidden and only the truncated title shows.
- On the Mac, the ticket's "Pull requests" row keeps each pull request on one line: the "PR #n" label, then its title cut with an ellipsis when the panel is narrow (the full title and URL are in the tooltip), then its remove button. The add field, Refresh titles and the hint below it stay on one line too.

### Fixed

- A ticket's pull request title is no longer erased when a refresh can't reach GitHub: the title already shown stays until a lookup answers. A lookup that couldn't run (`gh` missing, timed out) leaves its pull request untitled until the next start retries it, instead of showing no title for good.
- A pull request URL with stray spaces is saved trimmed, so it matches the same link typed without them and doesn't show up twice.
- A pull request title that arrives while an older copy of the ticket is on its way to the board is no longer replaced by that copy, so the badge keeps its title.
- An agent in a work run can name its own ticket by an earlier key (after a project rename) when it edits the ticket's pull requests.
- Pushes no longer go missing while the Mac app is open and the Mac is away. The Mac app used to count a sleeping display as "on screen" and silenced pushes for every ticket on its board; it now reports nothing on screen while the screen is locked, the Mac is asleep, or you've been idle for a minute, and reports again as soon as you're back.

## [app-20261011.1314](https://github.com/markhuot/harness/releases/tag/app-20261011.1314) - 2026-10-11

### Added

- A new **Adviser** model setting sits next to Planning, Work, Review and Complete, in the Mac and iPhone/iPad model pickers for Settings, a project and a ticket (and in the `update_settings` tool). Planning and review runs on Claude Code launch an adviser subagent on that model when it differs from the run's own: a planner consults it on the first draft and when your feedback changes the approach, and a reviewer consults it after the tests pass and the spec is met, unless the change is clearly UI or copy only. The reviewer passes the adviser's findings to `review_decision` unedited, and they show in the review's Activity entry under "Adviser review"; the planner folds the advice into the spec or lists what it rejected under Open questions.

### Changed

- New installs run Planning, Work and Review on Sonnet, the Adviser on Opus and Complete on Haiku, so the cheaper model does the bulk of the work and Opus is billed only for the judgment calls. Models you already chose are left alone.
- Planning and review runs on Claude Code may launch subagents in every permission mode, including read-only, so the adviser can be reached.
- The Mac model picker is a little wider to fit its fifth column.
- Docked ticket cards on iPhone and iPad are 12pt shorter (52pt, 4pt less above and below their text), with the sides unchanged, so the dock takes less of the board.

### Fixed

- The Mac check's mock service now pins the driver and model a new ticket asks for, as the real one does, so the "Defaults puts the ticket back" check passes again.
- The iPhone models-picker check closes the sheet with Done (it looked for a Cancel button that isn't there).
- On iPhone, the bottom docked ticket card is the same height and text size as the cards stacked above it (it had been drawn about 14% smaller, card and sheet both), and the docked sheet no longer shows a drag grabber, since a docked card opens with a tap. sim-check's docked-stack check now fails if the cards differ in height.
- Dragging the ticket sheet down on iPhone no longer makes the ticket shift under your finger. The header, tab strip and transcript now move down together as one piece, and a long transcript stays where it was instead of snapping back to its bottom. The header no longer scrolls on its own: it is as tall as its content.
- The iPhone checks (`sim-check --sheets`) now measure the docked sheet's own height against the card above it and fail if its grabber is showing, so the bottom docked card can't shrink again unnoticed.
- The iPhone checks (`sim-check --sheets`) now record a slow drag on the Transcript and Spec tabs and fail if the ticket changes shape while the sheet moves.

## [app-20261010.2258](https://github.com/markhuot/harness/releases/tag/app-20261010.2258) - 2026-10-10

### Added

- A ticket's Transcript opens each run with a header on Mac, iPhone and iPad: the phase, driver and model on the left and the start time on the right, like "Work • Claude Code, Opus 5.5". It stays pinned at the top while that run's messages scroll under it, and the next run's header pushes it off. It replaces the centered "Run started (…)" line. Your own messages sit between runs with no header above them.
- A board card's menu now offers the ticket's own actions, so you can move a ticket along without opening it: long-press a card on iPhone and iPad, or right-click it on the Mac. A planning card offers Start work (or Approve plan while its planning run is going), a review card Approve (with all its ways to approve) and Request changes, a done card Re-open, and every card the items from its … menu (Run or Re-run agent review, Move to done, Cancel run, Delete ticket) that apply. Actions that need input open the same notes sheet, instructions sheet or delete confirmation as the ticket screen. The menu follows the same rules as the ticket screen, so a conductor-managed ticket offers no Approve and drafts offer none of these.
- An agent can send its own ticket back to Planning when you ask it to re-plan or rethink the approach (a new `return_to_planning` tool, available while it works or answers your message in a chat). Its run ends and a Planning run on your Plan model redrafts the spec, in a fresh conversation that gets the agent's reason and your message. Press Start to resume in the same worktree on your Work model. If you say you don't need to review the new plan, the agent can approve it up front: the card shows "Starts after planning" and work resumes on the Work model as soon as the Plan run ends. Without that, a child ticket that waits on dependencies no longer starts on its own after the re-plan.

### Fixed

- A ticket whose merge didn't actually happen no longer shows as Done. When a completion run ends without its branch in the base branch (a conflict it gave up on, say), the ticket moves to Blocked with a reason naming the branch, so you answer and the agent finishes the merge.

### Changed

- On the Mac, a new session opens as the rightmost pane of the window, running its full height, at a fixed width of about 70em (910px), wherever focus is. The panes already open shrink to make room, so a session no longer ends up tiny after a few splits. In a narrow window it takes whatever the other panes leave, and once open it resizes like any other pane. New terminals open the same way. Files and tickets open where they did.

- Dragging an open ticket on iPhone and iPad now follows one rule when you let go. A fast swipe (faster than before, so a lighter flick counts) closes the ticket, a slower drag that reaches 60% of the way docks it, and a shorter one springs back to full size. On the iPad's side panel a fast fling now closes the ticket instead of docking it. A flick also still closes the ticket when the app is busy, which sometimes docked it instead before. Scrolling a ticket's content, even with a fast fling back up, no longer closes or docks it: only a drag that moves the sheet itself counts.
- Dividers in the Transcript ("Run finished", "Waiting for a background task", "Moved to review" and the rest) now read left to right: the text on the left, a rule filling the gap, and the time on the right. Long text wraps and the time stays on the right.
- The Mac ⌘K palette's ticket commands now come from the same list as the buttons and card menu, so a review ticket no longer offers Move to done there and a compacting ticket offers only Cancel run.
- The ticket screen's buttons and … menu on iPhone, iPad and Mac, and the new card menus, now read one shared list of the ticket's actions per platform, so what a card offers can't drift from what its ticket screen offers. The Mac smoke check's Base branch row expectation now says "Models", matching the app.
- Completion runs can now ask you something. If a merge hits a conflict that needs a decision, or `gh` isn't logged in, or cleanup would lose commits, the agent calls `block` and the ticket moves to Blocked with its question, instead of finishing as Done. Your answer starts new work, and the ticket goes through Review again.
- On iPhone and iPad, a ticket's header is less crowded. The context gauge moves to the end of the row with the ticket key, so the title can run the full width. The project, status and Conductor pills are gone; a colored status dot now leads the title instead (VoiceOver still reads the status). On iPhone, the expanded title sits 25pt below the top, clear of the sheet's rounded corner, and the space under the header is 14pt, down from 28pt when collapsed.
- On the Mac, a ticket's header matches the iPhone and iPad one. A colored status dot leads the title in the pane's titlebar, and the row under it starts with the ticket key and ends with the context gauge. The project, status and Conductor pills are gone, and the driver now comes before the model. The Children tab is the only sign a ticket is a conductor.

## [app-20261010.1050](https://github.com/markhuot/harness/releases/tag/app-20261010.1050) - 2026-10-10

### Added

- A ticket's header shows a context gauge on Mac and iPhone/iPad: how many tokens of conversation
  the ticket's agent re-reads on every model call, split into cached (cheap) and fresh (costly),
  counting toward a limit (250k by default; change it in Settings or from the gauge's menu) and
  turning red past it. An amber badge counts cache misses, the model calls that had to write the
  whole conversation into an expired cache, which is how a long wait quietly multiplies a ticket's
  cost. Tapping the gauge offers **Compact** (summarize the session and continue from the summary,
  with the message box and ticket buttons disabled while it runs) and **New session** (the next run
  starts fresh), and ⓘ buttons explain what is measured. Claude Code and the Anthropic API report
  exact counts; GitHub Copilot reports them from its session log (or an estimate marked with an
  asterisk) and can only start a new session.
- The bottom of the sidebar shows your plan's usage limits on Mac and iPhone/iPad: Claude's 5-hour
  and weekly windows and, when your account has a quota, Copilot's monthly premium requests, each
  with its percentage and reset time. A menu picks which drivers to show and switches to
  **Projected at reset**, which shows whether the agents are on pace to run out before the window
  resets. When the numbers can't be read the row says why.
- `bun run --cwd app ticket-header` drives a Mac ticket pane against a real service and checks the
  title bar, the hero's key row and the ··· menu in each state, with screenshots. The iPhone and iPad
  sim-check also check the new header, the ··· menu and flinging the panel's top edge.
- A ticket's Runs list on Mac and iPhone/iPad is easier to read. Each run shows its status, kind and
  prompt (or error), with how long it ran (counting up live while it runs, or how long it has waited
  in the queue) and, on a line below, when it started, its token count (the input/output split on
  hover on Mac, beside it on iPhone/iPad) and its cost when the driver reports them. The driver and
  model appear only when a run used something other than the default for its phase, so a ticket
  that overrides its Work model shows it on each of its runs. Runs from before this release show
  what they have.
- On a planning ticket whose plan is still being written, the Start button reads **Approve plan**
  (in the ⌘K palette too). Press it and the ticket stays in Planning while the plan run finishes,
  then its work starts on its own against the final plan, even if the plan ends with a question.
  The button becomes a disabled **Starts after planning** with a clock, and the board card shows the
  same clock, on Mac and on iPhone and iPad. Cancelling the run, a failed or interrupted plan run,
  or sending the ticket a message withdraws the approval and says so in Activity. If the ticket also
  waits on dependencies, it starts once the plan run is over and they're done. An agent's
  `start_ticket` does the same, and its reply tells the agent when it only approved the plan. When the work starts from an approval, Activity credits whoever approved it, a person or an
  agent.

### Changed

- sim-check, the simulator check for the iPhone and iPad apps, is much faster again and no longer takes screenshots while it validates. The default run opens each route to confirm the app survives it and runs only the real-tap checks (gestures, sheets, keyboard, relaunch); logic that unit tests already cover (routing, counts, request bodies, approve and start flows) was removed from it. Screenshots are opt-in for people working on Harness: `--screens` shoots the whole catalog, `--only=<name>` shoots one screen or runs one check, and `--shot='harness://ticket/{headings}?tab=spec'` takes a one-off light and dark pair of any route. A run seeds only the tickets its selection needs, a step that leaves a menu or sheet open is reset instead of stalling the steps after it, each check has a 90 s cap, and the slow memory check is `--memory`. Agents are told to validate the area they changed and shoot only the screens they touched. `--ipad` runs on a kept `harness-shared-ipad` simulator instead of creating one each run (the default run takes about 2 minutes, `--sheets` and `--ipad --sheets` about 90 s, `--ipad` about 30 s).
- Heading sizes and spacing in specs, and the dock's gap and "N more docked tickets" label, now live in HarnessKit with their own tests instead of being measured from the simulator.
- On iPhone and iPad, a ticket you opened from another one (a child, a parent, a link) now has its
  Back button on the same row as its title, with the "Part of" line above the title beside it,
  instead of in a navigation bar over them; swiping back still works. In the iPad side panel, the
  title, its chevron and the dock, pop-out and close buttons are all centered on one line.
- On iPhone, a ticket's collapsed title row has twice the space above and below it, and its text
  lines up with the left edge of the Spec tab's label beneath it.
- "Re-run agent review" (or "Run agent review" when it was skipped) moved from the action row into
  the ··· menu on Mac, iPhone and iPad. A ticket that's in progress now shows a disabled "Working…"
  button before the ···, so its action row isn't empty.
- A ticket's header is shorter on Mac and iPhone/iPad, and the ticket's title now leads it. On
  iPhone the sheet starts with the title right under the drag indicator, with no navigation bar and
  no HARNESS-123 title (a ticket pushed inside the sheet keeps its Back button and has no title). On
  iPad the side panel starts with the title, wrapping before the dock, pop-out and close buttons,
  which float over its corner; you can still fling the panel's top edge to dock it. On Mac the pane's
  title bar shows the title (truncated with an ellipsis in a narrow pane) beside its pop-out,
  maximize and close buttons. Below it, the ticket's first row is now `[HAR] HARNESS-123 <status>`
  followed by the existing badges, on iPhone, iPad and Mac.
- The less common actions moved into one secondary **···** button at the end of the ticket's action
  row, always shown (collapsing the hero on iPhone and iPad hides it with the other actions). It
  offers Move to done (renamed from Mark done, and only where it applied before), Cancel run while a
  run is busy (it no longer has a red button of its own), and Delete ticket, which still asks first.
  The ⌘K palette's Mark done command is now called Move to done.
- Agents are held to a higher bar before they hand work over, whichever model runs them. A Work run
  adds tests for what it changes, runs the tests and typecheck, confirms a new worktree has its
  dependencies installed, embeds screenshots in Status for visible changes, and blocks to ask rather
  than submitting work it couldn't verify. The review agent now requests changes, instead of
  noting a nit, when a behaviour change has no test, a visible change has no screenshot, or Status
  admits a check was skipped. Status no longer carries test results. CLAUDE.md also lists how to
  verify changes in this repo.

- For people working on Harness: `bun run spec-headings` (`app/scripts/spec-headings-check.ts`) launches
  the built Mac app and checks that spec headings render at four decreasing sizes and that a heading
  right after another heading sits close to it. `bun run sim-check` does the same on the iPhone: a
  new spec with every heading level is screenshotted and its heading heights and gaps asserted.

### Fixed

- On iPhone, the last row of a ticket's Transcript and Activity is no longer clipped under the message box when the list is scrolled to the bottom. The page's bottom inset was measured only while the header wasn't sliding, so a tab opened with the header collapsed kept an inset of zero.
- Headings in a spec (and other markdown) on Mac and iPhone/iPad now have a full size scale, so
  `#`, `##`, `###` and `####` each look different (H2 and H3 used to be the same size). A heading
  right after another heading no longer gets the large gap above it; only a heading after other
  content does.
- Pressing Start (or an agent's `start_ticket`) while a plan run was still going moved the ticket
  to In progress at once, with the work run queued behind the plan. It now approves the plan and
  leaves the ticket in Planning until the plan run ends.

### Removed

- The ticket header's overflow menus are gone: the (···) menu on iPhone and iPad, and the More menu
  in a Mac ticket pane's title bar. Copy key, Open in New Window, Open <remote ID>, Open pull request
  (the PR badge in the hero still opens it) and the Mac's Move pane rows no longer appear in a ticket.
  Copy key is still in a board card's long-press menu on iPhone and iPad and in the Mac's ⌘K
  palette, a Mac pane still moves by its drag grip, and a pinned iPad window's **Return to ticket** is
  now a plain button.
- Setting a ticket's status to In progress through the API (`PATCH /tickets/:key`) or an agent's
  `move_ticket` no longer starts it, and is refused. Use Start (`POST /tickets/:key/start`,
  `start_ticket`), or Re-open for a done ticket. Moves to Planning, Blocked, Review and Done work
  as before.

## [app-20261008.2352](https://github.com/markhuot/harness/releases/tag/app-20261008.2352) - 2026-10-08

### Added

- The Agents & tasks tab on iPhone and iPad has the same filter as the Mac: Agents and Tasks
  toggles pinned above the list, each with its count. One pressed shows only that kind, and both or
  neither show everything. The filter stays put while you open a row and come back, and with one
  kind filtered and none of it present the list says "No sub-agents yet" or "No background tasks
  yet".
- sim-check gives the background-task ticket two sub-agents as well and taps through the filter on
  the simulator, saving `ticket-agents-filter-all` and `ticket-agents-filter-tasks` shots.
- On iPhone and iPad you can dock as many tickets as you like and switch between them. Docked
  tickets wait as small glass cards, each with a status dot (green for done, red for blocked), the ref,
  as much of the title as fits and an ✕. Tap a card to open that ticket. iPhone shows two cards and
  iPad five; past that, an "N more…" card opens a scrolling list of them all over a soft blur that spans the screen. The list
  fades out under its top edge rather than running under the status bar, and a short list sits
  just above the dock. On iPhone, a swipe
  along the dock moves to the next one. With a ticket open, long-press its title to switch to
  another docked ticket. Docked tickets are still there after you reopen the app.
- Pick the driver and model for each run phase (Planning, Work, Review and Complete) in app
  Settings, project settings and a ticket's settings, on the Mac and on iPhone and iPad. One
  dropdown lists every driver's models with a radio column per phase, so a ticket can plan on one
  driver and work on another. A phase you leave alone inherits from the project, then the app.
  Conductor and chat runs use the Work choice. Changes apply to the next run, even while one is
  going.
- Completion runs use Haiku out of the box, which makes landing approved work (merge or PR, then
  clean up) far cheaper. Change or clear it in Settings.
- Agents can set per-phase choices with `phase_models` on `create_ticket`, `update_ticket`,
  `update_settings` and the project tools.

### Changed

- The per-phase Models picker's first row is now **Defaults** instead of a long "Inherit (Sonnet 5.5
  · Planning: Opus 5.5 …)" line that got cut off. The models it inherits are listed right under it,
  each one under its phase's radio when the names fit, or one line per phase with the phase in bold
  when they don't (long model ids, defaults that span several drivers, large text sizes). On
  iPhone and iPad the Models sheet also drops Cancel: refresh moves to the left and a **Done**
  checkmark on the right closes the sheet (your picks were already saved when you tapped them).
- Opening a ticket while another is open or docked now adds it to the dock instead of replacing
  the other one. A card's ✕, or a swipe down on the iPhone dock, closes only that ticket.
- On iPhone the other docked tickets' cards stack above the dock, lifting the board's bottom bar
  with them. On iPad the
  docked cards wait in the bottom-right corner, stacked with the newest at the bottom, instead of
  as a pill on the right edge, and they never cover the sidebar.
- sim-check's `--sheets` run (iPhone and `--ipad`) now checks several docked tickets: the cards,
  switching, closing one at a time, the "N more…" list, the dock surviving a relaunch and the
  app's memory with 5 and 20 docked.
- The single default model and each driver's Review model in Settings are replaced by the
  per-phase dropdown. Your existing choices carry over as the Planning, Work and Review choices,
  and your review model as the Review choice.
- A run on a different driver from the one that saved the ticket's conversation starts fresh
  instead of trying to resume the other driver's session.
- The `Run started` status line names the driver when a phase runs on a different one than the
  ticket's Work driver.
- sim-check's ticket-model check and screenshots now drive the per-phase Models sheet (pick a
  Work model, then Inherit) instead of the old single Model picker.

## [app-20261008.1757](https://github.com/markhuot/harness/releases/tag/app-20261008.1757) - 2026-10-08

### Added

- Agents keep notes on each ticket for the agents that work on it after them: where things live,
  gotchas, what they tried, how to verify and what's half done. They write them with the new
  `update_notes` tool, every later run on the ticket reads them in its prompt, `get_ticket` returns
  them, and `submit_for_review` and `block` remind an agent that hasn't written any. You can read
  them on the ticket's Details tab on the Mac, iPhone and iPad.
- `bun ios/Tools/dev-sim.ts` seeds GREET-6, a ticket in review with agent notes, and the Mac
  `shoot` script has a `details-notes` shot, for checking the notes on the Details tab.

- The Agents & tasks tab on the Mac has a filter at the top: press Agents to see only sub-agents,
  Tasks to see only background tasks, and both or neither to see everything. Each toggle shows how
  many there are, and the filter stays put while you open a row and come back.
- Agents can now inspect another ticket's sub-agents and background tasks: `get_ticket` lists them
  with `include_agents`, and the new `get_ticket_agent` tool reads one in full, with a sub-agent's
  latest transcript or a task's latest output.
- ⌘-click a card on the board to open its ticket in a new split on the far right of the window,
  running its full height, without replacing the ticket you already have open beside the board. A
  ticket that's already open just gets the focus.

### Changed

- Agent runs start a fresh conversation whenever the ticket moves between columns, so a round of
  requested changes or a chat on a ticket in Review no longer re-reads the whole earlier work
  conversation, which cuts what those runs cost. Answering a blocked ticket, or restarting one
  after a failed run, still picks up the conversation where it stopped, and another message in the
  same column still continues the last one. A chat that moves its ticket back to In progress keeps
  working in its own conversation. The prompts tell agents where earlier context lives: the
  spec, their notes, `get_ticket` and the branch's commits.

- Specs are easier to read on the Mac, iPhone and iPad. The text is a size larger (14 px on the Mac,
  16 pt on iOS) with a line height of 1.5, and headings and code grow to match. Each heading after
  the first has twice its own height of space above it, so sections stand apart. Summaries and the
  transcript keep their size and spacing.

### Fixed

- A run that resumes a ticket's conversation (answering a blocked question, a restart, another chat
  in Review or Done, another planning message) now reads that conversation from the prompt cache
  instead of paying to write it all again. The ticket's status, the run's instructions, the spec
  revision, recent Activity and agent notes now arrive at the start of each run's first message
  instead of in the system prompt, so a resumed agent also sees the current ones rather than those
  from when its conversation began. Prompt overrides keep their ids; the new Session section
  (`system.session`) holds the project, ticket and working directory that stay in the system prompt.
- A code block under a numbered or bulleted step in a spec, a summary or any other markdown now
  shows as code inside that step, on the Mac, iPhone and iPad. Before, the code ran into the step's
  text, and a stray closing fence near the end could turn the rest of the document into one code
  block. Text after the code, and paragraphs separated from their step by a blank line, stay in the
  step too.

- On the Mac, a long Agents & tasks list now scrolls. Before, rows past the bottom of the pane were
  cut off with no way to reach them.
- Leftover copies of Chrome no longer pile up in your Mac's temp folder. Each time Harness starts
  Chrome for an agent's browser, it now deletes copies left behind by earlier Chromes that were
  killed or crashed, whether they came from Harness, a test run, or anything else. A copy is kept
  while any Chrome that could still be using it is running.
- When a browser script expects text that never shows up, the agent now sees what the elements said
  instead, like `its text was "3 items left"`. Before, it only saw "0 elements matched", which read
  as if the element were missing.
- Checks on plain values in a browser script, like `expect(titles).toEqual([...])`, now get their
  own ✓ or ✗ line in the script's log, like the page checks do. A failing one is named as the step
  where the script stopped.

## [app-20261008.0736](https://github.com/markhuot/harness/releases/tag/app-20261008.0736) - 2026-10-08

### Added

- Agents can write a browser script as a list of steps, each followed by what the page should show
  next, like `await click(".add"); await expect(".cart-count").toContainText("1")`. The check waits
  for the page to catch up. If it never does, the script stops on that line and the agent sees what
  it expected, what the page showed instead, and a screenshot. The checks use the same `expect`
  that Jest and Bun tests use, with page checks named after Playwright's.
- Agents can wait for a page to show an exact number of matching items, a field holding a given
  value, or an element with a given attribute, from any browser tool. For example, an agent can
  click Clear and wait until the list is empty.

### Changed

- Every change to Harness now gets a changelog entry, including changes only agents see and
  internal changes to tests and build scripts.

### Fixed

- On iPhone, reopening a docked ticket no longer leaves its message bar raised above where it
  sits when the ticket first opens.
- On iPhone, swiping an open ticket away no longer nudges the board behind it, and the sheet no
  longer stutters as it goes. Dragging the docked ticket up or away leaves the board still too.

## [app-20261008.0100](https://github.com/markhuot/harness/releases/tag/app-20261008.0100) - 2026-10-08

### Added

- Agents can fill in forms that sit inside an embedded frame, like a Stripe card field or a 3-D
  Secure check. They can also press keys like Tab and Escape, pick from dropdowns, and upload files
  from the ticket's folder.
- Agents can read a page as a list of its buttons, fields and links, and act on each one by name,
  which helps on pages whose markup is hard to target.
- On iPad, the ticket panel has a pop-out button that opens the ticket in its own window.

### Changed

- On iPhone, a quick swipe down on an open ticket or New session sends it away. A slower drag that
  lets go near the bottom still docks it, as before.
- A ticket's browser shows the page title only on its tab. The gray copy of it above the page is
  gone.
- On iPad, a ticket or New session now opens in a panel that slides in from the right, and the
  board stays usable beside it. Drag the panel's left edge to resize it, and the app remembers
  the width. Dock the panel, or flick its title bar to the right, and it waits at the edge of the
  screen as a small tab, with your place and drafts kept, until you tap it. Narrow iPad windows
  keep the bottom sheet the iPhone uses. A ticket you open from the board or the Inbox takes the
  panel's place, and a ticket linked from inside the panel opens on top of it with a Back button.
- On iPad, New session in the panel shows a single title and a single ✕. Closing it with the ✕ or
  Escape after you've typed something asks whether to save it as a draft or discard it.
- On iPhone and iPad, a ticket opened from a notification or from a link in another app replaces
  the ticket that's open, rather than stacking on top of it behind Back.

### Fixed

- Creating a ticket that starts right away, or pressing Start, no longer sends you a "Moved to In
  progress" notification on iPhone, iPad or Mac. Ticket moves you make yourself stay quiet, and
  Activity shows them as yours. A ticket that an agent starts, or that starts once its
  dependencies are done, still notifies.
- On iPhone and iPad, typing quickly in a ticket's message box no longer freezes the app (or gets
  it closed by iOS). The freeze came when your draft was saved again while an earlier save was
  still on its way.
- On iPhone and iPad, coming back to the app shows what happened while it was in the background.
  An open ticket's transcript now catches up on the agent's replies instead of stopping where it
  was when you left.
- On iPhone, closing a docked ticket or New session with its ✕ slides it away. It no longer grows
  to full size for a moment first.

## [app-20261007.1923](https://github.com/markhuot/harness/releases/tag/app-20261007.1923) - 2026-10-07

### Changed

- On iPhone, a docked ticket or New session has a close button (✕) in place of the up arrow, so you
  can send it away without opening it. Tapping anywhere else on it still opens it.

### Fixed

- On iPhone, the board's bottom bar keeps the same small gap above a docked ticket on every model.
  On the larger phones it had nearly touched it.

## [app-20261007.1751](https://github.com/markhuot/harness/releases/tag/app-20261007.1751) - 2026-10-07

### Changed

- On iPhone, tickets and New session open in the standard iOS sheet again. It drags smoothly,
  swipes away easily, and no longer sets off Reachability. Docked at the bottom of the screen, it's
  a small sheet inset from the edges, with corners that follow the phone's, showing the ticket's
  key (or "New session"). The board's bottom bar widens to line up with it. Tap it or drag it up
  to bring the ticket back. Opening Projects now closes the ticket sheet, and so does an alert from
  the screen behind a docked sheet. Drafts are saved either way.
  The message bar at the bottom of a ticket sits as far from the bottom edge as from the sides, as
  it does outside the sheet.

### Fixed

- The Mac desktop widget no longer draws pale slabs behind its cards, status chips, project pills and
  notes when the desktop isn't focused. In that see-through glass look the cards keep a thin outline
  and the rest sits straight on the glass. The iPhone and iPad widgets are unchanged.
- An agent that passes a tool option as text holding a JSON object (a browser page's wait
  settings, for example) no longer has the call rejected, so it keeps the option instead of
  retrying without it.

## [app-20261007.1337](https://github.com/markhuot/harness/releases/tag/app-20261007.1337) - 2026-10-07

### Added

- Harness now sends system notifications when an agent, a conductor or the service adds activity
  to a card (notes, spec revisions, moves, submissions, blocks and review decisions). They reach
  your Mac and your iPhone or iPad even when the app isn't running or the phone is locked, and
  each device shows them under its own notification settings. You won't get one for something
  you did yourself, or for a card you already have open on any of your devices. A conductor's
  child cards stay quiet unless they get blocked. Settings → Notifications turns them off, either
  all at once or one kind at a time. It also lists the devices that get them and sends a test
  notification. Clicking or tapping a notification opens its ticket.
- A card on the board shows a pencil when you've started writing a message to its agent and
  haven't sent it yet, on the Mac and on iPhone and iPad.

### Changed

- On the Mac, a new terminal (⌘T, or New terminal in the sidebar's + menu) opens in the focused
  ticket's folder: its worktree, or the project checkout it works in. With no ticket focused it
  opens in the board's project folder, as before.
- The Mac app now shares the iPhone and iPad app's bundle ID (com.markhuot.harness), so macOS
  treats it as a new app the first time it opens. Your boards and settings carry over, but macOS
  asks again for notification permission and for its login item and background item approval.
- Activity now records it when you approve a card with no action taken, and when a card that
  skips its human review lands on its own.
- On iPhone and iPad, logging in to a driver that needs a code (GitHub Copilot) shows the code in
  an alert before the login page opens, so you have it when the page asks for it.
- The icons at the top right of a board card keep a fixed order: the working spinner (or clock),
  then the pencil, then the agent and human review marks. The review marks stay put at the right
  edge when an agent starts or stops working.

### Fixed

- On iPhone and iPad, New session's prompt fills its whole box, so tapping anywhere in it brings up
  the keyboard, and a tap or drag below the text places the cursor as in any text field. Taps in the
  lower part of the box, below the text, used to do nothing.
- On iPhone, the keyboard's rounded top corners in New session and the ticket sheet show the
  sheet's own background. A darker strip of the board behind the sheet used to show through there.
- On iPhone, New session scrolls along as you type a long prompt, so the line you're typing stays
  above the keyboard. Before, the prompt kept growing behind the keyboard and new lines were hidden.

### Removed

- On iPhone and iPad, toasts no longer slide in at the top of the screen, so they can't cover the
  back and close buttons anymore. Your change shows on the screen itself, and when something
  fails, iPhone gives an error buzz.

## [app-20261007.1123](https://github.com/markhuot/harness/releases/tag/app-20261007.1123) - 2026-10-07

### Added

- A ticket's Agents & tasks tab shows the model each sub-agent ran on (for example "Haiku 4.5"),
  both in the list and at the top of the sub-agent's transcript, on the Mac and on iPhone and iPad.

- Agents can take a screenshot of a whole page, top to bottom, not just the part that fits in the
  browser window, or of a single element on the page, so screenshots in a ticket's spec can show
  exactly what the change is about.

### Changed

- On iPhone and iPad, touching and holding a card on the board shows a preview of the ticket, open
  on its Spec tab, above the card's menu. Tap the card to open the ticket.
- On iPhone and iPad, a card's menu no longer has Move to … or Move to top/bottom, and VoiceOver no
  longer offers move actions on cards. Agents move tickets between columns as they work.
- On iPhone and iPad, the text you type in a ticket's message box and in the New session prompt is
  a size larger, and the message box's text uses the system's standard color (black in light mode,
  white in dark mode).
- On iPhone, tickets and New session open in a sheet that slides up over the board. Tapping a
  conductor's child ticket, a dependency or the parent opens it inside the same sheet, and Back
  returns. Drag the sheet to the bottom of the screen to tuck it away under the board, like a
  minimized draft in Mail: a bar with the ticket's key (or "New session") stays there, even when
  you switch to Inbox or Settings, and tapping it brings the sheet back where you left it. Swipe
  the bar down to close it. Drafts are kept either way.
- On iPhone and iPad, the ticket's Browser tab now shows the same header as the other tabs: the
  title on one line with a chevron that expands it to the status, badges and actions.
- Board cards no longer show a PR tag on finished tickets, on the Mac or on iPhone and iPad. The
  pull request link is still on the ticket itself.
- On the Mac, the New session pane's Task | Conductor switch is a single Tab stop: use the arrow
  keys to pick Task or Conductor. Shift+Tab from the prompt now goes to the project picker first,
  then to Task | Conductor; both stay where they were on screen.
- On iPhone and iPad, New session's "Orchestrates child tickets." note shows right under the
  Task | Conductor switch instead of below the prompt, and the project name sits next to its key
  badge instead of far off to the right.
- On iPhone and iPad, New session's prompt grows with every line you type instead of stopping at
  12 lines and scrolling inside itself. The sheet scrolls along with it, so the line you're typing
  stays above the keyboard.

### Fixed

- On iPhone and iPad, New session's project menu keeps scrolling while the board updates in the
  background, so every project in a long list can be reached.

- On the Mac, changing the project of a New session or draft from the keyboard keeps the focus on
  the project picker, instead of reloading the pane and moving the focus to its title.

- Agents no longer get a validation error the first time they create a ticket with dependencies,
  start it right away, or pass a similar yes/no, number or list option to a board tool.

## [app-20261006.1929](https://github.com/markhuot/harness/releases/tag/app-20261006.1929) - 2026-10-06

### Changed

- On the Mac, closing, moving or popping out a pane gives its space to the board instead of
  spreading it over its neighbours, so every other pane keeps the size you gave it. Closing the
  middle of [board 50%, ticket 25%, ticket 25%] leaves [board 75%, ticket 25%]. When the board
  isn't beside the pane, the neighbour on the board's side takes the space.
- Ticket cards and the ticket header show a model badge only when the ticket uses a model other
  than its default one (the project's, else the app's, else the driver's own), just as the driver
  badge shows only for a driver other than the default. A ticket on the default driver and model
  shows neither.
- On iPhone and iPad, every ticket tab now shares the header the Changes tab had: the ticket's
  title on one line with a chevron that shows its status, badges and actions. It opens in full
  on the Spec and collapses as you scroll the Spec or move to another tab; once collapsed, it
  stays that way (scrolling back, switching tabs or ticket news no longer brings it back) until
  you tap the chevron.
- After a review or a re-open, agents rewrite the ticket's spec to describe where the work stands,
  instead of adding a section per review round with commit hashes. The spec's revision history
  still shows what changed between rounds.
- Approving a ticket that already has a pull request open now preselects "Approve and clean up"
  instead of "Approve and open PR". Clean up pushes the branch, which updates the pull request,
  then removes the worktree.
- "Approve and clean up" now makes sure the branch is pushed before it removes anything: it pushes
  when the branch has commits the base branch doesn't, or when the remote already has the branch.
  Before, it stopped with the ticket blocked whenever the branch had unpushed commits.
- Re-opening a done ticket forgets how it was landed last time, so its next approval starts from
  the usual default rather than the last choice.

### Fixed

- A ticket completed with "Approve and open PR" no longer shows hundreds of deleted files in its
  Changes tab. The tab had sometimes been saved while the worktree was being removed. It now shows
  the commit the agent pushed to the pull request, and moves to the new push when you re-open the
  ticket and open the PR again.

## [app-20261006.1130](https://github.com/markhuot/harness/releases/tag/app-20261006.1130) - 2026-10-06

### Changed

- The built-in instructions agents get on every run are about 30% shorter, so each turn re-reads
  less text and runs a little faster and cheaper. The defaults shown under Settings → Prompts
  reflect the new wording.

## [app-20261006.0931](https://github.com/markhuot/harness/releases/tag/app-20261006.0931) - 2026-10-06

### Changed

- Agent reviews start with a shorter prompt: instead of a copy of the spec's changes since you
  approved it, the reviewer is told which revision you approved and reads it with `read_spec`. The
  Agent review prompt template no longer has a `baselineDiff` variable; `baselineChanged` says
  whether the spec changed since the approved revision.

### Fixed

- On iPhone and iPad, tapping to move the cursor in New session's prompt or a ticket's message
  field no longer erases what you've typed.

## [app-20261006.0855](https://github.com/markhuot/harness/releases/tag/app-20261006.0855) - 2026-10-06

### Changed

- Chats on finished tickets and reopened tickets start a fresh conversation with the agent,
  instead of picking up the whole conversation from the work. A second chat on a finished ticket
  carries on from the first. Starting work on a planned ticket and completing a ticket also start
  the agent fresh, so they're quicker and use fewer tokens.
- Agents start each run with a shorter prompt and a smaller tool list: they explore the code
  through their sub-agents, make independent calls in parallel, and look up the full details of
  less common Harness tools only when they need them, so runs use fewer tokens.

## [app-20261005.2151](https://github.com/markhuot/harness/releases/tag/app-20261005.2151) - 2026-10-05

### Changed

- A ticket whose completion stops on a usage or spend limit now moves to Blocked with the limit
  as its reason, instead of sitting in Review. When the limit says when it resets, the ticket
  restarts on its own a few minutes after, goes back through review, and is completed again once
  approved.

## [app-20261005.2133](https://github.com/markhuot/harness/releases/tag/app-20261005.2133) - 2026-10-05

### Added

- The Mac app's Settings has an Extensions section for the browser your tickets use. Paste a
  Chrome Web Store link or extension ID to install one, or add an extension you're building from
  its folder. Each one you add has a switch to turn it off and a button to remove it. Extensions
  your organization installs are listed too. Chrome's own install handles Web Store extensions,
  so your organization's Chrome policy applies: an extension it doesn't allow is refused, and the
  message says why.
- A ticket's browser has a puzzle-piece button that lists your extensions. Choose one to run its
  toolbar button on the page you're looking at. Its popup opens in a new tab, since the browser
  has no toolbar of its own. Extensions with an options page can open it from the same menu.
- On iPhone and iPad, Settings has the same Extensions screen, and a ticket's browser has the same
  puzzle-piece button. To add an extension you're building, type the path of its folder on your
  Mac.

### Fixed

- Tickets on the GitHub Copilot driver in auto mode can run shell commands that touch files
  outside their checkout again (`/tmp`, `/Applications`, another worktree). Copilot used to deny
  those with nobody to ask, so the agent blocked saying every command was refused.

## [app-20261005.2050](https://github.com/markhuot/harness/releases/tag/app-20261005.2050) - 2026-10-05

### Added

- On iPad and iPhone with a keyboard attached, the Mac's shortcuts work too: ⌘N for a new
  session, ⌘1 for All projects, ⌘2 for the Inbox, ⌘, for Settings and ⌃⌘S to show or hide the
  sidebar, from any window. On a ticket, ⇧⌘] and ⇧⌘[ move between its tabs. ⌘↩ sends a message,
  saves an edited spec, denies an approval with your note, sends Request changes or Re-open notes,
  approves with instructions and adds annotations. In New session, ⌘↩ starts the session and ⇧⌘↩
  plans it first. ⌘S saves a prompt, and Esc cancels these screens.
- Harness has an Active tickets widget for the iPhone and iPad home screen and the Mac desktop and
  Notification Center. The small size shows the ticket your agents touched most recently, the
  medium size adds its blocked question or latest Activity line, and the large size shows the
  three most recent tickets as board cards. Turn on Compact in Edit Widget to list tickets one per
  line instead (status, project, key and title). Tap a ticket to open it in the app. The widget
  checks the service every 15 minutes on its own and refreshes right away while the app is open,
  and when it can't reach your Mac it keeps showing the last tickets it saw along with how old
  they are.
- A message you're writing to a ticket's agent is saved as you type, so you can start a reply on
  your iPhone and finish it on your Mac, or the other way around. It keeps its attached files and
  their notes too. Another device's version shows up in the message box whenever you aren't typing
  in it, and sending the message clears it everywhere.

### Fixed

- On iPad, New session closes once the ticket is created. It used to stay open behind the new
  ticket's window.
- On iPhone and iPad, typing in New session's prompt and in a ticket's message box no longer gets
  rewritten mid-word when a save finishes or the board updates. Autocorrections and the keyboard's
  suggestions stay put while you type.

## [app-20261005.1909](https://github.com/markhuot/harness/releases/tag/app-20261005.1909) - 2026-10-05

### Added

- A ticket that stops because you hit a usage limit no longer waits for you to restart it. It
  moves to Blocked as before, and when the limit says when it resets, the ticket starts again on
  its own five minutes after that. Its card shows a clock, like a planning ticket waiting on its
  dependencies, and the ticket shows a "Restarts at 2:35 PM" button, on the Mac and on iPhone and
  iPad. Moving the ticket anywhere else cancels the restart.
- Agents wait for a page to finish reacting instead of pausing for a guessed number of seconds.
  A click can wait for the page to go quiet or for a button to disappear, and a screenshot can wait
  for the finished page, so you see fewer stalls and fewer screenshots of spinners.
- Agents can run a short script that drives a browser tab through several steps, such as removing
  every item from a cart, even when the page reloads between steps. Its progress shows up in the
  ticket's transcript as it runs, including the page's console messages and failed requests.

### Changed

- On iPhone and iPad, a ticket's Browser tab no longer shows the ticket's title above it, so the
  page gets that room, the way the title hides while you scroll the Transcript. A request waiting
  for your approval still shows there.
- On iPhone and iPad, the browser's tabs are now at the top of the Browser tab, above the address
  bar.

### Fixed

- An agent reading a value from a page that was reloading now gets the value, or a clear note that
  the page moved on, instead of the word "Object".

## [app-20261005.1743](https://github.com/markhuot/harness/releases/tag/app-20261005.1743) - 2026-10-05

### Added

- Each browser tab has its own size controls, on the Mac and on iPhone and iPad, behind the new
  Size button next to Annotate (the row stays open or closed the way you left it). Desktop and
  Mobile pick how the page is used: Desktop is a mouse at 1280×800, and Mobile is a touch screen
  that identifies itself as an iPhone at 393×852. Pressing either one, even the one already
  selected, resets the tab to that size and reloads the page. The width and height fields show the
  tab's size, and you can type a new one, such as Mobile at 1024×1366 for a tablet. Responsive,
  which new tabs start with, makes the tab follow the size of your pane or window; if you turn it
  on from another device, the tab follows that device instead.
- Pinch to zoom in the browser: two fingers on iPhone and iPad, or a trackpad pinch on the Mac,
  zoom into the page you're looking at without the page seeing the pinch, so a desktop-sized page
  stays readable on a phone.
- Agents can open a page in Mobile or at any size, resize a tab, and check a tab's failed network
  requests and console errors.

### Changed

- When an agent sets a size for a tab, opening the browser on another device no longer resizes it
  under the agent. On a phone, a page larger than the screen is scaled down to fit.
- The browser bar has more room for the address: Annotate is an icon, the new-tab + button sits at
  the end of the tab strip (which scrolls when there are many tabs), and the Live indicator is gone.
- The Browser tab's strip of tabs now shows even when only one browser tab is open, so you can drag
  that tab off into a pane or window of its own.
- Agents keep a ticket's spec readable top to bottom as what's being built now. When you change
  your mind while planning or after, the agent rewrites the Goal and every other part your change
  touches, instead of adding a "Later refinement" below a Goal that no longer holds. Earlier
  versions stay in the spec's history. If you customized the agent instructions in Settings, you
  keep your own text.

## [app-20261005.1342](https://github.com/markhuot/harness/releases/tag/app-20261005.1342) - 2026-10-05

### Added

- Projects can share a group, such as Work or Personal, on the Mac, iPhone and iPad. Pick a group
  in a project's settings: the Group field offers the groups you already have, or press Return to
  start a new one with the name you typed. Each group gets its own board with only its projects'
  tickets, listed under All projects in the sidebar (the Projects sheet on iPhone) in alphabetical
  order with its open count, and the Mac's command palette Board: entries include the groups.

### Changed

- On iPhone and iPad, the browser tab's button for typing into the page now shows a keyboard
  instead of a pencil, so it no longer looks like Annotate. While the keyboard is up, it shows the
  hide-keyboard symbol.
- On iPhone and iPad, a ticket's title and buttons come back when you scroll to the very end of a
  tab, the way Safari's toolbars do at the end of a page.

### Fixed

- When you message a done ticket and ask for more work (another check, a fix), the agent now
  re-opens it: the ticket moves to In progress while it works and then to Review with its results,
  as if you'd pressed Re-open. Before, the ticket stayed in Done, and the agent couldn't post its
  results to the board. Questions about the finished work still leave the ticket in Done.

- On iPhone and iPad, New session's Start session and Plan first buttons keep their icons when you
  tap them. Before, the tapped button briefly turned into its text label. Now both are just
  disabled while the session launches.

- On iPhone and iPad, a ticket's title and buttons slide away and come back smoothly while you
  scroll its Spec, Transcript or other tabs. Long transcripts no longer stutter as they move.

## [app-20261005.1016](https://github.com/markhuot/harness/releases/tag/app-20261005.1016) - 2026-10-05

### Changed

- On iPhone, the board's bottom bar and a ticket's message composer sit lower, with the same gap at
  the bottom as at the sides, so their rounded ends follow the phone's corners the way Calendar's
  bar does. While you type, they still rest just above the keyboard.
- An agent review no longer starts with the whole spec pasted into its first message. It names the
  revision that was submitted, and the reviewer reads that revision itself, so long specs don't fill
  the review transcript or land in the reviewer's context twice. In Settings → Prompts, the Agent
  review prompt has a new `{{specEmpty}}` variable and no longer has `{{spec}}`; a customized
  prompt that uses `{{spec}}` is flagged for you to update.

### Fixed

- On iPhone and iPad, scrolling a ticket's tabs no longer stutters while the ticket's title and
  buttons slide away or come back. Long specs suffered most.

## [app-20261005.0236](https://github.com/markhuot/harness/releases/tag/app-20261005.0236) - 2026-10-05

### Changed

- The Spec tab's revision slider is gone. In its place, a timeline runs along the bottom edge of the
  history bar, with one segment for each revision. The revision on show is highlighted and the
  approved plan is marked in green. Press and drag along it to sweep through the revisions while the
  spec updates, or tap a segment to jump to it. On the Mac you can also scroll over the bar, or use
  the arrow keys, Home and End.
- The Spec tab's history bar is simpler. It shows when the revision on show was written and its
  note, and no longer has the ‹ › buttons, the Latest button, the "Rev 3 of 7" count or who wrote
  it. The count appears where you're scrubbing instead: in the timeline's tooltip on the Mac and in a
  bubble above your finger on iPhone and iPad. On iPhone and iPad, Show changes sits in the bar's
  one row.
- On the Mac, a ticket's message box is a single row: **+**, the text field and Send. Send shows
  its ⌘↩ shortcut inside the button, like **Start session** in New session.
- On the Mac, the Spec and Activity tabs keep to a centered column in a wide pane, like the
  Transcript but a little wider, so lines stay a comfortable length when the ticket is maximized.

### Fixed

- Typing in New session no longer gets letters put back after the cursor. On iPhone, the end of
  a predicted word could show up after the cursor while you typed, because a saved copy of the
  draft came back from the Mac and replaced what was in the box. New session now keeps exactly
  what you type, on the Mac and on iPhone and iPad.

### Removed

- The **Move to in progress** and **Re-open and move to in progress** switches over a ticket's
  message box, on the Mac and on iPhone and iPad. A message to a ticket in review goes to its
  agent, which moves the ticket back to in progress when it changes the work and leaves it in
  review when it only answers. To move a ticket yourself, use **Request changes** (review) or
  **Re-open** (done).
- The hints by a ticket's message box, such as "Sent to the running agent" and "Stays in review
  unless the agent submits it again", on the Mac and on iPhone and iPad.

## [app-20261005.0103](https://github.com/markhuot/harness/releases/tag/app-20261005.0103) - 2026-10-05

### Added

- Tear off a ticket's tabs. On the Mac, drag any tab of a ticket (Spec, Transcript, Details,
  Browser and the rest) onto the board area to give it a pane of its own, so you can read the Spec
  while you follow the Transcript. You can tear off one browser tab the same way, so two browser
  tabs can run side by side, or drag off the message box. Right-click a tab for Open to the
  Right/Below/Left/Above or Open in New Window. On iPad, drag a tab, a browser tab or the message
  box out of its window, or choose Open in New Window from its menu, to give it a window of its own.
- A torn-off tab stays in its ticket's tab bar. Selecting it there shows **Return to this window**,
  which closes the separate pane or window and brings the tab back.
- On the Mac, you can drag anything that opens as a pane out of the window to give it a window of
  its own: a board card, a conductor's child ticket, a pane by its header, a tab or a browser tab.
  File panes now have the pop-out button too. On iPad, drag a board card out of the window to open
  its ticket in a new window. Dragging a card doesn't move it to another column; Move to … in its
  menu still does that.
- You can annotate images as part of a message. Open any image in a spec, a New session attachment
  on the Spec tab or a file sent with a message, and choose Annotate. In the Browser tab, Annotate
  takes a picture of the page. Click to drop a numbered marker, or press and drag to draw an arrow
  pointing at the spot. Each number gets its own note, listed next to the image (below it on
  iPhone) so nothing covers what you're pointing at. Add to message puts the image in the message
  box, where you can write why before you send it. Images attached to a New session or waiting in
  the message box can be annotated too, and you can reopen an annotation to change it until you
  send. The image itself is never changed: your arrows and numbers are drawn over it wherever it
  shows, with its notes underneath, and the agent gets the image along with the numbered notes and
  where each one points. On a browser page, each marker also names the element it points at (shown
  under its note, like `#save · "Save"`), so the agent can find it in the page and the code.

### Changed

- Start work on a planned ticket whose dependencies aren't done yet now queues it. The ticket stays
  in Planning with the clock on its card and starts on its own once they finish, instead of
  starting right away.

### Fixed

- On iPhone and iPad, the "Move to in progress" switch over the message box stays at the left when
  you turn it on, instead of jumping to the middle.
- A completion that fails partway (a spend limit, a crash) leaves the ticket in Review with its
  agent review still approved, instead of moving it to Blocked. Approve it again to finish landing
  it. A conductor's child stays approved, and its conductor completes it again.
- A ticket whose worktree went missing keeps working: its agent runs from the project checkout and
  is told the worktree is gone, so it can put it back, instead of every agent review failing with
  "Working directory does not exist".
- A failed agent review now shows in the ticket's Activity, with the reason, instead of leaving the
  ticket in Review with nothing running and no word why.

## [app-20261004.2203](https://github.com/markhuot/harness/releases/tag/app-20261004.2203) - 2026-10-04

### Added

- A GitHub Copilot driver. Choose it in Settings → Drivers (or per project or ticket) to run agents
  with your Copilot subscription and any model Copilot offers. Log in from Settings → Drivers, which
  shows a code to enter on GitHub, or paste a GitHub token there (a fine-grained token with the
  Copilot Requests permission), which keeps working when the service starts at login. Messages you
  send while a Copilot agent is working are queued for its next turn. Mac, iPhone and iPad.
- Messages to a ticket can carry attachments. A (+) button at the left of the message box lets you
  attach files the same way a New session does: on the Mac, choose files or paste an image (you can
  also drop files on the message box or paste an image into it); on iPhone and iPad, attach from
  Photos, Files or the clipboard, or drag files in on iPad. Attachments are listed above the message
  box, each with a remove button, until you send. A message can be just attachments, and the agent
  sees attached images along with your message.
- The Transcript shows the files sent with each message under it, with thumbnails. A file that was
  moved or deleted afterwards shows as missing.
- A ticket you started before its dependencies were done now shows a clock on its board card in
  Planning, so you can tell it will start on its own once they finish. Its Start button reads
  "Starts automatically" and is turned off, and hovering it (or VoiceOver) names the tickets it's
  waiting on. Mac, iPhone and iPad.

### Changed

- On iPhone, the board has no title bar anymore, so its columns get more of the screen. The
  Projects button moved to the bottom bar, the Filter button moved inside the search field, and
  the search field's placeholder names the project you're looking at (or "All projects"). While
  you search, an X next to the field ends the search.

### Fixed

- On iPhone and iPad, a ticket's tabs (Spec, Activity, Transcript and the rest) scroll under the
  message box again, so you can see the content through its glass. The last line still scrolls up
  clear of the message box.
- A Transcript no longer shows an agent's reply, half written and as raw text, under the newest
  message. This happened when the app was in the background or offline while the agent was
  writing. The Transcript now drops it as soon as the app catches up.

## [app-20261004.0031](https://github.com/markhuot/harness/releases/tag/app-20261004.0031) - 2026-10-04

### Added

- New sessions take attachments, and the agent sees attached images along with your prompt. Attachments are
  listed under the prompt the same way the Spec tab shows them, each with a remove button. On the
  Mac, drop files from Finder onto the New session, pick several with the paperclip button, or
  paste an image. Dropped and picked files stay where they are on disk. Pasted images are saved in
  the harness folder. On iPhone and iPad, attach from Photos, Files or the clipboard, or drag files
  in on iPad.
- A ticket's Spec tab lists the files attached to its New session at the bottom, one per line with
  a thumbnail or file icon. A file that was moved, renamed or deleted afterwards shows as missing,
  along with the path it used to be at.

## [app-20261003.2235](https://github.com/markhuot/harness/releases/tag/app-20261003.2235) - 2026-10-03

### Added

- On iPhone and iPad, swipe sideways on a ticket to move between its tabs, from Spec to Activity
  and on through Details. The next tab slides in under your finger as you drag, and the tab strip,
  header and message box stay where they are. A right swipe on Spec still goes back.

### Fixed

- On iPhone and iPad, an attachment image smaller than the screen opens in the middle of the
  viewer. Before, it opened with its top-left corner in the middle and the rest cut off at the
  bottom right.

## [app-20261003.2044](https://github.com/markhuot/harness/releases/tag/app-20261003.2044) - 2026-10-03

### Added

- iPhone and iPad warn you when the app and the harness service on your Mac come from different
  releases. A banner at the top of the board, Inbox and Settings names both releases and says which
  side to update: Harness from TestFlight, or Harness on the Mac. Close it to hide it until either
  side changes.
- Settings → Drivers → Claude Code takes a long-lived token, on the Mac and on iPhone and iPad.
  Run `claude setup-token` in a terminal and paste the token there. Agents then sign in with it
  instead of the Claude login in your Keychain, which the service can't always read when it
  starts at login.

### Fixed

- When an agent can't sign in to Claude, the ticket now says why and how to fix it, and Settings →
  Drivers shows Claude Code as Not signed in. Before, the ticket only said "OAuth session expired
  and could not be refreshed" and the driver still looked ready.

- Words with underscores in them, like `spec_revised` or `snake_case_name`, keep their underscores in
  transcripts, specs and Activity on the Mac, iPhone and iPad. Before, the underscores disappeared
  and the text between two of them turned italic. `_Underscores_` around a whole word still italicize.

## [app-20261003.1524](https://github.com/markhuot/harness/releases/tag/app-20261003.1524) - 2026-10-03

### Added

- Activity now lists each spec revision with its note, on the Mac and on iPhone and iPad. Planning,
  your own spec edits and an agent's Status updates show up in the Activity tab and as the latest
  line on a ticket's board card, where before a ticket could be planned and revised with nothing in
  Activity.

### Changed

- The progress bar for a ticket's child tickets is back in its Tickets tab, on the Mac, iPhone and
  iPad, and no longer sits at the top of the ticket under the title, which kept the top of every
  ticket with children busier than it needed to be.

### Fixed

- On iPhone and iPad, the Transcript tab scrolls up and down again when your finger lands on an
  expanded tool call. The call's Input or Output box used to take the drag and slide its text
  sideways instead. The box still scrolls sideways when you swipe sideways, and scrolls down on its
  own once its text is taller than the box.
- On iPhone and iPad, a tool call's Output box no longer shows up empty when the output is very
  long or has a very long line, like a `get_ticket` result with the whole spec in it. Lines longer
  than 500 characters wrap onto the next line.

## [app-20261003.1227](https://github.com/markhuot/harness/releases/tag/app-20261003.1227) - 2026-10-03

### Fixed

- With Start at login on, the service now comes back after you install an update. If an earlier
  macOS update restart was interrupted, the service could stop to switch to the new version and
  then stay stopped, and Retry couldn't start it again. Retry now starts it in that case too.

## [app-20261003.1100](https://github.com/markhuot/harness/releases/tag/app-20261003.1100) - 2026-10-03

### Added

- Screenshots in a spec have a layout, on the Mac and on iPhone and iPad. An image on a line of its
  own spans the full width with a caption underneath. Agents can also show small 100×100
  thumbnails, side by side in a row, that open full size when you click or tap one.

### Changed

- On the Mac, the Changes tab is now one of a ticket's own tabs. It sits between Browser and
  Details (where the iPhone and iPad already put it) and is drawn by the app itself instead of
  loading a separate page, so it looks and follows your theme like the rest of the ticket.
  It works the same way as before. Files you marked Viewed and your Unified/Split choice start
  fresh once, since the app now keeps them itself.

- Messages you send on a ticket no longer go into its Activity. Once a message is sent, the ticket
  switches to its Transcript, where your message and the agent's reply show up. The composer no
  longer labels where a message goes ("Shows in Activity" or "Transcript only").
- Activity now records every time a ticket changes columns. An entry that moved the ticket (a
  submit, a question, a review that sent it back) ends its heading with the column it went to, for
  example "Submitted for review → Review", and a move with no other entry (dragging a card,
  pressing Start, a completed ticket) shows up as a new Moved entry.
- Each Activity entry shows one line. Agents are asked to keep notes to a single line of 400
  characters or less, and when they write more, Activity shows the first line and Show details
  reveals the rest, on the Mac and on iPhone and iPad. Long review notes, approvals and run errors
  work the same way.
- The agent reviewer can now add to a ticket's spec, so findings like open questions for you land
  under Open questions instead of only in its notes.
- During long work, agents post a progress note at least every 10 minutes (for example, how many
  test suites have finished), so a ticket's card and Activity don't go quiet while it runs.
- Agents' Activity entries are one line each: what changed and why. The reasoning behind a change
  goes in the spec, not the ticket's timeline.
- Agents write the spec as a summary of the change, not a log of the work: what it is, why, and
  which parts are implemented, citing commits instead of walking through the diff. Changes you ask
  for in review or when re-opening a ticket go into its Goal as requirements.
- Show changes in the Spec tab, on the Mac and on iPhone and iPad, keeps the formatted spec and
  highlights what was added and removed, instead of switching to a raw diff. New words are green
  and removed words red and struck through, right inside the headings, lists, tables and code
  blocks you see with it off.
- On iPhone and iPad, the message field at the bottom of a ticket is now Liquid Glass and floats
  over the tab's content instead of sitting in a solid bar. The send button is a glass circle with
  an arrow, filled with your accent color while you're writing.
- On iPhone and iPad, New session's Plan first button is now in the top bar, next to the paper
  plane that starts the session. The Start session and Plan first buttons at the bottom of the
  form are gone (Start session there was cut off at the top). The button you tap shows a spinner
  while the session launches.

## [app-20261003.0051](https://github.com/markhuot/harness/releases/tag/app-20261003.0051) - 2026-10-03

### Fixed

- The downloaded Mac app opens again when Start at login is on. Before, the background service
  could hang at a hidden "downloaded from the Internet" prompt after you installed a new version,
  and Harness sat waiting for it with no window. Start at login now uses a macOS login item that
  belongs to Harness itself, and turning it on may ask you to allow Harness in System Settings
  (General, then Login Items), which Harness opens for you. If Start at login was already on, Harness
  switches it over the first time it opens.
- A ticket no longer gets stuck after its agent submits it for review or blocks while a
  background task, such as a log monitor, is still running. Before, the ticket sat in Review
  looking busy, its agent review never started, and messages you sent it were queued with no
  run to reach. Now Harness stops the leftover agent process and its background tasks about 15
  seconds after the run ends, and the ticket's timeline says what was stopped.

## [app-20261002.2236](https://github.com/markhuot/harness/releases/tag/app-20261002.2236) - 2026-10-02

### Added

- A ticket's browser can have several tabs. Agents can open pages in new tabs and work in each
  one separately, so sub-agents can each browse in a tab of their own at the same time. A link
  that opens a new window (or a page that opens a popup) shows up as a new tab too.
- The Browser tab on the Mac, iPhone and iPad has a new-tab button, and once more than one tab is
  open, a row of tabs above the page. Tap or click a tab to watch it, or close it with its ×.
  Each app keeps its own place, so you can watch one tab while the agent works in another.
- Images and videos attached to a ticket can appear inside its text, fitted to the width. Click or
  tap one to open it full size, then step through every image in that text. Images from other
  websites aren't loaded. They show as a link instead.
- Every change to a ticket's spec is kept as a revision, with who made it and a short note on
  what changed. The revision that's current when you press Start is marked as the one you
  approved.
- Agents can show screenshots and recordings right in the spec. The images are kept with the
  ticket until you delete it.
- On the Mac, iPhone and iPad, the Spec tab has a history bar above the spec, reading "Rev 7 of 7 ·
  Agent · 3m ago" with the note for that revision. Step back and forward with the arrows or drag
  the slider to see any earlier revision. The revision you approved by pressing Start is tagged
  **Approved plan**. The bar follows new revisions as they arrive, unless you've stepped back to an
  older one (on iPhone and iPad, **Latest** takes you back to the newest).
- **Show changes** on the Spec tab shows what the revision on screen changed from the one before
  it, in the same diff view as code changes.
- A new Activity tab on the Mac, iPhone and iPad lists the ticket's notes, submits, review rounds
  (with the round and the commit that was reviewed), approvals and failures. A question from the
  agent stands out as a card, and your messages and the agent's answers read as a conversation.
- Settings has a new **Suspend unused browser tabs after** option on the Mac, iPhone and iPad. It
  sets how many minutes a ticket's browser tab can go unused before its page is suspended to free
  memory (5 by default, or 0 to keep pages running). A tab you're watching in an app's Browser tab
  isn't suspended.

### Changed

- A ticket's description is now its **spec**: one living document with the goal, the plan, the
  current status (what's done, how it was checked, screenshots) and open questions. Agents keep it
  up to date as they work, changing only the parts that changed, instead of posting a new summary
  each round. They have to bring it up to date before they submit for review.
- **Summaries are now Activity**: a short timeline of typed entries, such as notes, submits,
  questions, review decisions, approvals, re-opens and failures. Agent notes are kept to a few
  lines about what changed since the last one, so a second review round no longer repeats the
  first.
- Agent reviews know which round they are. A re-review sees the earlier rounds' notes and the
  commit they looked at, checks what changed since then, and keeps its notes to that round. The
  reviewer also sees how the spec changed since you approved it, and asks for changes if the goal
  moved without you asking.
- A message to a ticket's agent goes into Activity, with the agent's answer, only when you send
  it from the Spec or Activity tab. From any other tab it goes to the agent and the transcript
  only. The Mac says which under the message box ("Shows in Activity" or "Transcript only"), and
  iPhone and iPad say it at the start of the message box's placeholder ("In Activity" or
  "Transcript only").
- On the Mac, iPhone and iPad, the Summaries tab is replaced by **Spec** and **Activity**, and
  tickets open on the Spec. Links and saved panes that pointed at Summaries open the Spec. "Brief"
  and "Plan" labels, including the text box in the new session editor, now say Spec.
- Editing the spec in a ticket's Details tab no longer overwrites an agent's newer revision, on the
  Mac, iPhone or iPad. If the spec changed while you were editing, you're asked whether to
  **Reload** it (your text is dropped) or **Overwrite** it with yours.
- Saved changes to the Summaries prompt in Settings → Prompts are dropped, since the new Spec and
  Activity prompt replaces it. If another saved prompt still mentions `update_plan` or
  `post_summary`, the service log says so at startup.
- When a new ticket's text asks for ticket settings, such as dependencies, a branch or skipping
  a review (`/depends: HARNESS-12`, `/branch: main`, `/skip-human-review`, or in plain words), the
  planning agent now applies them to the ticket itself. They're already set when you read the spec
  and press Start.
- Agents can now turn off both of a ticket's reviews when you ask them to. The ticket then lands as
  soon as it's submitted. Before, an agent could turn off only one of them.
- A ticket with child tickets shows its progress bar at the top of the ticket, under the title,
  on the Mac, iPhone and iPad, so you see it without opening the Tickets tab. (On iPhone and iPad
  it's tucked away with the badges on the Browser, Changes and plugin tabs, where the top of the
  ticket shrinks to its title.) It lists how many children are
  done, in progress, blocked or in review, and how many are waiting on you. Click or tap it to
  open the Tickets tab and see each child.
- Project settings now have **Skip agent review** and **Skip human review** switches (on Mac and
  iPhone/iPad), in place of **Require human review**. They set where a new ticket's two review
  switches start, so one project can skip your review by default while another skips the agent's,
  or both. Each ticket can still change its own, and changing a project's switches only affects
  tickets created afterwards.
- A ticket in a project that used to have **Require human review** off keeps skipping your review,
  and you can now turn your review back on for one of those tickets from its Details tab.

### Fixed

- On iPhone, the board's New session button sits in its own glass again, beside the search field
  instead of inside it.
- When a watcher's update is meant for a ticket that's already done (new review comments on a pull
  request whose ticket finished, say), triage now re-opens that ticket with the update. The ticket
  gets its worktree back and goes through review again. Before, the update went to the done
  ticket as a chat, which failed with "Working directory does not exist" once the ticket's
  worktree had been cleaned up, while the Inbox still showed it as sent.
- Messaging a done ticket whose worktree was cleaned up now answers from the project folder
  instead of failing with "Working directory does not exist".
- Agents that look up an Inbox key (`TRIAGE-12`) with `get_ticket` are now told it's an Inbox
  item and pointed to `list_inbox`, which can now find a single item by its key.
- Typing in a ticket's browser no longer freezes it or runs Chrome at 100% CPU. Pressing Shift (for
  a capital letter or a symbol like `+`), ⌘, ⌥, Escape or a function key used to set off a loop that
  kept Chrome busy until it was quit.
- Nested lists in ticket text now show their nesting. Indented items sit under the item above them
  on the Mac, iPhone and iPad, with bullets that change by level (• ◦ ▪), and a numbered list keeps
  the number it starts at.
- Harness's background Chrome no longer keeps every page a ticket ever opened running. A tab nobody
  has used for a few minutes (see the new setting above), and every tab of a ticket that moves to
  Done, is suspended: its page closes, so a dev server or web app it was showing stops using the
  Mac's CPU and memory, but the tab stays in the Browser tab's strip (dimmed). Open it and the page
  reloads where you left off, including after a link you clicked or a restart of Harness. Once no
  tab has a page, Chrome itself quits until it's needed again. Agents are also asked to close the
  tabs they're done with.

### Removed

- Cards linked to a remote ID no longer carry a badge naming where the link came from ("manual",
  "jira" or a watcher's name). The remote ID still shows in place of the ticket's key. The ticket's
  details and settings no longer mention the source either.
- Agents no longer attach screenshots to individual summaries. They put them in the spec instead,
  and screenshots from older summaries show in those entries in Activity.
- The row of attachment thumbnails under each summary is gone on the Mac, iPhone and iPad. Images
  show inline in the spec and in Activity, and still open full screen when you click or tap them.

## [app-20261002.1646](https://github.com/markhuot/harness/releases/tag/app-20261002.1646) - 2026-10-02

### Changed

- On iPad, each ticket you tap opens in a window of its own again, instead of replacing the ticket
  in the window you opened last. Tapping a ticket that already has a window brings that window
  forward.
- When you message a ticket in Review and the agent starts changing the work (rather than just
  answering), it now moves the ticket back to In progress first. The board shows it being worked
  on, an agent review that was waiting is stopped, and both reviews start over once the agent
  submits again. A message the agent only answers still leaves the ticket in Review.

### Fixed

- On iPad, closing a ticket window (with its close button or the window controls) no longer stops
  tickets from opening. Tapping a ticket after closing its window opens a new one.

## [app-20261002.1543](https://github.com/markhuot/harness/releases/tag/app-20261002.1543) - 2026-10-02

### Changed

- Installing a different build of the Mac app (one that runs the service from another place) no
  longer restarts a login-item service while agents are working. The previous service keeps
  running, a banner says how many agents it's waiting on, and the app switches over once they
  finish. "Restart now" still switches right away if you'd rather not wait.

### Fixed

- The service no longer stops for good after the Mac app reinstalls it as a login item. macOS
  hadn't finished shutting down the old service when the app tried to start the new one, so
  nothing came back and the window showed a blank screen.
- A window that loses the service before it loads anything now says it can't reach the service
  and offers Retry, which starts the service again. When the connection drops after the window
  has loaded, a banner at the bottom says so and offers the same Retry.

## [app-20261002.1508](https://github.com/markhuot/harness/releases/tag/app-20261002.1508) - 2026-10-02

### Added

- Agents can now set a ticket's Remote ID and its link when they create or edit a ticket, not
  only when triage dispatches one. A ticket an agent files for a Jira issue shows that issue's
  key on the board, the same way it would if you'd typed it into the ticket's settings.
- Summaries and messages can name a linked ticket as `[FOO-123](WEB-12)`. The Mac, iPhone and
  iPad show FOO-123 as a link that opens WEB-12. Agents are now told to write linked tickets
  this way.
- On iPad, tapping a ticket opens it in a window of its own, centered over the board, so the board
  stays where you left it. Use the window's controls (the three dots at its top) to move or resize
  it, put it in Slide Over, or tile it next to the board. Tapping another ticket shows it in that
  same window, and a ticket that already has a window of its own brings that one forward. To keep a
  ticket in its own window, choose Open in New Window from its card's menu (touch and hold) or the
  ticket's More menu. You can keep several of those open at once. Links inside a ticket window open
  in that window, and your ticket windows come back when you reopen the app. On iPhone, and in a
  narrow Split View, tickets open as they did before.

### Changed

- When a ticket has nothing to land, its Approve button no longer offers **Approve and merge** or
  **Approve and open PR** (Mac, iPhone and iPad). It reads **Approve and clean up** instead. That
  covers a ticket that worked in the project folder without a worktree of its own (a release, say)
  and one whose worktree has no new commits or uncommitted changes. If you commit to its worktree
  by hand while it's in Review, opening the ticket brings the merge choices back.
- On iPhone and iPad, the board's New session button is now a pencil on a
  square, the same compose icon Mail and Notes use, instead of a plus.
- On iPad, the sidebar stays on screen beside the board, Inbox or Settings, like it does on the
  Mac: Inbox, All projects, each project with its settings gear, and Settings with the connection
  at the bottom. Tap the sidebar button in the top corner to hide it or bring it back, and the app
  remembers your choice. The board's search field, Filter menu and New session button sit in the
  top bar instead of along the bottom. With a keyboard, ⌘F jumps to search and ⌘N starts a new
  session. In a narrow Split View window the iPad uses the iPhone layout.
- On iPad, the board shows all five columns side by side, as on the Mac, instead of one column at a
  time. Each column has its own header with its count and scrolls on its own. When the window is too
  narrow for all five (portrait on an 11-inch iPad, a small Stage Manager window), the board scrolls
  sideways, and tapping a column's header brings it into view. Move a card from its menu (touch and
  hold), as on the Mac. In a narrow Split View the board works as it does on iPhone.
- A conductor's card now shows the working spinner whenever one of its child tickets (or their
  children) has an agent running, not only when the conductor's own agent is running (Mac, iPhone
  and iPad, on the board and in the Tickets tab). The spinner goes away once every child has
  stopped, is blocked or has crashed.

### Removed

- On iPhone and iPad, you can no longer drag a card to another column or chip on the board, the same
  as on the Mac. Touch and hold a card and use its menu to move it to another column, or to the top
  or bottom of its own.

## [app-20261002.1101](https://github.com/markhuot/harness/releases/tag/app-20261002.1101) - 2026-10-02

### Added

- Background tasks an agent leaves running, such as a test suite, a dev server or a Monitor, now
  show up on the ticket's Agents & tasks tab with their state. Click or tap one to watch its
  output live while it runs; the output stays there after it finishes. In the transcript, the
  command that started it has an Open output link.
- Tickets have a **Skip human review** switch next to Skip agent review, in New session's Options
  and on a ticket's Details tab (Mac, iPhone and iPad). With it on, the ticket lands as soon as the
  agent review approves it. With both switches on, it lands as soon as the agent submits it. You
  can still send a ticket back while it's in Review. Agents can turn it on when you ask them to
  (for example "merge it once the review passes"), but they can never skip both reviews.

### Changed

- The ticket's Agents tab is now called Agents & tasks. It lists sub-agents and background tasks
  in one list, with the most recently updated first.
- On the Mac, a ticket's tabs scroll sideways when they don't fit instead of wrapping onto a
  second line.
- On iPhone and iPad, the tab bar is gone. The sidebar button at the top left of the board, the
  Inbox and Settings opens the Projects sidebar, where you switch between the Inbox, your projects
  and Settings (now at the bottom). The sidebar button shows how many Inbox items are being
  triaged, as the Inbox tab's badge used to. Along the bottom of the board are a Filter button with Show
  child tickets, a search field that's always there, and New session, which moved down from the
  top right.
- A conductor's child tickets have only the Approve button now, still turned off while the
  conductor manages them. Once the conductor is done, approving a child the conductor had already
  approved lands it.

### Removed

- On iPhone and iPad, the board's ⋯ menu. Pull down on the board to refresh, and open a
  project's settings from the gear next to it in the sidebar.
- The **Complete when approved** switch is gone from project settings on the Mac, iPhone and
  iPad. Approving a ticket now always lands the work the way the Approve button says (merge,
  open a PR, clean up, or your instructions) once both reviews pass, with no separate
  **Complete** step. To approve without landing anything, pick **Approve and take no action**.
  A project with **Require human review** off now lands each ticket as soon as the agent
  reviewer approves it, so turn that switch on if you want to sign off yourself. Update the
  iPhone and iPad app along with the Mac: older versions can't read projects from the new
  service.
- The **Complete** button, its menu and its sheet are gone from tickets on the Mac, iPhone and
  iPad, along with the ⌘K "Complete…" command. Approve is the only way to land a ticket. If its
  final step is cancelled or cut off by a restart, the ticket goes back to waiting on your
  approval, with your earlier choice preselected, and approving again lands it. Tickets that were
  sitting approved and waiting on Complete when you update go back to waiting on Approve.

## [app-20261002.0906](https://github.com/markhuot/harness/releases/tag/app-20261002.0906) - 2026-10-02

### Changed

- The iPhone and iPad app is now a fully native iOS app (built in SwiftUI), version 2.0. It has
  every feature of the previous app, and it uses the standard iOS controls for lists, sheets, menus
  and the tab bar. Code in transcripts and files is colored with the same themes as on the Mac.
- Menus (the Approve menu, a ticket's actions) open as iOS menus. Tap outside one to close it.
- Leaving New session with unsaved text asks whether to keep the draft in an alert.
- To copy a code block, press and hold it.
- Your paired Macs carry over from the previous version. If the app asks you to pair again, scan
  the QR code under Settings → Network on the Mac, or enter the address and token by hand.
- Settings groups each driver's settings under that driver. On the Mac, click a driver in
  Settings → Drivers to open its sign-in and review model. On iPhone and iPad, tap a driver to
  open its own screen. The Anthropic API key moved from General into the Anthropic API driver.
- The default model now sits right below the driver list, and the separate Models section is gone.
- A conductor's child tickets no longer show "Approve and merge into <branch>". Their Approve and
  Complete buttons read as usual ("Approve and merge") but are turned off, menu included. On the
  Mac, the tooltip says the ticket is conductor managed. On iPhone and iPad, a note under the
  buttons says so. The conductor approves and lands its children itself. Once the conductor is
  done, the buttons work again.

### Removed

- The install page no longer offers the separate Harness Beta download, since the native app is
  now the iPhone and iPad app. If you installed Harness Beta or Harness Dev, delete it once 2.0 is
  on your device.

### Fixed

- An agent that picks up a ticket where an earlier run left a background job running (approving
  a ticket whose agent submitted with a dev server or test run still going, for example) now
  waits for the background jobs it starts. Before, the run ended as soon as the agent's first
  reply came back, stopped those jobs, and could mark the ticket done before its work was merged.

## [app-20261001.1617](https://github.com/markhuot/harness/releases/tag/app-20261001.1617) - 2026-10-01

### Added

- The Mac app now includes the service that runs your agents, so you can download it and open it
  on any Apple silicon Mac. You no longer need Bun or a copy of the Harness source.
- Settings → Service on the Mac has a **Start at login** button. Click **Install** and macOS starts
  the service when you log in, and agents keep running after you quit Harness. **Remove** puts the
  service back inside the app.
- A new **Approve and clean up** choice on the Mac and iPhone/iPad, in the Approve menu and as a
  project's "When approved" default. It removes the ticket's worktree and branch without merging
  or pushing anything. Use it when the work already landed: a ticket that pushed fixes to an open
  pull request's branch, a branch you merged yourself, or a ticket that only changed something
  outside git. If something on the branch would be lost (uncommitted changes, or commits that
  aren't pushed or merged), the ticket moves to Blocked and says what's left, so you can sort out
  those commits first.

### Changed

- Tickets that triage makes for work on an open pull request (fixes, resolving conflicts) now work
  on the pull request's own branch instead of a separate harness branch. Their Approve button reads
  **Approve and clean up**, and the merge and open-PR choices are gone from the menu, since there's
  nothing to merge. The same goes for any ticket whose branch is also its base branch.
- On the Mac, the service now runs inside the app by default, so quitting Harness stops it. If
  agents are running, Harness asks before quitting. If you'd already set up the service to run in
  the background, nothing changes: Settings → Service shows Start at login as on.
- On the Mac, the Changes tab's diffs and the Browser tab's page now run edge to edge, without the
  small margin around them.
- The agent reviewer now looks past the diff at the rest of the codebase, and requests changes
  when the work duplicates logic that already exists or puts it somewhere other than the module
  built for it (for example, database queries written outside the repository that holds the rest).
- On iPhone and iPad, a ticket's header (its title, badges and buttons) now slides out of the way
  when you scroll down its Summaries, Transcript, Tickets, Agents or Details tab, leaving the tabs
  pinned at the top and more room to read. Scroll back up a little, tap the current tab, or tap the
  status bar to bring it back. It also comes back on its own when the ticket changes status or needs
  an approval.
- On iPhone and iPad, the **Move to in progress** switch and the hint over a ticket's message box
  now appear only once you tap into the box. If you leave it empty, they go away again. If you've
  typed a message, they stay until you send it.

### Removed

- The Dummy driver no longer appears in the driver and model pickers or under Settings →
  Drivers. It only ever returned canned replies for testing, and now shows up only in test runs.

## [app-20260930.1921](https://github.com/markhuot/harness/releases/tag/app-20260930.1921) - 2026-09-30

### Added

- Tickets linked to a remote item, such as a Jira issue, now show its ID (MH-62) wherever the
  ticket's key used to appear: cards, pane headers, links, the command palette, the Inbox and
  toasts. The ticket's own key follows in muted text ("MH-62 · MH-124"), so several tickets for
  the same Jira issue, or a local ticket that happens to share the number, stay easy to tell
  apart. Searching for the remote ID finds every ticket linked to it.
- You can link a ticket to a remote ID by hand, or unlink it, from its settings on the Mac,
  iPhone and iPad (**Remote ID**, with an optional link).
- A ticket's details list the other tickets that share its remote ID. Opening a remote ID that
  isn't any ticket's own key, from a link for example, shows those tickets to choose from rather
  than a "not found" pane.
- Done tickets have a message composer on the Mac and on iPhone and iPad, so you can ask the
  agent about finished work without re-opening the ticket.
- On the Mac, iPhone and iPad, typing `/` at the start of a new session or a message lists the
  agent's slash commands and skills with their descriptions, the same ones Claude Code offers
  in that project: your own skills in `~/.claude/skills`, the project's, plugin commands, and
  built-ins. Pick one to complete it, then type its arguments. Sending `/code-walk this branch`
  runs the code-walk skill on this branch. The list follows the agent the session runs with, so
  it's empty for agents that don't have commands.

### Changed

- Tickets that watchers create get the project's next number (MH-124) instead of taking the
  remote ID as their key, and they're renamed along with the project like any other ticket.
  Tickets created this way earlier keep their keys.
- An update about a Jira issue no longer goes to an existing ticket just because it carries the
  same ID. Triage now either picks the ticket to update or starts a new one, and it sees every
  ticket already linked to that issue when it chooses. A review that goes through three rounds
  can be three tickets.
- When you reply to a blocked ticket, it stays in Blocked until its agent picks the work back up.
  If your reply answers what the agent asked, the agent moves the ticket to In progress and carries
  on, and if you only asked it something, it answers and the ticket keeps waiting on its question.
  Before, a reply sent with the composer's switch off left the agent unable to send its finished
  work to review, so the ticket sat in Blocked.
- A message to a ticket in review or a done ticket leaves it where it is, and the agent can still
  change the work and send it back to review. To move the ticket first, turn on **Move to in
  progress** (review) or **Re-open and move to in progress** (done) above the composer. The switch
  starts off on every ticket and turns itself off after each message.
- A message to a planning ticket always goes to its planning agent, which revises the plan.
- When the agent asks for an approval while answering your message, the card shows on the ticket
  without moving it to Blocked.

### Removed

- The composer's **Revise the plan** switch, and the switch remembering its setting for each
  ticket.

### Fixed

- A watcher update for a remote item (Jira MH-62) no longer lands on an unrelated local ticket
  whose key happens to be the same.
- On the Mac, the `@` file list (and the new `/` command list) opens right under the line you're
  typing on and follows you to new lines. In a New session it used to stick to the top of the
  window, far from the text.
- On the Mac, the command palette now offers a ticket's actions (Approve and merge, Request
  changes…, Re-open…) after you click its card on the board, or click anywhere in its pane that
  isn't a button, such as its title or summaries. Before, those clicks left the palette with only
  the general commands.

## [app-20260930.1626](https://github.com/markhuot/harness/releases/tag/app-20260930.1626) - 2026-09-30

### Added

- The iPhone and iPad app is on TestFlight, so any iPhone or iPad can install it from the public
  link on the install page, not just devices registered to the developer team. Each release
  shows up in TestFlight once Apple's beta review approves it, with that release's notes under
  What to Test.
- The install page links a privacy policy for the iPhone and iPad app (harness-install.vercel.app/privacy.html).
- On the Mac, **Equalize Panes** (⌘=, also in the View menu and the command palette) gives every
  pane except the board an even share of the room beside its siblings. Three panes side by side
  each get a third of the space the board leaves, and two panes stacked in one of them each get
  half its height.
- On the Mac board, ⇧⌘↩ opens the card under the keyboard cursor in a new pane instead of
  replacing the ticket you already have open. With the board and one ticket open, you get the
  board, that ticket, and the new one side by side. Plain Enter still opens the card in the
  ticket pane beside the board.

### Changed

- The install page at harness-install.vercel.app is rewritten for anyone at the company, not just
  Mark's own devices. It explains what Harness does with screenshots of the board, reviews, each
  ticket's branch and changes, approvals, conductor tickets, watchers and the iPhone app, and a
  Getting started section walks through setting up the Mac, adding a project, making a ticket and
  pairing a phone. When the iPhone and iPad app has a TestFlight link, the page's main button is
  **Get it on TestFlight** with the steps to accept the invite, and the development build becomes
  a smaller link for devices registered to the developer team.
- On the Mac, ⌘1 is now labeled for where it goes: **Go to All Projects** in the command palette
  and **All Projects** in the File menu. Typing "board" or "all projects" in the palette finds it
  next to each project's board.
- On the Mac, the command palette names a ticket's actions the way its buttons do. With a ticket
  in review focused, ⌘K and "Approve and merge" runs the same thing as the Approve and merge
  button, and the Approve menu's other choices (Approve and open PR, Approve and…) are there too.
  Once a ticket is approved, the Complete choices read "Complete and merge…" and so on. The
  palette also understands other ways of saying things, such as "reopen ticket" on a done ticket
  or "stop run" for Cancel run. The focused ticket's actions now come before the rest of the
  commands.
- On the Mac, dragging the divider between panes now resizes every pane on each side of it
  together, keeping their proportions. With three panes, dragging the right divider to the left
  grows the right pane and shrinks the other two alike. Hold Option while dragging, or while
  using the arrow keys on a focused divider, to resize only the two panes touching it.
- On the Mac, dragging a pane between two of its neighbors in the same row or column keeps every
  pane's size. Before, the widths were reshuffled on drop.

### Fixed

- On the Mac, the project picker in a New session pane now shows a focus ring when you Tab to it.
- On the Mac, switches can be reached with Tab and turned on or off with Space. This includes Skip
  agent review in a New session's Options, the switches in Settings and project settings, and the
  one in a ticket's chat bar. Each shows a focus ring while it has the keyboard.

### Removed

- A Claude Code agent waiting on its own background job (a long monitor, an import that runs for
  days) no longer gives up after 30 minutes. It keeps waiting as long as the job runs, and it
  wakes up now and then to check on the job and post progress to the ticket. Stop the ticket if
  you want the wait to end sooner.
- On the Mac, View → Zoom In and Zoom Out (⌘= and ⌘-) are gone, since ⌘= now equalizes panes.
  View → Actual Size (⌘0) is still there to undo an earlier zoom.

## [app-20260930.1424](https://github.com/markhuot/harness/releases/tag/app-20260930.1424) - 2026-09-30

### Changed

- The Mac app on the install page is now notarized by Apple, so anyone can download it and open
  it like any other app. The first launch no longer stops at "Apple could not verify" or needs
  Open Anyway in System Settings → Privacy & Security.

## [app-20260930.1358](https://github.com/markhuot/harness/releases/tag/app-20260930.1358) - 2026-09-30

### Added

- On the Mac, a ticket or terminal pane can pop out into a window of its own. Click the new
  pop-out button next to Maximize in the pane's header, or press ⇧⌘O, and the pane moves into a
  window near where it was. A terminal keeps its shell and everything it printed. Click the same
  button in that window, or press ⇧⌘O again, to put the pane back on its board. Closing the
  window closes the pane, and closing the pane closes the window. View → Pop Out Pane does the same.
- Ticket keys such as HARNESS-12 in summaries, comments, ticket briefs, transcript messages, and
  Inbox outcomes are now links. Click or tap one to open that ticket, on the Mac or on iPhone and
  iPad. A key links when it belongs to one of your projects or to a ticket on the board, so text
  like UTF-8 or SHA-256 stays as it is.
- On the Mac, code in chat messages and summaries is syntax highlighted in the same colors as the
  Git tab, and follows your light, dark and color theme. Diffs show added and removed lines the way
  the Git tab's diff viewer does. Hover a code block to copy it.
- On iPhone and iPad, code in chat messages, briefs and summaries is syntax highlighted in the same
  colors as the Mac and the Git tab, and follows your light, dark and color theme. In diffs, added
  and removed lines get green and red backgrounds, and the code in them is colored by its file's
  language.
- On the Mac, clicking a file link in a chat message, summary or brief opens the whole file in a
  new file pane beside the ticket. The file is syntax highlighted, and a link to specific lines
  scrolls to them and highlights them. Following another link into the same file reuses its pane.
  Click or drag the line numbers to pick lines, and use **Copy link** in the pane's More menu to
  share them. Files that git ignores open too, marked "ignored", and file panes stay open when
  you quit and reopen the app.
- When a file in the file pane has uncommitted changes, a **Diff** tab shows what changed since
  the last commit, in the same style as the Git tab, as unified or split.
- On iPhone and iPad, tapping a file link in a chat message, brief or summary opens the file with
  syntax highlighting and line numbers, scrolled to the linked lines and with them highlighted.
  When the file has uncommitted changes, a Diff tab shows them. Pull down to reload. File links
  opened from outside the app (`harness://file/…?ticket=…`) open there too.
- On the Mac, **Open File…** (⌘P), or typing `@` in the command palette, finds any file in the
  focused ticket's folder or the board's project, including files git ignores such as `.env` and
  anything in `node_modules` (tagged "ignored" in the list), and opens it in a file pane. Type
  `src/app.ts:120` or `src/app.ts#L120-L130` to open it at those lines. With nothing typed, it
  lists the files you opened last. Typing a path in the palette without the `@` shows a few
  matching files too.

### Changed

- The Mac app's icon now uses the same purple artwork as the iPhone and iPad icon, and the white
  frame around it is gone.
- Agents now link the code they quote in messages and summaries, so you can open the whole file
  at those lines.

### Fixed

- A chat message (the composer's "Move to in progress" or "Revise the plan" switch turned off) no
  longer limits what the agent can do. It reads the code, runs commands, and makes changes you ask
  for with the same permissions as the ticket's regular runs, and the ticket still stays in its
  column without starting another review.
- Typing a new session's prompt on the Mac no longer stops after the first letter. When the draft
  saves and its pane picks up the ticket's key, the prompt keeps the keyboard, so you can keep
  typing. Moving a draft to another project doesn't interrupt your typing either.

## [app-20260930.0429](https://github.com/markhuot/harness/releases/tag/app-20260930.0429) - 2026-09-30

### Added

- Harness now runs on iPad as a full iPad app, in portrait and landscape and alongside other
  apps in Split View and Stage Manager. The install page's **Install on iPhone or iPad** button
  installs it on any iPad registered to the developer team. Register a new iPad before the
  release that should install on it is built. On an iPad, the app's messages about pairing and
  tokens say "iPad" instead of "iPhone".

## [app-20260930.0148](https://github.com/markhuot/harness/releases/tag/app-20260930.0148) - 2026-09-30

### Changed

- Messages you send to a working ticket now reach the running agent right away, instead of
  waiting for the run to finish. The agent reads your message at its next step and can change
  course mid-run. If it can't take the message in (for example, it had just finished), the
  message waits for the next run, and the transcript says so.
- On the Mac, the sidebar's ticket count next to All projects and each project is now a small
  colored pill that splits the count into in progress (yellow), blocked (red), and in review
  (purple). A status with no tickets drops out, so a board with one ticket in progress shows a
  single yellow 1. Planning and done tickets aren't counted. Hover the pill to see what each
  number means.

### Fixed

- On the Mac, an open ticket's title has more room below the pane header, so it no longer sits
  right against the header's tint when the pane has focus.

## [app-20260930.0009](https://github.com/markhuot/harness/releases/tag/app-20260930.0009) - 2026-09-30

### Added

- New sessions are saved as drafts while you type. A draft is a ticket that hasn't started yet,
  so it shows up in Planning (with a dashed, dimmed card and a Draft badge) in its usual place,
  and the arrow keys stop on it like any other card. Drafts sync between the Mac and iPhone, so
  you can start one on your phone and finish it at your desk.
- Closing a draft asks whether to save it or discard it. Saving is the default, and a draft with
  nothing typed in it closes without asking.

### Changed

- On the Mac, New session opens as a pane next to the board instead of a window on top of it, so
  you can write a new session with another ticket open beside it, or keep several going at once.
  Its pane is tinted and marked Draft until you start it.
- New session keeps its settings under a collapsed Options row, which lists anything you've
  changed from the project's defaults. Options uses the same controls as a ticket's Details tab,
  and it opens by itself when the branch you picked needs a look.
- Task and Conductor now sit next to the project picker at the top of New session.
- Start session and Plan first are separate buttons, replacing the "Start immediately" switch.
  On the Mac, ⌘↩ starts the session and ⇧⌘↩ plans it first.
- The "Use worktree" switch is gone. Pick the branch your project folder already has checked out
  (usually `main`) to have the agent work right in the project folder, or any other branch to
  give the ticket a worktree of its own.
- On iPhone, you now pick the base branch from the project's branches instead of typing it, in
  New session and on a ticket's Details tab. Details shows it only when the ticket has a
  worktree of its own.

### Fixed

- Agents using the Claude Code driver can use your claude.ai connectors (Jira, Atlassian, Google
  Drive and others) from their first reply. Before this, triage often declined work with "the
  Jira MCP isn't available" or "needs re-authorization", because the connectors were still
  connecting when the agent answered.
- A task ticket that does some of the work itself now commits it before completing one of its
  child tickets. Before, its uncommitted changes could stop the child's work from merging into
  its branch.

## [app-20260929.2219](https://github.com/markhuot/harness/releases/tag/app-20260929.2219) - 2026-09-29

### Added

- The Approve button on a ticket in review now asks how the work should land. "Approve and
  merge" merges the ticket's branch into its base branch, as approving always did. "Approve and
  open PR" pushes the branch and opens a GitHub pull request, and the ticket is done once the pull
  request is open (your team reviews and merges it on GitHub). "Approve and…" lets you write your
  own instructions for the agent, like "cherry-pick this onto release-2.4". "Approve and take no
  action" approves the ticket and marks it done without running an agent. The same choices are
  on the Complete button when you complete tickets yourself, on the Mac and iPhone.
- Open PR shows up only for projects whose git remote is on a host the GitHub CLI (`gh`) is
  logged into, including GitHub Enterprise. Projects on Bitbucket or GitLab, or without a remote,
  get merge and your own instructions, and a folder that isn't a git repository gets a plain
  Approve plus "Approve and…".
- A ticket that opened a pull request links to it from its header and from its card on the
  board. If you re-open the ticket to address review comments, approving it again pushes the new
  commits to the same pull request.
- Project settings have a "When approved" choice for what the Approve button does by default.
  It's also what happens when nobody picks, such as when the project doesn't require your review
  or a conductor completes its child tickets.

### Changed

- A ticket's Details tab on the Mac and iPhone now has one searchable Model menu in place of its
  separate Driver and Model menus, the same menu New session uses. Picking Opus under Claude Code
  sets both at once, and Default puts the ticket back on its project's driver and model. While a
  run is going, the menu lists only the ticket's current driver's models, so you can still switch
  the model for the next run.
- Settings → Models and each project's settings have a single Default model menu in place of the
  Default driver menu and the per-driver default model rows. Picking a model there sets the
  default driver too and clears the default models saved for other drivers. The agent review
  model is still set per driver.
- A conductor's child tickets now start from the conductor's branch and merge back into it, so
  the whole goal stays on one branch until you approve the conductor itself.
- The completion prompts in Settings → Prompts are now split into merge, pull request and custom
  versions. If you had customized the completion prompt, your text carries over to the merge
  version.

## [app-20260929.1932](https://github.com/markhuot/harness/releases/tag/app-20260929.1932) - 2026-09-29

### Added

- You can skip the agent review for a ticket that doesn't need one, like a quick question. The
  New session window on the Mac and iPhone has a "Skip agent review" option, and a ticket's
  Details tab lets you turn it on or off later. When the agent submits the ticket, it goes to
  Review with the agent review marked as skipped and waits only on you, so your approval
  finishes it without waiting for a reviewer agent. The agent can also skip its own review when
  you ask for no bot review or when it only answered a question, as long as the project still
  requires your review.
- You can rewrite the instructions Harness gives its agents. Each part of the built-in prompts
  (the work, review and completion rules, the ticket lifecycle, the triage instructions, and the
  rest) can be replaced with your own text, and it applies to every run from then on. A prompt you
  haven't changed keeps the built-in text, so it picks up improvements when you update the app,
  and resetting a prompt goes back to the built-in. Harness refuses a prompt that names a variable
  it doesn't have (a typo like `{{brnch}}`), so a mistake never reaches an agent. Agents can also
  change a prompt for you, after you approve it.
- On the Mac, Settings → Prompts lists every agent prompt, split into system prompt sections and
  run messages, and marks each one Built-in or Customized. Open a prompt to read its built-in
  text, click Customize to edit a copy, and save with Save or ⌘S. The editor lists the variables
  the prompt can use (click one to insert it), flags a mistake like `{{brnch}}` as you type, and
  can show what you changed next to the built-in. Reset to built-in puts the prompt back on the
  text that updates with the app. If an app update leaves one of your prompts naming a variable
  that no longer exists, the prompt shows "Not in use" and explains that runs use the built-in
  until you fix or reset it.
- On iPhone, Settings → Prompts lists the same prompts, grouped the same way, with a Built-in,
  Customized or Not in use badge on each. Tap a prompt to read its built-in text and the
  variables it can use, then tap Customize to edit a copy and Save it from the top bar. Mistakes
  like `{{brnch}}` show up under the text as you type, and nothing you typed is lost if the Mac
  refuses the save. Tapping a variable inserts it at the cursor, Compare with built-in shows what
  you changed, and Reset to built-in asks first, then puts the prompt back on the text that
  updates with the app. A prompt that an app update left naming a missing variable says so, both
  in the list and when you open it.
- Each watcher can now pick the model its triage agent runs on. The watcher form's driver menu
  is now a single Model menu that lists every signed-in driver's models under that driver's name,
  so picking Opus under Claude Code sets both at once. With only one driver signed in, the menu is
  a plain list of that driver's models. New and existing watchers stay on Default.
- The Model menu has a search field, so you can type "son" to jump to Sonnet when several drivers
  (or one with a long model list) are signed in. The New session window uses the same menu in
  place of its separate Driver and Model menus.
- Settings has a default model for every watcher that doesn't pick its own (on the Mac, at the
  top of Watchers; on iPhone, in a Triage group above Watchers). You can set all watchers to
  Claude Code with Sonnet, then switch one watcher to Opus when its output needs more reasoning.
- You can tell a ticket's agent to move its work to another branch ("update the branch for this
  ticket to medl-1223-ai-app"). The agent brings its commits over and the ticket switches to that
  branch. If the branch is already checked out in another worktree, the ticket moves into that
  worktree and keeps its conversation. The old worktree and branch are left for you to clean up.
- Settings, projects and tickets now have a base branch: the branch a finished ticket merges
  into, and the one a new ticket branch starts from. It defaults to `main`, a project can set its
  own, and a single ticket can override both. Agents can set a ticket's or project's base branch
  for you, and the Changes tab compares against a project's or ticket's base branch when one is set.
- On iPhone, Settings → General has a Base branch field, and a git project's settings have one
  too. Leave the project's field empty to use the app's value, which shows as the placeholder.
- On iPhone, New session has a Branch picker for git projects. It starts on "New branch
  harness/<key>", and you can search the project's branches or type a new name, which the ticket
  creates from the base branch. A line under the picker says what will happen, including a warning
  when another worktree already has the branch checked out. A Base branch field next to it
  overrides the project's for this one ticket.
- On iPhone, a ticket's Details tab shows its branch and base branch, and marks the base branch
  as inherited when the ticket doesn't set its own. You can change the base branch until the
  ticket is done, and you can pick a different branch until work starts.
- On the Mac, Settings → General has a Base branch field, and a git project's settings have a
  Base branch picker that inherits the app's value when left on its default.
- The Mac's New session window has a Branch picker for git projects. It starts on a new
  `harness/<key>` branch, and you can type to search the project's branches, pick an existing one,
  or type a new name that gets created from the base branch. A second picker next to it overrides
  the base branch for this ticket. If you pick a branch that's already checked out in another
  worktree, the window warns you that the ticket will block when it starts.
- A ticket's Details tab on the Mac shows its branch and its base branch (marked when the base is
  inherited). You can change the base branch until the ticket is done, and the branch until its
  worktree exists.

### Changed

- A ticket with no summaries yet now opens on its Transcript tab, on the Mac and on iPhone, so you
  see what the agent is doing instead of an empty Summaries tab. Tickets that have summaries still
  open on Summaries.
- New ticket branches now start from the base branch instead of whatever happens to be checked
  out in the project folder, and finished tickets merge into the base branch by name. A repository
  without a `main` branch (and no base branch set) keeps the old behaviour and uses the branch
  checked out in the project folder.
- When a ticket can't get its branch (another worktree already has it checked out, or the base
  branch doesn't exist), it moves to Blocked with a message naming the branch and folder.
- When a ticket finishes, the agent only removes the branch and folder the harness made for it.
  Your own branches and worktrees stay put.
- When auto mode's classifier turns down one of an agent's commands, the agent now looks for a
  safer way to do the same thing and keeps going. It only stops to ask you when there's truly
  no other way. If it finishes another way, the ticket goes to review as usual, with a note
  listing what was turned down.

### Fixed

- A Claude Code agent that starts a long command in the background (such as a test run that
  outlasts the two-minute command limit) and ends its turn to wait for it now waits for it and
  carries on. Before, the command was cut off when the turn ended, and the ticket went to review
  with "I'll be notified when it completes" as its summary. While it waits, the ticket shows a
  status line, and it stops waiting after 30 minutes.
- Choosing "Allow once" on an auto-mode ticket no longer makes you approve every command for
  the rest of that turn. Before, allowing a command with a pipe or `2>/dev/null` in it sent even
  plain file reads to you for approval until the agent finished.
- On the Mac, the sidebar button beside the window's traffic lights collapses and expands the
  sidebar again. Clicking it used to grab the window as if you were dragging the title bar, so the
  sidebar stayed put. ⌃⌘S and View → Show Sidebar weren't affected.

## [app-20260929.0234](https://github.com/markhuot/harness/releases/tag/app-20260929.0234) - 2026-09-29

### Fixed

- On iPhone, a bulleted or numbered list in your own message now shows its text in the transcript.
  Before, only the bullets or numbers appeared.
- Stopping a watcher now stops everything its command started. A looping command such as
  `while true; do curl …; sleep 60; done` used to keep running after its watcher was disabled or
  deleted, and made the Harness service take 25 seconds to quit or restart.
- Summary screenshots and videos load on the iPhone again. Over Tailscale or the local network,
  the thumbnails and the full-screen viewer showed "Couldn't load" even though the Mac app showed
  them.
- A message you sent with a table or a code block in it no longer hides the agent's replies. On
  iPhone it filled with a long stretch of blank space, and the transcript opened in the middle of
  it. On the Mac, the table squeezed its columns to a word or two per line in a narrow window.
  Wide tables in messages, plans and summaries now scroll sideways instead.

## [app-20260928.2051](https://github.com/markhuot/harness/releases/tag/app-20260928.2051) - 2026-09-28

### Fixed

- On iPhone, tapping a ticket no longer crashes the app. The app-20260928.1943 build was missing
  the video player that summary attachments use, so it quit whenever a ticket opened.

## [app-20260928.1943](https://github.com/markhuot/harness/releases/tag/app-20260928.1943) - 2026-09-28

### Added

- You can drive the Mac app from the keyboard. On the board, h j k l (or the arrows) move between
  cards and Enter opens one beside the board. In a ticket, ⇧⌘[ and ⇧⌘] (or 1 to 9) switch
  tabs, j and k scroll, and i jumps to the reply box. ⌥⌘ and an arrow (or ⌃h ⌃j ⌃k ⌃l) moves to
  the pane in that direction, and left from the board goes into the sidebar. The sidebar, the
  Inbox, a conductor's Tickets tab and every menu work with the arrow keys or j and k, and dialogs
  keep Tab inside them and put the focus back when they close.
- ⌘K opens a command palette. Type part of a ticket's key or title to jump to it (older Done
  tickets included), or the name of a command. The actions for the ticket you're on (Start work,
  Approve, Request changes, Complete and the rest) are there too. ↑ and ↓ pick, Enter runs, and
  your recent picks come first.
- Press ? (or ⌘/) for a list of every keyboard shortcut. Help ▸ Keyboard Shortcuts has it too,
  and the View menu lists the new pane and tab shortcuts.
- While you're using the keyboard, the pane or sidebar it's acting on gets an accent outline, and
  the card or item you're on gets a focus ring. Clicking hides them again.
- Agents can attach screenshots and short screen recordings to the summaries they post, so a
  ticket can show what changed (a UI before and after, or a browser flow) along with the
  description. They're asked to do this whenever their work has a visible result, especially
  when they submit it for review.
- On the Mac, a summary's screenshots and recordings show as thumbnails under its text, and a
  video thumbnail carries a play badge. Click one to see it at full window size (videos play
  with controls). Use ← and → or the side arrows to move between a summary's attachments, and
  Esc or a click outside to close it. A file that can't be loaded shows its name instead of a
  broken image. A conductor's Tickets tab notes when a child's latest summary has attachments.
- On the iPhone, a summary's screenshots and recordings show as a row of thumbnails under it.
  Tap one to see it full screen: pinch or double-tap to zoom, swipe sideways to the summary's
  other attachments, and videos play with the usual controls. Swipe down or tap ✕ to close. A
  file that can't load shows a placeholder instead.
- When the harness service is running older code than the Mac app, a banner under the board says
  so, and it stays until the service restarts. Actions the older service doesn't know about fail
  with a plain "Not found" until it restarts (re-opening a done ticket was one), so the banner
  explains those errors. Restart now restarts the service right away. If agents are running, it
  asks first, since restarting stops them.
- The Inbox, on the Mac and the iPhone, lists your watchers at the top with what each one is
  doing right now: running (and since when), waiting for its next run, or failed and waiting to
  retry, with the error. Click the error to read all of it, and use Retry now to restart a failed
  watcher without waiting out its backoff. The status updates live. Paused watchers are shown
  dimmed.

### Changed

- ⌘W closes the focused ticket or terminal pane (File ▸ Close Pane). With the board focused it
  still closes the window.
- On the all-projects board, a card's project key now sits in front of its ticket key
  ("HAR HARNESS-39") instead of at the bottom of the card. Cards no longer carry a Conductor
  badge either, since a conductor's progress bar already marks it. Both changes apply on the Mac
  and the iPhone. The ticket page still shows the Conductor badge.
- Any ticket can act as a conductor now. If you ask a regular ticket's agent for child tickets,
  it creates them under that ticket, then reviews and completes each one. The ticket gets the
  progress bar on its card, and the Conductor badge and Tickets tab on its page, on the Mac and
  iPhone. It goes to review only after every child is done. Choosing Conductor for a new session
  still changes how the agent starts: it splits the goal into tickets instead of doing the work
  itself.
- The `@` file list now includes files your project's `.gitignore` leaves out, like build output,
  local specs and `.env` files. `node_modules` shows up as a folder: pick it (or type
  `@node_modules/`) to browse what's inside.
- The service restarts onto new code by itself. When a merge updates the code it runs from, it
  waits until no agents are running and then restarts, so you don't have to restart it by hand
  after an update.

### Fixed

- Tables in plans, summaries, ticket descriptions, the transcript and the Inbox now show as real
  tables on the Mac and the iPhone, instead of rows of `| pipes |` and `---` dashes. Columns
  follow the alignment the agent asked for, and a wide table scrolls sideways. Board cards show a
  table's rows as plain text.
- A loop watcher's old error now goes away once its process starts again. Before, a watcher that
  failed once and then ran fine for hours kept showing that first failure in Settings.
- When you chat with a ticket's agent (the composer switch turned off) and ask it to change
  something, it now tells you which switch to turn on: "Revise the plan" for a planning ticket,
  "Move to in progress" for a blocked or review ticket. Before, a chat about a plan could claim
  the agent lacked permission, or suggest moving the ticket back to planning when it was already
  there.
- The Agents tab no longer lists an empty "Sub-agent" for every command the agent ran for more
  than 30 seconds. Those rows weren't sub-agents, and they're gone from existing tickets too.

### Removed

- Board cards no longer show a green Ready badge once both reviews approve. The two checkmarks
  next to the bot and person icons already say it's ready. This applies on the Mac and the
  iPhone.

## [app-20260928.1702](https://github.com/markhuot/harness/releases/tag/app-20260928.1702) - 2026-09-28

### Added

- New session has a **Use worktree** switch next to **Start immediately**, on the Mac and the
  iPhone. It starts out matching the project's Worktree per ticket setting. Turn it off and the
  agent works directly in the project folder instead of its own worktree and branch. The switch
  only appears for projects in a git repository. On the Mac, the two switches now sit on their own
  row with the start button.
- On the Mac, you can open a terminal as a pane. The New session button in the sidebar has a menu
  next to it with **New terminal**, and there's also File ▸ New Terminal (⌘T) and **New terminal
  in …** when you right-click a project. On a project's board, the terminal starts in the
  project's folder, and on All projects it starts in your home folder. Terminals split, move, zoom
  and close like ticket panes, and you can open as many as you like. Switch to another project and
  back, and the terminal is still running with its history. Closing the pane ends the shell.
- The message box on a ticket in planning, blocked or review has a "Move to in progress" switch
  ("Revise the plan" in planning), on by default. Turn it off to just talk with the agent about
  the ticket: it answers without changing any files, and the ticket stays where it is. Your
  question and its answer show in Summaries. The switch stays off while the ticket is open and
  for 5 minutes after you close it, so you can come back and keep chatting.
- Type `@` in the New session prompt or a ticket's message box to mention a file in the project.
  A list of matching files and folders appears as you type; pick one with a tap, or on the Mac with
  ↑/↓ and Enter or Tab (Escape closes the list). Picking a folder shows what's inside it. When the
  agent starts, it gets the mentioned files' contents with your message, so it doesn't have to go
  and read them, and the transcript shows which files were attached.

### Changed

- On the Mac, each project remembers its own panes, and so does All projects. Open a ticket
  beside one project's board, switch to another project, and you'll see that project's panes (or
  just its board the first time). Switch back and the first project's panes are where you left
  them. The panes you had open before this update stay on All projects.

### Fixed

- On the Mac, deleting a ticket now closes its pane on every board, and removing a project closes
  its tickets' panes on All projects.
- A ticket's working spinner now goes away when its run crashes. If Harness can't save a run's
  result (when the disk is full, for example), the run is marked failed as soon as saving
  works again, and the agent behind it is stopped. Before, the card stayed stuck on working
  until the next restart, even after the ticket moved to Done.

## [app-20260928.1438](https://github.com/markhuot/harness/releases/tag/app-20260928.1438) - 2026-09-28

### Fixed

- The iPhone app now carries each release's build number (for example 202609281418) instead of
  1, so the install page and the release notes show which build you're installing, and each
  new release installs as a newer build than the last.

## [app-20260928.1418](https://github.com/markhuot/harness/releases/tag/app-20260928.1418) - 2026-09-28

### Added

- On the Mac, you can drag a card onto the left, right, top or bottom half of the board or an
  open ticket to see several tickets side by side or stacked. While you drag, a tinted outline
  shows where the new pane will go. Dropping a card on the board's right half opens it the same
  way a click does. Rows in a conductor's Tickets tab drag the same way, so you can open a child
  next to its conductor. To move a pane you already have open, drag the grip beside its ticket key.
  Right-click a card (or press the context-menu key on it) and pick Open to the Right, Below, to
  the Left or Above to do the same thing without dragging. Cards now take keyboard focus, and
  Enter opens them. A ticket's More menu has Move pane buttons that put its pane to the left or
  right of, above, or below the board or any other open ticket.
- When a ticket's agent hands part of its work to sub-agents (Claude Code's Agent tool), the
  ticket gets an Agents tab on the Mac and iPhone, next to Transcript. It lists each sub-agent
  with its task, its type, how long it has run and whether it's still going, finished, failed or
  stopped. A dot on the tab means one is running. Tap a sub-agent to read its own conversation,
  with the task it was given at the top and a way back through any agent that started it. The
  ticket's transcript no longer mixes in sub-agent output. Each Agent call in the transcript now
  links to that sub-agent's conversation instead.
- Each file in the Changes tab has a Viewed checkbox in its header, like a pull request review on
  GitHub. Checking it folds that file's diff down to its header, the file list marks it with a
  check, and the toolbar counts how many files you've viewed. The arrow at the left of the header
  opens a viewed file again without unchecking it, and it can fold any other file too. Harness
  remembers what you've viewed through reloads and when you switch tickets. If the agent changes
  a file after you viewed it, the file comes back unviewed and open.
- The Changes tab has a button at the left of its toolbar that hides and shows the file list, so
  the diffs can use the full width. Harness remembers your choice, so the file list stays the
  way you left it when you reload or move to another ticket. In a narrow pane the same button
  still opens the file list over the diffs.
- Projects can have a color. Pick one of eleven presets (or Custom for any color you like) in
  project settings, and the project's key badge takes that color in the sidebar, on cards, in
  the board header and on tickets. On the Mac, Custom opens the system color panel. On iPhone it
  opens a grid of shades with a hex field for an exact value. Projects without a color keep the
  theme's accent, and every color is adjusted so its badge stays readable in light and dark
  themes.
- Ticket details now show the project's key badge next to the ticket's other badges.
- Watchers now take any command that prints text, plus a prompt that tells triage what you
  want done with the output (for example, "If this event is assigned to me and has actionable
  next steps, dispatch it to an agent in PLAYR"). The command runs in your login shell, so
  pipes, your PATH, and loops like `while true; do curl -s …; sleep 60; done` all work. Output
  doesn't need a particular format anymore.
- Whatever a watcher prints shows up in the Inbox. In interval mode each run becomes one item,
  and in loop mode each burst of output does. Blank output is skipped, output the watcher
  already printed isn't triaged twice, and output over 16,000 characters is cut off with a
  note. Each item is titled with its first line until triage gives it a better title.
- When one piece of output covers several tickets (like a batch of Jira issues), triage can
  dispatch each of them. When the output is about a ticket you already have, the update goes
  to that ticket as a message.
- Agents can now read other tickets on the board for context. Any agent (planning, working,
  reviewing, completing, conducting, or triaging) can search tickets by key or words, list a
  project's tickets by status, and open a ticket to see its brief, its summaries and, when it
  asks, the last few messages of that ticket's agent. They can also see the Inbox: what each
  watcher printed and what triage did with it. All of this is read-only.
- Working and conducting agents can now change other cards on the board the way you do. They can
  file a new ticket for work they find along the way (it lands in Planning unless they start it),
  edit a card's title, brief, agent, model or dependencies, drag it to another column or reorder
  it, start it, message its agent, stop its agent, and re-open a done ticket with notes. Agents
  can't touch their own ticket this way. They also can't move a ticket into or out of Review, mark
  finished work done, answer or cancel a ticket that's waiting on your tool approval, or relax a
  ticket's permission mode. Tickets an agent creates never run under a looser permission mode than
  the agent's own, and an agent can't hand work to a ticket whose mode is looser than its own
  (for example, a read-only agent messaging or editing a ticket that runs in auto). It can still
  tighten that ticket's mode. Only a ticket still in Planning can be moved straight to Done.
- Agents can now set up watchers, projects, and settings for you. A ticket like "add a
  watcher that polls our events API every minute and dispatches anything assigned to me with next
  steps" gets the watcher's command, schedule, and triage instructions filled in for you. Agents
  can also delete tickets and projects, though never their own ticket, its parent tickets, or the
  project they're working in. Each of these changes waits for you: the ticket shows an approval
  card with a plain description of the change (for a watcher, the exact command it will run, its
  triage instructions, and the names of any environment variables or working folder it sets,
  never their values) and moves on only after you tap Allow once. These cards have no
  "Always allow" button, and a read-only ticket can't make these changes at all. Agents can't see
  or set your Anthropic API key, pair devices, or rotate the access token.

### Fixed

- On the Mac, menus (like a ticket's More menu) stay inside the window. Near the right edge they
  shift left, and near the bottom they open upward. When panes are narrow, a ticket's title bar
  hides its model and status badges instead of running into the pane next to it.
- On the Mac, a split layout saved in a wider window (or a window you've made narrower) no
  longer squeezes a pane below its minimum width. Ticket panes stay at least 360 pixels wide and
  the board at least 320 pixels, as long as the window has room for them.
- When the agent edits a file again while the Changes tab is open, that file's diff now updates
  to show the new lines. Before, the tab kept showing the older diff for that file until you
  reloaded it.
- A ticket that's finishing up (merging its branch and removing its worktree) no longer gets
  stuck in Blocked with "Working directory does not exist" when someone messages it or asks for
  changes mid-merge. Those now get an error that says to wait until it's done and re-open it, and
  a ticket that's already done stays done.
- On iPhone, opening a watcher's edit screen from a link while the app was closed no longer
  shows an empty form.
- The Changes tab stays on a ticket after it's completed. Once the branch is merged and its
  worktree removed, the tab shows the diff as it was when the work was approved, including any
  changes that were never committed, along with the branch's commits. A "Saved" label in the
  tab's header marks it. Tickets completed before this update don't have a saved diff, so their
  Changes tab still disappears.

### Changed

- On the Mac, ticket details now open in panes you can resize, instead of in a fixed panel on
  the right. Clicking a card still opens the ticket beside the board, and clicking another card
  swaps it in. Drag the divider between panes to resize them (double-click it to make them
  equal), and your layout is still there after a restart. Links inside a ticket, like a
  conductor's child tickets or the "Part of" link, open in the same pane. Maximize (the button
  that used to expand the panel) fills the window with one pane until you press it again or
  hit Escape. Escape closes the ticket pane you're working in.
- In the New session window on the Mac, "Add project…" is now the last choice in the project
  dropdown instead of a separate button, and the "New session" label in the corner is gone.
- The watcher form on Mac and iPhone has a single Command field and a new Prompt field in
  place of the separate command and arguments fields. Watchers you already have keep running
  as they are. Saving one from the form turns its command and arguments into one command line,
  which then runs in your login shell too, so your shell's startup files apply to it.
- A blocked ticket no longer repeats the agent's question in a red box at the top of the ticket.
  The Blocked pill shows the status and the question is on the Summary tab. Failed runs and
  worktrees that couldn't be created now put their error on the Summary tab too, so every
  reason a ticket is blocked still shows up there.
- Board cards only show the agent (Claude Code, Codex) when a ticket runs on something other
  than the project's default, the same as the ticket's detail view already did.
- Agents now read and edit files with their file tools instead of shell commands like `sed -i`,
  `cat`, or heredocs. In Ask mode that means fewer approval requests for ordinary edits inside
  the ticket's worktree, and a ticket's activity shows which file each step read or changed.
- On iPhone, choosing a project, driver, model, permission mode, network mode or classifier now
  opens a dropdown menu next to the field, with a checkmark on the current choice, instead of a
  sheet of buttons at the bottom of the screen. Permission modes show
  their description under each name, and drivers that aren't signed in say so.
- On iPhone, board search has its own Search tab. The Board tab no longer has a search bar at
  the top. Search looks through every column and has a Projects button to narrow the results
  to one project.
- On the Mac board, Show child tickets moved from the header into a menu on the search box.
  Click the filter button at the right end of the search box to turn it on or off. The button
  stays highlighted while child tickets are showing.

### Removed

- On the Mac, cards on the board can no longer be dragged between columns or reordered. Agents
  move them as work progresses. Clicking a card still opens it.
- Mappings are gone from Settings on Mac and iPhone, and agents can no longer add or delete
  them. A watcher's prompt now says which project its work goes to, for example "When an
  actionable ticket assigned to me comes in, dispatch it to the PLAYR project." Updating deletes
  any mappings you had, so add the project to each watcher's prompt. Triage declines output when
  the prompt and the output don't make the project clear.
- The Mac board header no longer shows a ticket count or a New session button. Each column
  still shows its own count, and New session is still at the top of the sidebar and on ⌘N.

## [app-20260928.0244](https://github.com/markhuot/harness/releases/tag/app-20260928.0244) - 2026-09-28

### Added

- Done tickets have a Re-open button (desktop and iPhone). Write what the agent should do next, and
  the ticket goes back to In progress with your notes, the same way Request changes works for
  tickets in review. If the ticket's worktree was cleaned up when it completed, it's recreated.

### Fixed

- Messaging a done ticket, or dragging it back to In progress, no longer starts the agent in a
  worktree that was removed when the ticket completed. The worktree is recreated first.

## [app-20260928.0230](https://github.com/markhuot/harness/releases/tag/app-20260928.0230) - 2026-09-28

### Fixed

- Approving a tool call once no longer puts the rest of a ticket in ask mode. Before, an approval
  the agent didn't end up needing stayed on the ticket, and every later turn asked you about
  commands that auto mode would have allowed on its own.
- Approving a command once now covers the agent's retry even when it changes how the command
  runs (in the background, or with a longer timeout), so you're no longer asked to approve the
  same command again.
- Agents working on a ticket that asks for a release or deploy are no longer told never to push,
  which could lead Claude Code's auto mode to block the push.

## [app-20260928.0155](https://github.com/markhuot/harness/releases/tag/app-20260928.0155) - 2026-09-28

### Fixed

- On iPhone, the keyboard no longer hides the bottom of the screen. The ticket composer now sits
  right on top of the keyboard, and you can scroll the New session, Watcher, Connect, Request
  changes and other sheets all the way to their last field while typing.

## [app-20260927.2240](https://github.com/markhuot/harness/releases/tag/app-20260927.2240) - 2026-09-27

### Added

- Tickets can complete themselves once both the reviewer agent and the human approve. A new
  "Complete when approved" switch in project settings (desktop and iPhone) controls it, and it's on
  by default.
- Releases are now cut from git tags. `bun run release:prepare` writes the CHANGELOG section and
  picks the tag name, and `mobile/Tools/publish-install.sh` only publishes a clean checkout of a
  pushed, annotated `app-*` tag on `main`. The iPhone build number comes from the tag, and the
  GitHub release notes come from this file.

### Changed

- The transcript and summaries stay pinned to the bottom as new output arrives (desktop and
  iPhone) and only let go when you scroll up.
- The ticket detail header no longer shows the Working label, the project badge, or the driver
  badge when the ticket uses the default driver.

### Fixed

- The iPhone's Changes tab (and other plugin tabs) loads over LAN and Tailscale instead of failing
  with error -1017.
- Switches have accessible names, and the iPhone's Complete button says why it's busy.

## [app-20260927.1854](https://github.com/markhuot/harness/releases/tag/app-20260927.1854) - 2026-09-27

### Added

- The first Developer ID signed Mac build on the install page, alongside the iPhone build from
  app-20260927.1816.

### Changed

- The install page explains how to open the unnotarized Mac build on macOS 15 and later (System
  Settings, Privacy & Security, Open Anyway), since right-click and Open no longer bypasses
  Gatekeeper.

## [app-20260927.1816](https://github.com/markhuot/harness/releases/tag/app-20260927.1816) - 2026-09-27

### Added

- Color themes on desktop and iPhone: separate light and dark theme pickers with previews, drawn
  from a shared registry (Harness, One, Catppuccin, Solarized, GitHub, Dracula, Nord, Gruvbox,
  Tokyo Night, and Rosé Pine). Plugins receive the active theme, and the git plugin's Changes tab
  follows it.
- The Done column pages from the service (the first 50 tickets, then more as you scroll), and board
  search runs on the service, so it finds done tickets the board hasn't loaded and tickets by an old
  key.
- The desktop sidebar can be collapsed (⌃⌘S) and resized, and the ticket panel can be resized.

### Changed

- Child tickets are hidden by default behind a Show child tickets switch.
- Conductor cards lose their violet left edge; the Conductor badge and rollup identify them.

### Fixed

- A board refresh that arrives while an older page is loading no longer mixes the two.

## [app-20260927.1712](https://github.com/markhuot/harness/releases/tag/app-20260927.1712) - 2026-09-27

### Fixed

- The iPhone app can pair with a Mac over Tailscale. App Transport Security no longer blocks plain
  HTTP to a Tailscale IP.

## [app-20260927.1529](https://github.com/markhuot/harness/releases/tag/app-20260927.1529) - 2026-09-27

### Added

- The first iPhone app release: board, ticket detail with every tab (including the live browser
  and plugin tabs), approvals, Inbox, new sessions, projects, and settings, installed over the air
  from https://harness-install.vercel.app and paired to the Mac by QR code.
- Network settings on the Mac choose where the service listens (localhost, Tailscale, any interface,
  or a custom host), and a Pair a phone screen shows the QR code and rotates the token.
- Permission modes (auto, ask, and read only) per ticket, per project, and globally, with approval cards
  for classifier denials.
- Model selection in the composer, ticket details, project settings, and Settings → Models.
- Plugins, starting with the git plugin's Changes tab.
