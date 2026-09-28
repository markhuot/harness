# Changelog

This file tracks releases of the Harness Mac and iPhone apps. Each release is an annotated git tag
named `app-YYYYMMDD.HHMM` (the UTC minute the release was prepared) with a GitHub release of the
same name that carries the iPhone IPA and the Mac zip. CLAUDE.md has the release steps.

Add entries under [Unreleased] as changes land on `main`, grouped as Added, Changed, Fixed, or
Removed. `bun run release:prepare` moves them into a section for the next tag.

## [Unreleased]

### Fixed

- The Changes tab stays on a ticket after it's completed. Once the branch is merged and its
  worktree removed, the tab shows the diff as it was when the work was approved, including any
  changes that were never committed, along with the branch's commits. A "Saved" label in the
  tab's header marks it. Tickets completed before this update don't have a saved diff, so their
  Changes tab still disappears.

### Changed

- A blocked ticket no longer repeats the agent's question in a red box at the top of the ticket.
  The Blocked pill shows the status and the question is on the Summary tab. Failed runs and
  worktrees that couldn't be created now put their error on the Summary tab too, so every
  reason a ticket is blocked still shows up there.
- Board cards only show the agent (Claude Code, Codex) when a ticket runs on something other
  than the project's default, the same as the ticket's detail view already did.

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
