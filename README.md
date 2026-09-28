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

## iPhone app

`mobile/` is a native iPhone app (Expo SDK 57, React Native, expo-router) with the desktop's
board, ticket tabs (including the live browser and plugin tabs), approvals, Inbox and settings.
It shares its state logic with the desktop through `@harness/shared/state`.

- **Install:** open https://harness-install.vercel.app in Safari on a registered iPhone. The page
  also has the signed Mac build. Releases are cut from `app-YYYYMMDD.HHMM` git tags (see
  CLAUDE.md → Releases and CHANGELOG.md); `bun run release:publish` builds the tagged commit,
  publishes both apps as a GitHub release and redeploys the page.
- **Pair:** on the Mac, set Settings → Network to Tailscale and scan the QR code with the iPhone
  camera (or use Scan QR code / manual entry in the app). The token is stored in the Keychain.
- **Develop:** `cd mobile && bunx expo prebuild --platform ios && (cd ios && ../Tools/pod.sh install)`,
  then `bun scripts/sim-check.ts` builds a Release app for the simulator, runs it against a
  throwaway daemon, taps through approvals, reviews, replies and moves (via [AXe](https://github.com/cameroncooke/AXe)),
  and saves light and dark screenshots to `mobile/build/screens/` (`--themes=catppuccin-mocha,…` adds
  board + settings shots per color theme). Use
  `DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer` when `xcode-select` points
  at the Command Line Tools.

## Drivers

| Driver | Auth | Notes |
| --- | --- | --- |
| `claude-code` | Your Claude team plan, via `claude auth login` (Settings → Drivers → Login) | Wraps the `claude` CLI. Harness tools are exposed over MCP. |
| `anthropic-api` | API key (Settings, or `ANTHROPIC_API_KEY`) | Calls the Messages API directly and runs the tool loop itself. |
| `dummy` | none | Returns scripted responses with no network calls. See DESIGN.md for its `/block`, `/fail`, `/browse` and `/approve` directives. |

**Permissions.** Happy Cog's org policy disables Claude Code's `bypassPermissions` mode, so
agents run in `acceptEdits`. Any tool call that mode doesn't auto-allow (most Bash commands,
for example) moves the ticket to **Blocked** with an approval card. You can allow that one
call, always allow that tool for the ticket, or deny it with a note. The agent resumes once
you answer.

## Workflow

**Planning → In progress → Blocked → Review → Done.**

- Humans own Planning and Blocked, agents own In progress, and Review is shared.
- Leave "Start immediately" on to skip planning.
- A ticket moves to Review when the agent submits it. An independent agent reviewer
  then runs, and you give your own review.
- Once both reviews approve, a final agent step runs on its own and moves the ticket to
  Done. If the ticket was worked in a git worktree, that step merges the branch. Turn off
  **Complete when approved** in project settings to press **Complete** yourself instead.
  You can also mark the ticket done without an agent run.
- **Conductor** tickets break a goal into child tickets with dependencies, start each
  child when its dependencies finish, review and complete the children, and submit
  themselves for review once every child is done.
- **Watchers** are any command that prints text, plus a prompt that says what you want done
  with it. The command runs in your login shell, so a `watch-jira` poller works, and so does a
  loop like `while true; do curl -s …/events; sleep 60; done`. Examples are in
  `service/examples/watchers/`. In interval mode, each run's output becomes an Inbox item. In
  loop mode, each burst of output does. Output identical to something the watcher already
  printed is skipped. Each item starts a triage session in the Inbox. The triage agent reads
  the output and your prompt, then either dispatches it to a ticket in the right project or
  declines it. Mappings (a key prefix like `FOO`, or a `/regex/`, pointing at a project) help
  it pick the project for keys like `FOO-123`. An update about an existing ticket is sent to
  that ticket as a message.

## Plugins

Plugins add tabs to the ticket panel, with optional server routes. The built-in **git** plugin
adds a **Changes** tab that shows everything a ticket changed: its branch against the base branch,
including uncommitted and untracked files. Drop your own plugins in `~/.harness/plugins/`. See
[plugins/README.md](plugins/README.md) for how to write one. `bun run plugins:build` builds the
built-in plugin UIs, and the service also builds them on start when they're missing.

## Tests

```sh
cd shared && bun test     # key helpers, client state (reducer, conductor, models, bridge, markdown), themes (registry, WCAG contrast)
cd service && bun test    # store, orchestrator, drivers, tools, MCP, browser (real Chrome), HTTP/WS e2e, CLI
cd app && bun test        # routes, theme resolution, CSS var coverage
cd mobile && bun run test # pairing links, connection probe, browser touch mapping, servers, prefs/theme pickers, install page
cd plugins/sdk && bun test   # plugin iframe bridge (connect)
cd plugins/git && bun test   # git plugin routes against real temp repos
cd app && bun run smoke   # drives the Electron UI against a mock service
cd app && bun run real    # drives the Electron UI against a real daemon in a temp home
cd app && bun run changes # git plugin Changes tab against a real daemon, light + dark screenshots
cd app && bun scripts/acceptance.ts [dummy|claude-code]   # installed app + launchd service, hello world → Done
```
