# Harness

An AI coding harness. A background service runs agent sessions against local project
directories. A desktop app shows them as a live kanban board, with transcripts, each ticket's
spec and Activity, and an agent-driven browser. Every session is a Jira-style ticket (`NYTIMES-3`).

The architecture, ticket lifecycle, tool list and HTTP API are in [DESIGN.md](DESIGN.md).

## Quick start

The published Mac app (the install page) needs nothing else: it carries the service as a compiled
executable. To build from the repo:

```sh
bun install
cd app && bun run install-app             # build Harness.app into ~/Applications
open ~/Applications/Harness.app
```

`install-app` builds an app that runs the service from this checkout with bun, so a merge into
it restarts the service onto the new code. `bun run install-app:bundled` installs the
self-contained app the release ships instead (`bun run package` builds it).

Both sign the app with the Developer ID certificate and embed the provisioning profile that grants
push notifications (`app/scripts/sign-mac.ts --local`: no notarization, which a locally built app
doesn't need). The profile stays outside the repo, at
`~/.appstoreconnect/profiles/Harness_Mac_Push.provisionprofile` (or `MAC_PROVISIONING_PROFILE`): a
Developer ID profile for `47P4ZSALX4.com.markhuot.harness` with Push Notifications, issued for the
signing certificate (`MAC_SIGN_IDENTITY`). Signing stops with a reason when it's missing, expired
or doesn't fit.

The app starts the service itself. By default it runs as the app's child process, so quitting
the app stops it and its agents. **Settings → Service → Start at login** makes it a launchd agent
instead: macOS starts the service at login and it keeps running after you quit. The downloaded
app registers the login item it ships in `Harness.app/Contents/Library/LaunchAgents` through
SMAppService (macOS may ask you to allow it in System Settings → Login Items); a build that runs
from this checkout writes `~/Library/LaunchAgents/com.markhuot.harness.plist` instead, the same as
`bun service/src/cli.ts service ensure`. The app follows whichever is set up.

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

`ios/` is a native SwiftUI app for iPhone and iPad (one universal build, iOS 26 and later) with
the desktop's board, ticket tabs (including the live browser and plugin tabs), approvals, Inbox and
settings. It's an XcodeGen project (`ios/project.yml`) plus the `HarnessKit` Swift package, which
holds the protocol types, the HTTP and WebSocket client, and the app's logic and state. HarnessKit
is checked against `shared/` with JSON fixtures that `shared/` generates, so the phone and the
desktop agree on keys, reducers, themes and markdown. See [ios/README.md](ios/README.md) and
[ios/ARCHITECTURE.md](ios/ARCHITECTURE.md).

- **Install:** open https://harness-install.vercel.app on the iPhone or iPad and follow its
  TestFlight link (any device, through Apple's TestFlight app). Each release also carries a
  development-signed build for devices registered to the Apple Developer team (plug it into the
  Mac once with Xcode open, or add its UDID in the developer portal) before the release that
  installs on it is built. The page also has the notarized Mac build. Releases are cut from
  `app-YYYYMMDD.HHMM` git tags (see CLAUDE.md → Releases and CHANGELOG.md); `bun run
  release:publish` (`release/publish-install.sh`) builds the tagged commit, publishes both apps as
  a GitHub release and redeploys the page from `release/Install/`.
- **Pair:** on the Mac, set Settings → Network to Tailscale and scan the QR code with the iPhone
  or iPad camera (or use Scan QR code / manual entry in the app). The token is stored in the Keychain.
- **Build:** `bun ios/Tools/build.ts` builds the app: `sim` (an ad-hoc signed Release build for
  the simulator, into `ios/build/dd`), `device --device <name|udid> [--launch]` (a Debug build
  installed with devicectl), `archive --build-number N`, `export --method dev|testflight` and
  `verify`. Every configuration uses the bundle id `com.markhuot.harness`, so a Debug build
  replaces a TestFlight or release install on the same device. Use
  `DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer` when `xcode-select` points
  at the Command Line Tools.
- **Check on the simulator:** `bun ios/Tools/sim-check.ts` (or `bun run --cwd ios sim-check`)
  builds a Release app for the simulator, runs it against a throwaway daemon, taps through opening
  a card, approvals, reviews, replies and moves (via [AXe](https://github.com/cameroncooke/AXe)),
  and saves light and dark screenshots to `ios/build/screens/` (`--themes=catppuccin-mocha,…` adds
  board + settings shots per color theme). It runs on the shared `harness-shared` simulator
  (iOS 27.0) and holds its lock for the run, so other agents wait their turn. `--shards=N` splits
  the work across extra "sim-check 2" … "sim-check N" simulators, created on iOS 27.0 the first
  time. `--ipad` saves the same screens from an iPad simulator ("sim-check iPad 1") to
  `ios/build/screens-ipad/`, then checks the ticket side panel by real taps instead of the
  iPhone's tap checks. With `--no-build` and the simulator booted,
  a run takes a few minutes, and `ios/build/screens/timings.json` shows where the time went.
  `bun ios/Tools/dev-sim.ts` is the dev loop: it seeds a daemon, installs a fresh build and pairs it.
- **Simulator:** `bun run sim` (`ios/Tools/sim.ts`) manages the one simulator everyone shares.
  `ensure` creates `harness-shared` (iPhone 18 Pro, pinned to the iOS 27.0 runtime; it never falls
  back to another runtime or downloads one), boots it and prints its UDID.
  `with-lock -- <command>` waits for exclusive use, then runs the command with `SIM_UDID` set.
  `status` shows who holds it, `shutdown` stops it once it's free, and `disk` fails below 5 GiB
  free. Locks live in `~/.harness/tmp/sim-locks`; a lock whose process died is taken over. See
  CLAUDE.md → Simulators for the rules agents follow.

## Drivers

| Driver | Auth | Notes |
| --- | --- | --- |
| `claude-code` | Your Claude team plan, via `claude auth login` (Settings → Drivers → Login), or a long-lived token from `claude setup-token` (Settings → Drivers → Claude Code) | Wraps the `claude` CLI. Harness tools are exposed over MCP. When the service starts at login, use the token: launchd can't always read the CLI's Keychain login, and runs then fail with "OAuth session expired". |
| `anthropic-api` | API key (Settings, or `ANTHROPIC_API_KEY`) | Calls the Messages API directly and runs the tool loop itself. |
| `github-copilot` | Your GitHub Copilot subscription, via `copilot login` (Settings → Drivers → Login shows a device code), or a GitHub token (Settings → Drivers → GitHub Copilot): a fine-grained personal access token with the **Copilot Requests** permission, or `gh auth token`. Classic `ghp_` tokens don't work | Wraps the GitHub Copilot CLI (`@github/copilot`, 1.0.91+). Harness tools are exposed over MCP. No mid-run messages: a message sent while it runs is queued for the next run. When the service starts at login, use the token, for the same Keychain reason as Claude Code. |
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
  and **Plan first** (⇧⌘↩) has an agent turn your request into a spec with a plan for you to
  approve. A draft is saved as you type and waits in Planning until you start it, and closing it
  asks whether to keep it.
- Each ticket's **Spec** is a living document (Goal, Plan, Status, Open questions) that its agents
  keep current. It reads like a requirements doc: what the change is, why, and which parts are
  implemented (with their commits). Requests you add later in review or a re-open become Goal
  requirements. The turn-by-turn story stays in Activity and the transcript. Every edit, yours or an agent's, is a revision, and pressing Start marks the one
  you approved (while the plan is still being written the button reads **Approve plan**: the work starts on its own when the plan run ends, and sending a message or cancelling the run withdraws the approval), so the reviewer can see what changed since. **Activity** is the ticket's
  at-a-glance progress, one line per entry: agent notes (at least every 10 minutes on long work),
  each spec revision with its note, submits, questions, review decisions, approvals, and every column change. Messages you send go
  to the agent and the transcript, and the ticket switches to its Transcript once you send one.
- New session's **Options** hold the same settings as a ticket's Details tab. To have the agent
  work right in the project folder instead of a worktree, pick the branch the folder already has
  checked out.
- A ticket moves to Review when the agent submits it. An independent agent reviewer
  then runs, and you give your own review.
- Tick **Skip agent review** in New session's Options (or on the ticket's Details tab) for tickets that
  don't need a reviewer agent, like a quick question. The ticket goes to Review and waits
  only on you. The agent can also skip its own review when you ask it to, or when it only
  answered a question.
- Tick **Skip human review** for tickets you don't need to look at yourself. The ticket lands as
  soon as the agent review approves it, the way the Approve button's default would land it. With
  both switches on, it lands as soon as it's submitted. Agents can turn either one on, or both,
  when you ask them to.
- Settings you ask for in a new ticket's text, such as `/depends: HARNESS-12`, `/branch: main` or
  `/skip-human-review` (plain words work too), are applied to the ticket by the planning agent,
  so they're already set when you read the plan and press Start.
- Both switches start from the project's **Skip agent review** and **Skip human review**
  settings (Project settings → Agents), so one project can skip your review by default while
  another skips the agent's. Changing them affects new tickets only.
- The **Approve** button picks how the work lands: **Approve and merge** (merge the ticket's
  branch into its base branch), **Approve and open PR** (push the branch and open a GitHub pull
  request, which ends the ticket), **Approve and…** (your own instructions for the agent), or
  **Approve and take no action** (done, with no agent run). **When approved** in project
  settings sets the default. When the ticket has nothing to land (no commits or uncommitted
  changes in its worktree, or no worktree of its own), merge and open PR are left out and
  **Approve and clean up** comes first. Open PR needs the [GitHub CLI](https://cli.github.com) logged into
  the repo's host (`gh auth login`, with `--hostname` for GitHub Enterprise) and push access, and
  only shows up when both are in place.
- Once both reviews approve, a final agent step runs on its own, lands the work the way you
  chose, and moves the ticket to Done. **Approve and take no action** is the way to approve
  without landing anything. To hold the work back for now, leave the ticket in Review until
  you're ready to approve it. If that final step is cancelled or cut off by a restart, the
  ticket goes back to waiting on your approval, and approving again lands it.
- **Conductor** tickets break a goal into child tickets with dependencies, start each
  child when its dependencies finish, review and complete the children, and submit
  themselves for review once every child is done.
  Any ticket can become one: ask a ticket's agent for child tickets and it creates them
  under itself, then reviews and completes them the same way. Children branch from the
  conductor's branch and merge back into it, so the goal lands in one piece when you approve the
  conductor. A child's Approve button stays off while its conductor runs, because the conductor
  approves and lands it.
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
serves the **Changes** tab, which shows everything a ticket changed: its branch against the base
branch, including uncommitted and untracked files. The Mac and iPhone/iPad apps draw Changes
themselves, as one of a ticket's own tabs. Drop your own plugins in `~/.harness/plugins/`. See
[plugins/README.md](plugins/README.md) for how to write one. `bun run plugins:build` builds the
built-in plugin UIs, and the service also builds them on start when they're missing.

## Tests

```sh
cd shared && bun test     # key helpers, client state (reducer, conductor, models, bridge, markdown), themes (registry, WCAG contrast)
cd service && bun run test # store, orchestrator, drivers, tools, MCP, browser (real Chrome), HTTP/WS e2e, CLI; files in parallel
cd app && bun test        # routes, theme resolution, CSS var coverage, keyboard registry, board and pane navigation, palette ranking
cd ios/HarnessKit && swift test   # the iPhone app's protocol, client, logic and state, against the JSON fixtures
cd ios && bun run test    # iOS build, simulator and highlighter tooling
cd release && bun run test # release prepare, publish checks, TestFlight, install page
cd plugins/sdk && bun test   # plugin iframe bridge (connect)
cd plugins/git && bun test   # git plugin routes against real temp repos
cd app && bun run smoke   # drives the Electron UI against a mock service
cd app && bun run build && bun scripts/approve-plan.ts   # Approve plan against a real daemon, with screenshots
cd app && bun run real    # drives the Electron UI against a real daemon in a temp home
cd app && bun run changes # the Changes tab against a real daemon, light + dark screenshots
cd app && bun scripts/acceptance.ts [dummy|claude-code]   # installed app + launchd service, hello world → Done
```

`bun run test` in `service` runs each test file in its own `bun test` process, several at once
(`shared/src/testing/parallel.ts`), slowest first by the last run's times. Set
`HARNESS_TEST_JOBS` to change how many run at once. A path or name filter
(`bun run test src/api`) runs plain `bun test` instead, and so does `bun test` itself.
