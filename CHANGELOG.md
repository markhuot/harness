# Changelog

This file tracks releases of the Harness Mac and iPhone apps. Each release is an annotated git tag
named `app-YYYYMMDD.HHMM` (the UTC minute the release was prepared) with a GitHub release of the
same name that carries the iPhone IPA and the Mac zip. CLAUDE.md has the release steps.

Add entries under [Unreleased] as changes land on `main`, grouped as Added, Changed, Fixed, or
Removed. `bun run release:prepare` moves them into a section for the next tag.

## [Unreleased]

### Added

- Each watcher can now pick the model its triage agent runs on, next to the driver it already
  had. The model list follows whichever driver is selected, so choosing Anthropic API shows the
  models that driver offers. New and existing watchers stay on Default for both.
- Settings has a default triage driver and model for every watcher that doesn't pick its own
  (on the Mac, at the top of Watchers; on iPhone, in a Triage group above Watchers). You can set
  all watchers to Claude Code with Sonnet, then switch one watcher to Opus when its output needs
  more reasoning.

### Changed

- When auto mode's classifier turns down one of an agent's commands, the agent now looks for a
  safer way to do the same thing and keeps going. It only stops to ask you when there's truly
  no other way. If it finishes another way, the ticket goes to review as usual, with a note
  listing what was turned down.

### Fixed

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
