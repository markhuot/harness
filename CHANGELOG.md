# Changelog

This file tracks releases of the Harness Mac and iPhone/iPad apps. Each release is an annotated git tag
named `app-YYYYMMDD.HHMM` (the UTC minute the release was prepared) with a GitHub release of the
same name that carries the iPhone IPA and the Mac zip. CLAUDE.md has the release steps.

Add entries under [Unreleased] as changes land on `main`, grouped as Added, Changed, Fixed, or
Removed. `bun run release:prepare` moves them into a section for the next tag.

## [Unreleased]

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
