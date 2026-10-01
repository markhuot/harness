# Harness

An AI coding harness. A background service runs agent sessions against local project
directories. A desktop app shows them as a live kanban board, with transcripts, summaries
and an agent-driven browser. Every session is a Jira-style ticket (`NYTIMES-3`).

The architecture, ticket lifecycle, tool list and HTTP API are in [DESIGN.md](DESIGN.md).

## Quick start

```sh
bun install
bun service/src/cli.ts service ensure     # install + start the launchd service (127.0.0.1:7717)
cd app && bun run install-app             # build Harness.app into ~/Applications
open ~/Applications/Harness.app
```

The app starts the service itself if it isn't running, so after the first install you only
need to open the app. Quitting the app leaves the service and its agents running.

Service management:

```sh
bun service/src/cli.ts service status|start|stop|restart|uninstall
tail -f ~/.harness/logs/service.log
```

To reach the service from a phone, pick **Settings → Network → Tailscale** in the app (or
`harness listen tailscale`) and scan the **Pair a phone** QR code. See DESIGN.md "Network" for
the modes and what exposing the token means.

Everything the service stores lives under `~/.harness/`: the database, the API token,
logs, worktrees and the Chrome profile. Set `HARNESS_HOME` to use a different location.

## iPhone and iPad app

`mobile/` is a native iOS app for iPhone and iPad (one universal build; Expo SDK 57, React
Native, expo-router) with the desktop's board, ticket tabs (including the live browser and
plugin tabs), approvals, Inbox and settings. It shares its state logic with the desktop through
`@harness/shared/state`.

- **Install:** open https://harness-install.vercel.app on the iPhone or iPad and follow its
  TestFlight link (any device, through Apple's TestFlight app). Each release also carries a
  development-signed build for devices registered to the Apple Developer team (plug it into the
  Mac once with Xcode open, or add its UDID in the developer portal) before the release that
  installs on it is built. The page also has the notarized Mac build. Releases are cut from `app-YYYYMMDD.HHMM` git tags (see
  CLAUDE.md → Releases and CHANGELOG.md); `bun run release:publish` builds the tagged commit,
  publishes both apps as a GitHub release and redeploys the page.
- **Pair:** on the Mac, set Settings → Network to Tailscale and scan the QR code with the iPhone
  or iPad camera (or use Scan QR code / manual entry in the app). The token is stored in the Keychain.
- **Develop:** `cd mobile && bunx expo prebuild --platform ios && (cd ios && ../Tools/pod.sh install)`,
  then `bun scripts/sim-check.ts` builds a Release app for the simulator, runs it against a
  throwaway daemon, taps through opening a card, approvals, reviews, replies and moves (via [AXe](https://github.com/cameroncooke/AXe)),
  and saves light and dark screenshots to `mobile/build/screens/` (`--themes=catppuccin-mocha,…` adds
  board + settings shots per color theme). It runs on the shared `harness-shared` simulator
  (iOS 27.0) and holds its lock for the run, so other agents wait their turn. `--shards=N` splits
  the work across extra "sim-check 2" … "sim-check N" simulators, created on iOS 27.0 the first
  time. `--ipad` saves the same screens from an iPad simulator ("sim-check iPad 1") to
  `mobile/build/screens-ipad/`, without the tap checks. With
  `--no-build` and the simulator booted, a run takes a few minutes, and
  `mobile/build/screens/timings.json` shows where the time went. `ios/` is gitignored and outlives dependency changes, so
  `release:publish` regenerates it on every build, and sim-check does whenever it doesn't link
  every native package in `mobile/package.json` (`bun Tools/nativeDeps.ts check`). A stale `ios/` still builds, but the
  app then crashes on its first use of the missing module. Use
  `DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer` when `xcode-select` points
  at the Command Line Tools.
- **Simulator:** `bun run sim` (`mobile/Tools/sim.ts`) manages the one simulator everyone shares.
  `ensure` creates `harness-shared` (iPhone 18 Pro, pinned to the iOS 27.0 runtime; it never falls
  back to another runtime or downloads one), boots it and prints its UDID.
  `with-lock -- <command>` waits for exclusive use, then runs the command with `SIM_UDID` set.
  `status` shows who holds it, `shutdown` stops it once it's free, and `disk` fails below 5 GiB
  free. Locks live in `~/.harness/tmp/sim-locks`; a lock whose process died is taken over. See
  CLAUDE.md → Simulators for the rules agents follow.

## Drivers

| Driver | Auth | Notes |
| --- | --- | --- |
| `claude-code` | Your Claude team plan, via `claude auth login` (Settings → Drivers → Login) | Wraps the `claude` CLI. Harness tools are exposed over MCP. |
| `anthropic-api` | API key (Settings, or `ANTHROPIC_API_KEY`) | Calls the Messages API directly and runs the tool loop itself. |
| `dummy` | none | Test-only: returns scripted responses with no network calls. The service offers it only when started with `HARNESS_DUMMY_DRIVER=1` (the test scripts set it; installs don't). See DESIGN.md for its `/block`, `/fail`, `/browse` and `/approve` directives. |

**Permissions.** Happy Cog's org policy disables Claude Code's `bypassPermissions` mode, so
agents run in `acceptEdits`. Any tool call that mode doesn't auto-allow (most Bash commands,
for example) moves the ticket to **Blocked** with an approval card. You can allow that one
call, always allow that tool for the ticket, or deny it with a note. The agent resumes once
you answer.

## Workflow

**Planning → In progress → Blocked → Review → Done.**

- Humans own Planning and Blocked, agents own In progress, and Review is shared.
- **New session** (⌘N) opens a draft next to the board. **Start session** (⌘↩) skips planning,
  and **Plan first** (⇧⌘↩) has an agent draft a plan for you to approve. A draft is saved as you
  type and waits in Planning until you start it, and closing it asks whether to keep it.
- New session's **Options** hold the same settings as a ticket's Details tab. To have the agent
  work right in the project folder instead of a worktree, pick the branch the folder already has
  checked out.
- A ticket moves to Review when the agent submits it. An independent agent reviewer
  then runs, and you give your own review.
- Tick **Skip agent review** in New session's Options (or on the ticket's Details tab) for tickets that
  don't need a reviewer agent, like a quick question. The ticket goes to Review and waits
  only on you. The agent can also skip its own review when you ask it to, or when it only
  answered a question, as long as the project requires your review.
- The **Approve** button picks how the work lands: **Approve and merge** (merge the ticket's
  branch into its base branch), **Approve and open PR** (push the branch and open a GitHub pull
  request, which ends the ticket), **Approve and…** (your own instructions for the agent), or
  **Approve and take no action** (done, with no agent run). **When approved** in project
  settings sets the default. Open PR needs the [GitHub CLI](https://cli.github.com) logged into
  the repo's host (`gh auth login`, with `--hostname` for GitHub Enterprise) and push access, and
  only shows up when both are in place.
- Once both reviews approve, a final agent step runs on its own, lands the work the way you
  chose, and moves the ticket to Done. Turn off **Complete when approved** in project settings
  to press **Complete** yourself instead.
- **Conductor** tickets break a goal into child tickets with dependencies, start each
  child when its dependencies finish, review and complete the children, and submit
  themselves for review once every child is done.
  Any ticket can become one: ask a ticket's agent for child tickets and it creates them
  under itself, then reviews and completes them the same way. Children branch from the
  conductor's branch and merge back into it, so the goal lands in one piece when you approve the
  conductor.
- **Watchers** are any command that prints text, plus a prompt that says what you want done
  with it. The command runs in your login shell, so a `watch-jira` poller works, and so does a
  loop like `while true; do curl -s …/events; sleep 60; done`. Examples are in
  `service/examples/watchers/`. In interval mode, each run's output becomes an Inbox item. In
  loop mode, each burst of output does. Output identical to something the watcher already
  printed is skipped. Each item starts a triage session in the Inbox. The triage agent reads
  the output and your prompt, then either dispatches it to a ticket in the right project or
  declines it. Say in the prompt which project the work goes to ("dispatch it to the PLAYR
  project"); triage declines output whose project it can't tell. A ticket made from a Jira issue
  or a pull request carries its ID as a **remote ID**. The board shows that ID with the ticket's
  own key beside it (`MH-62 · MH-124`), and search finds it. Several tickets can share one remote
  ID. Triage can send an update to an existing ticket as a message, or start a new ticket; the
  prompt can say which you want ("send changes to the open ticket for that issue"). You can also
  link or unlink a remote ID in a ticket's settings.

## Keyboard

You can drive the whole Mac app from the keyboard. Press **?** (or **⌘/**) for the full list,
and **⌘K** for the command palette, which finds tickets, commands and every action a ticket
offers. Start the query with `>` for commands only, `#` for tickets only, or `@` for files. **⌘P**
(Open File…) opens the palette on `@`. It searches the focused ticket's folder, or else the board's
project, including git-ignored files, and `path:12` or `path#L12-L20` opens the file at those
lines. The ones you'll use most:

| Keys | What they do |
|---|---|
| h j k l, or the arrows | Move between cards on the board |
| Enter | Open the card beside the board, with the keyboard in its pane |
| ⇧⌘↩ on a card | Open the card in a new pane to the right of the one beside the board, keeping that ticket open |
| ⇧⌘[ / ⇧⌘], or 1–9 | Switch tabs in a ticket pane |
| ⌥⌘ + arrows, or ⌃h ⌃j ⌃k ⌃l | Move to the pane in that direction (left from the board goes to the sidebar) |
| j k, Space, g G | Scroll a ticket's tab (in the sidebar and lists, j and k move between items) |
| i | Write to the agent (Escape takes you back to the pane) |
| / | Search the board |
| ⌘P | Open any file in the project or ticket (the palette's `@` file browser) |
| ⌘W | Close the focused pane |
| ⇧⌘↩ | Maximize or restore the focused pane (on the board, it opens the card instead) |
| ⇧⌘O | Pop the focused ticket or terminal out into its own window (in that window, put it back on the board) |
| ⌘= | Equalize panes: every pane but the board gets an even share beside its siblings |
| Esc | Close a menu or dialog, end a zoom, or close the ticket pane |

Single keys only ever move you around, so a stray keypress can't approve, start or delete
anything. Those actions are in the palette and on their buttons. While you're using the keyboard,
the pane (or sidebar) it's acting on has an accent outline, and clicking hides it again.

## Plugins

Plugins add tabs to ticket panes, with optional server routes. The built-in **git** plugin
adds a **Changes** tab that shows everything a ticket changed: its branch against the base branch,
including uncommitted and untracked files. Drop your own plugins in `~/.harness/plugins/`. See
[plugins/README.md](plugins/README.md) for how to write one. `bun run plugins:build` builds the
built-in plugin UIs, and the service also builds them on start when they're missing.

## Tests

```sh
cd shared && bun test     # key helpers, client state (reducer, conductor, models, bridge, markdown), themes (registry, WCAG contrast)
cd service && bun test    # store, orchestrator, drivers, tools, MCP, browser (real Chrome), HTTP/WS e2e, CLI
cd app && bun test        # routes, theme resolution, CSS var coverage, keyboard registry, board and pane navigation, palette ranking
cd mobile && bun run test # pairing links, connection probe, browser touch → page coordinates, servers, prefs/theme pickers, install page
cd plugins/sdk && bun test   # plugin iframe bridge (connect)
cd plugins/git && bun test   # git plugin routes against real temp repos
cd app && bun run smoke   # drives the Electron UI against a mock service
cd app && bun run real    # drives the Electron UI against a real daemon in a temp home
cd app && bun run changes # git plugin Changes tab against a real daemon, light + dark screenshots
cd app && bun scripts/acceptance.ts [dummy|claude-code]   # installed app + launchd service, hello world → Done
```
