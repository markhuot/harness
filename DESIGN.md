# Harness — design

An AI coding harness: a background **service** runs agent sessions against local project
directories; a desktop **app** and an iPhone and iPad app show a live kanban board, transcripts,
each ticket's spec and Activity, and an agent-driven browser. Every session is a Jira-style ticket (`NYTIMES-3`).

```
┌──────────────┐  REST + WS (127.0.0.1:7717, bearer token)  ┌─────────────────────────────┐
│ Electron app │ ─────────────────────────────────────────▶ │ harness service (bun binary) │
│ (React UI)   │ ◀──── events: tickets, transcript, frames ─ │  SQLite · orchestrator · runs │
└──────────────┘                                            │  drivers · tools · MCP · CDP  │
   iOS app ── Tailscale / LAN (settings.listen) ────────────▶ │  headless Chrome (numbered    │
                                                             │  tabs per session, screencast)│
                                                             └─────────────────────────────┘
```

Runs live in the service, never in the app. By default the service is the app's child process, so
closing the app stops it; with Settings → Service → Start at login, launchd runs it instead and it
outlives the app (see "Service supervision").

## Layout and ownership

| Path | What | 
| --- | --- |
| `shared/src/protocol.ts` | Entities, events, WS messages, request bodies — **the wire contract** |
| `shared/src/client.ts` | Typed REST/WS client (routes below are defined by it) |
| `shared/src/state/*` | Client state for the desktop (`@harness/shared/state`), which the iOS app ports to Swift and checks against generated fixtures: reducer + selectors, conductor, model, project-key, tab, markdown and label helpers, icon paths, the plugin host bridge. No React, DOM or native APIs |
| `service/src/config.ts` | Paths (`HARNESS_HOME`, default `~/.harness`), port (`HARNESS_PORT`, default 7717), token |
| `service/src/db.ts`, `service/src/store/*` | SQLite schema + repositories |
| `service/src/events.ts` | In-process event bus (`HarnessEvent`) |
| `service/src/orchestrator/*` | State machine, run queue, scheduler, conductor, triage, watchers, prompts, worktrees |
| `service/src/drivers/*` | `Driver` implementations: `dummy`, `claude-code`, `anthropic-api`, `github-copilot` |
| `service/src/tools/*` | Tool definitions + `toolsForRun()` |
| `service/src/browser/*` | CDP client + `BrowserService` implementation |
| `service/src/api/*` | HTTP routes, WebSocket, MCP endpoint |
| `service/src/daemon.ts` | Service entrypoint |
| `service/src/cli.ts` | `harness service install|start|stop|status|ensure|uninstall`, `harness new ...`, `harness network|listen|pair|token rotate` |
| `app/` | Electron main + React renderer |
| `service/src/plugins/host.ts` | Plugin discovery, loading, `/plugins/<id>/api` + `/ui` serving, tab `when` evaluation |
| `ios/` | iPhone and iPad app (SwiftUI, XcodeGen `project.yml`): the `Harness` app target (views, navigation, platform glue) and the `HarnessKit` Swift package (protocol types, client, logic and state, `swift test`); build and simulator tooling in `ios/Tools/` |
| `release/` | Release tooling: `release.ts` (prepare), `publish-install.sh` (build, GitHub release, TestFlight via `testflight.ts`), `install-page.ts` and the Vercel install site in `release/Install/` |
| `plugins/sdk/` | Plugin API: `server.ts` (types, `definePlugin`) and `harness-plugin.ts` (iframe bridge, `connect()`) |
| `plugins/git/` | Built-in git plugin: the routes behind the ticket **Changes** tab (which the apps draw), and a web page of it for other hosts |

## Project keys

A project key (`HEL`) prefixes its native ticket keys (`HEL-4`). Keys match
`^[A-Z][A-Z0-9]{0,15}$` after upper-casing, and `TRIAGE` is reserved for triage sessions. An
explicit key on `POST /projects` must be free (409 otherwise); a key derived from the folder
name de-duplicates to `KEY2`, `KEY3`, ...

`PATCH /projects/:id { key }` renames the project's **native** tickets `OLD-n` → `NEW-n` in one
transaction, keeping the numbers: ticket keys, their session keys, and every `dependsOn` that
points at them (in any project). `nextSeq` continues. Tickets linked to a remote ID are native
tickets and rename too. Only a **legacy mirror** keeps its key: a ticket whose key is its remote
ID (`key = externalRef.key`, e.g. `FOO-123`), from before remote IDs had their own field (see
"Remote IDs"). The rename is refused with 409 when
another project uses the key or any `NEW-n` already exists as a ticket or session key, and
nothing changes. Clients get `project.upserted`, `ticket.upserted` (renamed tickets and
dependency holders) and `session.upserted` events, and each renamed ticket's transcript gets a
`Renamed OLD-n → NEW-n` status line. Existing branches (`harness/old-n`) and worktree
directories (`worktrees/OLD-n`) keep their names: they're stored on the ticket, so work in
progress isn't disturbed. Transcript, spec and Activity text isn't rewritten.

Old keys keep working. Each rename records `OLD-n → ticket id` in `ticket_key_aliases`
(migration 5), so bookmarks (`#/…/ticket/OLD-2`), agents calling `get_ticket`, conductors calling
`start_ticket` / `message_ticket` / `review_ticket` / `complete_ticket` with a key they
learned earlier, `dependsOn` inputs, triage dispatch and the CLI all still find the ticket.
Aliases point at the ticket rather than at a key, so chained renames (`A → B → C`) resolve
`A-n` and `B-n` alike. Resolution lives in one place, `TicketRepo.lookup` / `getByKey`: the
current key first, then an alias, so a real ticket holding a key always wins. Rules:

- `GET /tickets/:key` with an old key returns the ticket (current key in `ticket.key`) and
  sets `resolvedFrom` to the key that was asked for; clients should switch to `ticket.key`.
- `dependsOn` given an old key stores the current key.
- Aliases never make a key taken: new tickets, explicit keys and renames can use an aliased
  key. When a ticket is created with (or renamed into) a key an alias holds, the alias is
  deleted, and the key belongs to the new ticket from then on (deleting that ticket later
  doesn't hand the key back). Renaming a project back to an earlier key makes those keys real
  again and drops their aliases.
- Deleting a ticket (or its project) deletes its aliases.

## Project groups

A project group is a name several projects share, such as "Work" or "Personal"
(`Project.group`, column `projects.group_name`, migration 31; null means no group). A project is
in at most one group, and a group exists for as long as some project carries it: there's no group
table, and `projectGroups(projects)` (`shared/src/projectGroups.ts`) lists them alphabetically
without case. `POST`/`PATCH /projects` take `group`: trimmed, inner whitespace collapsed, at most
60 characters (`normalizeProjectGroup`; longer or not a string is a 400), `null` or `""` clears
it. A name that matches another project's group without case takes that group's spelling
(`canonicalGroup`), so "work" joins "Work" instead of starting a second group. The project being
changed doesn't count, so the only project in a group can re-spell it. The project tools take
`group` too.

Each group has a board, like All projects but with only its projects' tickets. Its scope is
`groupScope(name)` = `"group:<name>"` beside project ids and `ALL_SCOPE` (project ids never
contain a colon). `scopeOf`, the board selectors (`boardColumns`, `doneColumn`, `searchColumns`,
…) and Done paging all take it, and `inScope` matches a ticket by its project's group.
`/tickets/page` and `/tickets/search` take `group=` to narrow to the projects in a group
(`scopeQuery(scope)` gives a client the filter to send). Because joining or leaving a group
changes what a group's board counts, a `project.upserted` that changes a project's group drops
the paging of both groups, and the board pages them afresh.

The iPhone and iPad app ports all of it to Swift (`Paging.groupScope`, `ProjectGroups` in
HarnessKit, checked against the `projectGroups` and `statePaging` fixtures). Its Projects sheet and
iPad sidebar list the groups under All projects. The board filter pref (`boardProject`) stores a
group's board as its scope, so values saved before groups still read as project ids. Project
settings has a Group picker on the same `groupRows`, where Return sets the typed name.

## Remote IDs

A ticket can be linked to a remote item, such as a Jira issue or a pull request. The link is
`Ticket.externalRef { source, key, url, raw }`, and its `key` is the **remote ID** (`MH-62`).
Lookups use the ticket's `key` (`MH-124`) and nothing else. It is the ticket's only identity:
routes, branches, worktrees, sessions, `dependsOn` and every tool resolve it the same way (the
current key, then an alias). The remote ID is what people call the work, so clients show it in
place of the key.

- **Display.** `displayKey(t)` is the remote ID when the ticket has one, else the key.
  - `secondaryKey(t)` is the key when it differs from the display key, and null otherwise.
  - `keyLabel(t)` joins the two: `MH-62 · MH-124`.
  - Wherever a key is shown, the local key follows the remote ID in muted text. That keeps
    tickets apart when several share one remote ID, or when a local ticket's key equals another
    ticket's remote ID.
  - Copying a key, drag data, routes and branch hints use the local key.
  - Prompts label a linked ticket `MH-62 (local MH-124) "title"` (`ticketLabel`).
- **Not unique.** Any number of tickets can carry one remote ID. For example, a pull request
  reviewed in three rounds can become three tickets. Migration 20 stores the remote ID in
  `tickets.external_key` (upper-cased, with a non-unique index), and `TicketRepo.create` and
  `setExternalRef` keep it in sync with `external_ref`.
- **Keys.** Tickets that triage creates take the project's next native key, like any other
  ticket. `CreateTicketBody.key` still exists, for imports and tests.
- **Related tickets.** `TicketDetail.relatedTickets` (`RelatedTicket { key, title, status,
  projectId, externalKey }`, newest first) lists the other tickets whose remote ID equals the
  requested key or the ticket's own remote ID.
  - When no local key matches but tickets carry the requested key as their remote ID,
    `GET /tickets/:key` returns 404 with `data: RemoteKeyMatches { requested, relatedTickets }`.
    The error surfaces as `HarnessApiError.data`. Clients show a "Remote ID MH-62" pane that links
    to those tickets.
  - `get_ticket` returns `{ ticket: null, requested, relatedTickets }` in that case, as a result
    rather than an error. A local match also carries `relatedTickets` (`[]` when there are none),
    along with `externalKey` / `externalUrl`.
  - Drafts appear in the HTTP list, not in the agent list.
- **Search.** `search_tickets` and `GET /tickets/search` rank matches in this order: exact local
  key or alias, local prefix, exact remote ID, remote prefix, title, then text. Searching `MH-62`
  finds the native MH-62 and every ticket linked to it. Hits carry `externalKey`. The clients'
  instant filter (`matchesQuery`) matches remote IDs too.
- **Linking by hand.** `PATCH /tickets/:key { externalRef: { key, url? } | null }`.
  - The key must look like `FOO-123` (upper-cased) and the URL must be http(s); anything else is
    a 400.
  - A new remote ID gets `source: "manual"` and `raw: null`. Re-sending the ticket's current
    remote ID keeps its watcher `source`/`raw` and changes only the URL.
  - `null` unlinks.
  - The ticket's transcript gets a "Linked to MH-62" or "Unlinked from MH-62" status line.
  - Ticket settings on the Mac and iPhone/iPad have a **Remote ID** field.
  - Agents link tickets with `create_ticket` / `update_ticket` `remote_id` and `remote_url`, the
    same PATCH underneath. The work and conductor prompts ("Changing other tickets") tell them to
    set it whenever a ticket is for an external item with a key.
- **Referring to a ticket.** The prompts ("Board") tell agents to name a linked ticket as a
  Markdown link labeled with the remote ID that points at the local key, `[MH-62](MH-124)`. The
  shared Markdown parser reads a link whose target is a ticket key as a ticket token with that
  label, so the apps open MH-124 from it and show MH-62.

## Runtime paths

- `$HARNESS_HOME` (default `~/.harness`): `harness.db`, `token` (random, 0600), `logs/`,
  `worktrees/<KEY>/`, `chrome-profile/`, `service.json` (`{ port, pid, startedAt }`),
  `attachments/<id>.<ext>` (ticket attachments, see "Spec revisions and attachments"),
  `uploads/<uuid>/<name>` (pasted and uploaded prompt attachments, see "Prompt attachments"), `tmp/<sessionId>/`
  (a run's scratch folder for `browser_screenshot` `save_to`, removed with its ticket).
- Tests always set `HARNESS_HOME` to a temp dir and use port 0 / an ephemeral port.
- launchd label `com.markhuot.harness`, `KeepAlive` true, logs to `$HARNESS_HOME/logs/service.log`.
  A checkout's plist is `~/Library/LaunchAgents/com.markhuot.harness.plist` (`service install`),
  running the daemon command (below). A packaged app's is bundled instead (see "Service
  supervision").
- The service runs from one of two places (`service/src/runtime.ts`):
  - **A checkout**: `bun <repo>/service/src/daemon.ts`, builtin plugins from `<repo>/plugins`.
    Dev builds of the app (`bun run build`, `bun run install-app`) record the checkout and bun in
    `app/resources/harness.json` (`{ repoRoot, bunPath }`).
  - **The compiled executable** in a packaged app: `service/scripts/compile.ts` runs
    `bun build --compile` on `service/src/bin.ts` into `Harness.app/Contents/MacOS/harness-service`
    (`harness-service daemon` is the daemon, any other arguments the CLI) and prebuilds each builtin
    plugin into `Contents/Resources/plugins/<id>` (its server bundled with its dependencies as
    `server.js`, its UI built, no `build` step left in `plugin.json`). `harness.json` is then
    `{ executable: "harness-service" }`, resolved next to the app's own executable. Nothing on the
    Mac needs bun or the source.

## Service supervision

Something has to start the daemon and start it again when it exits (a restart onto new code,
`POST /service/restart`, a crash). That's the app by default, or launchd once it's a login item.
The app decides at connect (`app/src/main/service.ts` `ServiceManager`) from
`service status --json`: with the plist installed it runs `service ensure --json` as before;
otherwise it starts the daemon as its child (`app/src/main/child.ts`), unless a service someone
started by hand already answers on the port (`mode: "external"`, used as is). The connection
carries the mode (`app`, `login`, `external`).

- **App (default).** The child gets `HARNESS_SUPERVISOR_PID=<app pid>` and its output appended to
  `service.log`. The app starts it again 1s after it exits and gives up after five exits within
  10s of starting (the error screen then shows the log tail). Restart now restarts the child in
  place. On quit the app asks first when agents are running (`GET /sessions`, any `busy`), then
  SIGTERMs the child and waits for it to exit (SIGKILL after 30s). If the app dies without doing
  that, the daemon notices within 2s that the supervisor pid is gone (`kill(pid, 0)`; Bun caches
  `process.ppid`) and shuts down, so no service outlives the app unsupervised.
- **Login (Settings → Service → Start at login).** Install stops the child and runs
  `service ensure` (writes the plist, bootstraps it, waits for /health). If launchd refuses, the
  app removes the plist and starts its child again, and reports the error. Remove runs
  `service uninstall` (`launchctl bootout`, which waits for the job to exit), waits until the port
  stops answering, then starts the child. Either switch restarts the service, so the section
  confirms first when agents are running.
- **Login in a packaged app (SMAppService).** A downloaded Harness.app is quarantined down to
  `Contents/MacOS/harness-service`. launchd running that file from a plist of its own makes
  Gatekeeper assess it apart from the app the user approved, and it waits at a prompt nobody
  sees, before its first instruction, with nothing logged. So the packaged app ships its login
  item in the bundle, `Contents/Library/LaunchAgents/com.markhuot.harness.plist`
  (`buildBundledPlist`: `BundleProgram`, `AssociatedBundleIdentifiers`), and registers it with
  `app.setLoginItemSettings({ type: "agentService" })`, which launchd attributes to the app. The
  plist is the same for every user, so it holds no paths: it sets `HARNESS_LAUNCHD=bundle`, and the
  daemon then puts the usual tool directories on PATH, runs from `$HARNESS_HOME` and appends its
  output to `service.log` itself (`service/src/bundled-launchd.ts`). Connect follows SMAppService's
  status: `enabled` is the login item; `requires-approval` (the user turned it off in Login Items)
  runs the child. Install registers it, and when macOS wants the user's approval it opens System
  Settings → Login Items and waits up to 2 minutes; not approved, or no /health, it unregisters and
  starts the child again. Remove unregisters, which boots the job out. A plist in
  `~/Library/LaunchAgents` from an older Harness.app is moved over at connect (`service
  uninstall`, then register). The compiled CLI never writes that plist for the label: `service
  install`, `ensure` and `start` refuse (`appManaged`), and `restart` only kickstarts the job.
- The daemon counts as supervised when its parent is the supervisor: launchd (pid 1, with
  `XPC_SERVICE_NAME` set to the label) or the app (`HARNESS_SUPERVISOR_PID` is its ppid). Agents
  inherit both variables but not the parent. Only a supervised daemon restarts itself.
- **launchd only serves demands for certain.** RunAtLoad and a KeepAlive respawn aren't demands.
  When the gui domain is in on-demand-only mode, launchd holds them (`pending spawn, domain in
  on-demand-only mode` in the system log), and nothing but a reboot or a completed logout clears
  that mode. A logout that gets cancelled leaves the domain in it, an interrupted update restart for
  example. A held job never starts, so every path that needs the service running asks for a
  demand. Under launchd the daemon's own restart (new code, `POST /service/restart`) runs
  `launchctl kickstart -k` on its label instead of exiting for KeepAlive (`service/src/supervisor.ts`).
  launchd SIGTERMs it, which runs the normal shutdown, and starts it again. If launchctl fails, it
  exits for KeepAlive as before. The CLI kickstarts after every `bootstrap`, and the app runs
  `service start` (a kickstart) when an enabled bundled login item doesn't answer /health. Connect
  and Retry then bring the service up, and so does Start at login. A kickstart does nothing to a job
  that's already running.

## Ticket lifecycle

Columns: **planning → in_progress → blocked → review → done**.
Humans own planning and blocked, agents own in_progress, review is shared.

**Messages.** A human message never moves the ticket (`POST /messages {text}`,
`Orchestrator.sendMessage`). It goes to the agent and the transcript, never to Activity
(an older app's `log` field is ignored), and the apps switch to the Transcript once it's sent
(`tabAfterSend`). The human moves a ticket with buttons instead: Start (planning), Request changes
(review) and Re-open (done). Older apps had a composer switch that sent `move: true`, which still
sends a review ticket back to in progress or re-opens a done one before the run starts; today's
apps never send it. The ticket's own agent gets
the message where the ticket is, with its work tools, and moves the ticket itself: `unblock` once
the message resolves its block, `resume_work` before it changes work that's in review (its call:
an answer or an investigation leaves the ticket in review), then `submit_for_review` or `block`. A planning ticket's message
goes to its plan run, so a planning agent is always in Claude Code's plan mode (`--permission-mode
plan`; the `mcp__harness` allow rule keeps `update_spec`, `edit_spec`, `update_ticket` and `post_note` running there).

| Trigger | Effect |
| --- | --- |
| Create (any) | the ticket with spec revision 1 (author `system`, note "Created"; see "Spec revisions and attachments") |
| Create with `start: true` | status `in_progress`; enqueue **work** run, prompt = the spec |
| Create with `start: false` | status `planning`; enqueue **plan** run (the agent writes the spec's Plan with `update_spec`) |
| Create with `draft: true` | status `planning`, `draft` set, no run (see "Drafts") |
| `POST /submit {start}` on a draft | `draft` cleared, then exactly what a create with that `start` does |
| Human message in planning | a plan run that's going takes it in (see "Steering"); otherwise enqueue plan run with the message |
| `POST /start` from planning with a dependency not done | queued, not started: `autoStart` on, status "Waiting on A, B", the ticket stays in planning until the scheduler starts it (a second `/start` changes nothing). A move to in_progress still starts it now |
| `POST /start` (or a move to in_progress) | from planning, the current spec revision becomes the **approved baseline** (`specBaselineRevision`, status "Spec revision N approved as the baseline"); status `in_progress`; prepare workdir (a worktree when `ticket.useWorktree ?? project.useWorktrees` and the path is a git repo, else the project path); enqueue work run (`run.work_start`): "The spec is approved." + the spec |
| Human message in in_progress | a work/conductor run that's going takes it in (see "Steering"); otherwise enqueue work run with the message |
| Agent calls `block(question)` (in_progress, blocked or review) | status `blocked`, `blockedReason` set, a `blocked` Activity entry (`meta.question`). From blocked it replaces the question; from review both reviews reset to pending (queued agent reviews are dropped). Refused in planning and done |
| Human message while blocked | status and `blockedReason` unchanged; a **chat** run that's going takes it in (see "Steering"), otherwise enqueue one with the message. The agent's prompt (not the transcript) ends with a harness note naming the question and saying to call `unblock` when the message resolves it, else to answer and leave the ticket blocked. A blocked ticket without a workdir (or whose worktree is gone) gets one first, its status unchanged |
| Agent calls `unblock(note?)` | blocked → `in_progress`, `blockedReason` cleared, status "Unblocked by the agent", an `unblocked` entry (`meta.note`); the run carries on. Refused unless blocked, and while a tool approval is pending |
| Agent calls `resume_work(note?)` | review → `in_progress`, both reviews pending, a queued or running agent review cancelled, status "Moved back to in progress by the agent"; the run carries on and ends like a work run. From done (a chat that's working on the ticket again, not just answering): re-opened as Re-open does, both reviews pending, the worktree recreated when the complete run removed it (`workdirFor`, the session's cwd moved to it), a `reopened` entry by the agent; the result names the new workdir when it differs from the run's cwd, since the running chat started in the old directory (often the project checkout). Refused in other columns, and while a tool approval is pending |
| Human message in review or done | status and reviews unchanged; a **chat** run that's going takes it in, otherwise enqueue one. The message and the chat's answer are in the transcript only |
| Human message with `move: true` in review (older apps only) | status `in_progress`, both reviews reset to pending, enqueue work run with the message |
| Chat run | the ticket's own agent (it resumes the session's conversation) with its work tools (a conductor ticket's: the conductor tools), permission mode, grants and prompt sections (Branches, Changing other tickets, Tool approvals), under the "Message run instructions" (`system.chat`). A gated call opens an approval card without moving the ticket (the apps show the card in any column), and answering it resumes a chat. The run ends like a work run once the agent moved the ticket (a submit gets its review; a ticket it unblocked auto-submits, or blocks on a trailing question); one that left the ticket where it is neither auto-submits nor blocks (its last text is its answer, in the transcript). A failed chat adds a `failed` entry and moves nothing, unless it had unblocked the ticket (then it blocks, like a failed work run). 409 while the ticket is completing |
| Agent calls `submit_for_review(note, spec_is_up_to_date: true)` (in_progress, blocked or review; refused in planning and done, and without `spec_is_up_to_date: true`) | status `review`, `blockedReason` cleared, `agentReview=pending` (`skipped` when the ticket has `skipAgentReview`), `humanReview=pending` (or `approved` when the ticket has `skipHumanReview`, see "Skipping the human review"), a `submitted` entry with the note (`meta.specRevision`); after the run ends enqueue **review** run, unless the agent review was skipped (see "Skipping the agent review") |
| Work run (or a chat that unblocked the ticket) ends and ticket still in_progress | auto-submit for review; the `submitted` note = the first line of the last assistant text (system author, `activityLine`). A trailing question blocks with it instead (a `blocked` entry) |
| Work run fails | a `failed` entry; status `blocked`, `blockedReason` = error. A usage limit that names its reset time also sets `resumeAt`, and the ticket restarts on its own (see "Usage limits"). A ticket already `done` stays done (only the `failed` entry): a run queued before it completed can only fail on the removed worktree |
| Review run fails | a `failed` entry ("Agent review failed: <error>. Re-run agent review to try again."); the ticket stays in review with the agent review `pending`, so the board says why nothing is running |
| A run starts on a ticket whose worktree is gone (`workdir` missing: the complete run removed it, or an agent or a human did) | every run but a plan run starts in the project checkout instead of failing, with a status line "Worktree missing: running from <path>". The harness repairs nothing: the prompt ends with a harness note (`missingWorktreeNote`) naming the missing path, whether the branch still exists and whether its tip (or, with the branch gone, the last commit an agent review round recorded) is already in the base branch, and on a review that commit. Work, chat and review runs are told to recreate the worktree at the same path (`git worktree add <path> <branch>`, or `-b <branch> <path> <commit or base>`) before changing or testing anything and to leave the checkout alone; a reviewer may review landed work straight from git instead. A complete run is told it doesn't need the worktree back. A chat about a done ticket gets no note (its worktree was removed on purpose). claude-code resumes a conversation only from the directory it started in, so such a run may start a fresh one |
| Work/complete/conductor run ends after a classifier denial | the agent submitted (it found another way): reviewed as usual, with a one-line system `permission` entry whose `meta.detail` (and a transcript status line) lists the denied calls. Otherwise status `blocked` with a classifier `pendingApproval` (see "Permissions") |
| Agent `review_decision(approve)` | `agentReview=approved`; a `review_approved` entry with `meta { by, round, commit }` (see "Agent review") |
| Agent / human `request_changes` | a `changes_requested` entry (the agent's with `meta { by, round, commit }`); status `in_progress`, both reviews reset to pending, enqueue work run with the notes (`run.changes_requested`) |
| Human `POST /review {approve, action?, instructions?}` | the choice (`completionAction`, `completionInstructions`) is stored on the ticket first, 400 for an action the ticket doesn't offer (see "Completion"); `humanReview=approved`, an `approved` entry (`meta.by`) |
| Both approved (an agent review counts as approved when it was `skipped`, `reviewPassed`) | not a conductor-managed child (`managingConductor`: its parent isn't done): enqueue the **complete** run right away with the action chosen at approval, else the project default (status "Both reviews approved: completing automatically"). A managed child is **ready** instead (still in review, status "Ready to complete") until its conductor's `complete_ticket`. There's no per-project switch and no Complete button: the approval option decides what happens, and "Approve and take no action" is the way to approve without landing anything (the project setting `autoComplete` was dropped in migration 21). Nothing else starts a completion for an approved ticket, so a ticket is never left approved with nothing landing it: see the next two rows |
| Complete run cancelled (`POST /cancel`, queued or running), interrupted (a restart, `recoverStaleRuns` / `reconcileRuns`) or failed (a spend limit, a driver error) on a ticket still in review | the ticket stays in review with its agent review approved, never through blocked → in progress (whose resubmit would reset both reviews). `humanReview` back to `pending`, status "Completion cancelled: approve again to land it" (or "interrupted", or "failed (<error>)", which also adds a `failed` entry "Completion failed: <error>"); the stored choice stays preselected on Approve, and approving again queues a complete run that resumes the session's conversation. A conductor-managed child whose completion failed or was interrupted keeps its approval instead (it's ready) and its conductor is notified (a review → review change whose note says to call `complete_ticket` again); a cancelled one hands the approval back like any other. A complete run that fails on a ticket outside review blocks it, like a failed work run. Migration 21 does the same for tickets that were left ready before it (top-level, or under a done conductor) |
| Conductor → done with children in review it approved but didn't complete | each child's `humanReview` back to `pending` ("<conductor> is done: approve to land this ticket"): the human has the child back (`managingConductor` is null) and approving lands it |
| `POST /complete {action?, instructions?}` | 409 while a complete run is already queued or running; otherwise enqueue **complete** run with the completion action's prompts (the request's action, else the one chosen at approval, else the project default; see "Completion"); on success → `done`, except a `pr` completion that recorded no pull request → `blocked`. `skipAgent` ("Approve and take no action") → `done` immediately with no run; on a ticket in review it also sets `humanReview=approved` (status "Approved, no action taken"). While the complete run is queued or running, messages and `request_changes` get a 409: the work run they queue would start after the merge, in the removed worktree |
| Move to done | `done` without an agent run |
| `POST /reopen {notes}` on a done ticket | 409 unless `done`, 400 without notes; a `reopened` entry with the notes; status `in_progress`, both reviews reset to pending, enqueue work run: "re-opened" + notes. A human message with `move: true` to a done ticket (older apps only), a triage update to it, or a move back to in_progress re-opens it the same way (with the message / the spec). If the ticket's worktree is gone (removed by the complete run), it is recreated on its branch (`requestedBranch`, else `harness/<key>`) first, from the base branch when the branch was deleted |
| `POST /cancel` | abort active run (run status `cancelled`), ticket status unchanged (a cancelled complete run reopens the human review, above) |
| Ticket → done | scheduler starts dependents that have `autoStart` and all deps done; parent conductor notified |

Review runs start from a **fresh** driver conversation (independent reviewer) and never
write driver state back to the session. All other ticket runs resume the session's state.

### Usage limits

A run can stop on a usage limit ("You've hit your limit · resets 2:30pm (America/New_York)", or
the older "Claude AI usage limit reached|<epoch seconds>"). The ticket blocks like any failed run,
and when the error says when the limit resets (`usageLimitResetAt` in
`service/src/orchestrator/usage-limit.ts`), it also gets `Ticket.resumeAt` (column
`tickets.resume_at`, migration 32): five minutes after the reset, or five minutes from now when the
reset has already passed. A time without a date is its next occurrence in the named zone (the
Mac's zone when none is named). Errors that name no reset time block without a restart.

- **Restart.** When `resumeAt` comes, the scheduler (`Orchestrator.resumeDue`, on a timer
  `armResume` points at the earliest `resumeAt`, and once at start-up for restarts that came due
  while the service was down) moves the ticket to in progress with `run.work_start`, as a human
  moving it there does, and a `moved` entry "Restarted after the usage limit reset". If the limit
  hits again, the ticket blocks again with a new `resumeAt`.
- **Cancelling.** Any move of the ticket (to planning, in progress, done, or a new block) clears
  `resumeAt`. A ticket waiting on a tool approval, or with a run going, when its time comes keeps
  waiting for the human and loses its restart.
- **Where it shows.** The `failed` entry ends "Restarts on its own at 2:35 PM.", and the transcript
  gets a status line. On the board the card shows a clock, like a planning ticket waiting on its
  dependencies (`restartsAt`, `restartTitle` in `shared/src/state/conductor.ts`), and the ticket's
  detail shows a disabled "Restarts at 2:35 PM" button. A complete run that fails on a limit gets
  no restart: completions have their own retry (approve again).

### Agent review

`run.review` gives the reviewer what it needs (`Orchestrator.reviewContext`):

- the spec's current revision number, which the reviewer reads with `read_spec { revision }`. The
  text isn't inlined: revisions never change once written, so the number pins exactly what was
  submitted even if someone edits the spec mid-review, and a long spec doesn't land in the context
  twice (the prompt, then `get_ticket`);
- the unified diff from the approved baseline (`specBaselineRevision`) to the current spec, or a
  note that there is none (the ticket started without planning);
- from round 2 on, the earlier rounds: each decision, its notes and the commit it reviewed. The
  re-review is told to focus on `git diff <lastCommit>..HEAD`, confirm each earlier point was
  addressed, and check the rest only for regressions;
- the Activity since the last round (all of it on round 1), at most the last 30 entries.

A round is an agent `review_approved` or `changes_requested` entry. `review_decision` stores
`meta { by: "agent", round, commit }` on it, `commit` being `git rev-parse HEAD` in the workdir
(null without one), which is how the next round finds the last reviewed commit. The instructions
(`system.review`) judge the work against the Goal and acceptance criteria as approved and treat
Status and notes as claims to verify. Two spec problems are grounds for `request_changes`: Goal or
acceptance-criteria changes since the baseline that the human's messages, review notes or re-open
notes didn't ask for (moved goalposts; `system.spec` has agents write those requests into the Goal), and a Status that doesn't match the work. Notes cover one round, and their first line
must state the outcome on its own ("Approved, with three open questions in the spec."), since that's
all Activity shows. Review runs get `read_spec` and `edit_spec`, to record findings (an open
question for the human, a follow-up) under the spec's Open questions; `update_spec` is refused, and
the Goal, Plan and Status stay the author's. `get_ticket` has the full Activity and each
attachment's path.

### Skipping the agent review

`Ticket.skipAgentReview` (migration 17, default false) is for tickets with nothing for a reviewer
agent to check, like a question answered in text. Submitting such a ticket (the agent's
`submit_for_review` or the auto-submit at the end of a run) sets `agentReview = "skipped"` and
starts no review run, so the ticket waits in Review only on the human, or on its conductor for a
child. `"skipped"` is only ever an agent review state, and `reviewPassed` (shared) treats it like
`approved`: the human's approval makes the ticket ready, and it completes right away. A ticket
that skips its human review too completes as soon as it's submitted. A request
for changes resets the agent review to `pending` as usual; the next submit skips it again.

Who sets it:

- **The project's default**: a create that leaves `skipAgentReview` out takes
  `Project.skipAgentReview` (see "Review defaults").
- **The human**, with `CreateTicketBody.skipAgentReview` (the "Skip agent review" switch in
  New session's Options on Mac and iPhone) or `UpdateTicketBody.skipAgentReview` (the ticket's
  details). A change while the ticket is in review applies at once: turned on with the agent
  review `pending`, the review is `skipped` and queued or running review runs are cancelled
  (a late `review_decision` from one is refused); turned off with it `skipped`, the review goes
  back to `pending` and a review run starts. "Re-run agent review" (`POST /agent-review`) still
  runs one on demand.
- **The ticket's own agent**, with `submit_for_review { skip_agent_review: true }`, when the human
  asked for no agent review or the request was conversational and it changed no files (the work
  prompt says so, and says the ticket already skips it when the flag is set). `false` turns the
  flag back off. The flag is stored before the submit, so later submits skip too.
- **Other agents**, with `create_ticket` / `update_ticket` `skip_agent_review` (see "Board changes by
  agents").

- **The ticket's own planning agent**, with `update_ticket { key: <its own key>, skip_agent_review }`
  when the spec asks for it (see "Board changes by agents").

Agents may turn it on even when the ticket skips its human review too, which leaves the work
landing as soon as it's submitted. The prompts and tool descriptions say to do that only when the
human asked for it; nothing in code checks.

### Skipping the human review

`Ticket.skipHumanReview` (migration 23, default false) is the other half: the ticket lands without
waiting on anyone once its agent review passes. Submitting such a ticket sets `humanReview =
"approved"` (status "Human review: skipped"), so the agent review's approval makes it ready and `noteReady` starts the complete
run with the stored completion choice, else the project default. With `skipAgentReview` as well,
the ticket completes as soon as it's submitted. A conductor's child that skips it lands on its own
too (its conductor is the reviewer it skips) instead of waiting on `complete_ticket`. The human
can still request changes while the ticket is in review, and a request for changes (or a block
from review) resets the human review to `pending`; the next submit approves it again.

A change while the ticket is in review applies at once: turned on with the human review `pending`, it's approved and the ticket completes if
its agent review passed; turned off with it `approved` and no complete run queued or running, it
goes back to `pending` (status "Human review: waiting on a human again"). There's no telling that
approval apart from a human's own, so turning the switch off always asks for an approval.

Who sets it: the project's default (`Project.skipHumanReview`) when a create leaves it out; the human with `CreateTicketBody.skipHumanReview` / `UpdateTicketBody.skipHumanReview`
(the "Skip human review" switch under Agent review in New session's Options and the ticket's
Details, Mac and iPhone); the ticket's own agent with `submit_for_review { skip_human_review }`,
when the human asked for the work to land without their review (the work prompt says so, and
says when the ticket already skips it); other agents with `create_ticket` / `update_ticket`
`skip_human_review`; the ticket's own planning agent with `update_ticket` on itself. Agents can
set both skips, in one call or across two, when the human asks for no review at all; the ticket
then lands as soon as it's submitted.

### Review defaults

`Project.skipAgentReview` and `Project.skipHumanReview` (migration 25, default false) are the
values a new ticket's two switches start from: `createTicket` uses them for a
`CreateTicketBody` that leaves `skipAgentReview` / `skipHumanReview` out (an agent's
`create_ticket` too), and the apps' blank draft (`blankDraftTicket`) starts on them. They're
copied, not inherited: the ticket keeps its own flags from then on, so changing a project's
defaults never touches existing tickets, and the ticket's switch is the only thing `submit` reads.
Humans set them in Project settings (Agents: "Skip agent review", "Skip human review", Mac and
iPhone), or through `create_project` / `update_project` (`skip_agent_review`,
`skip_human_review`, approved by a human like any configuration call). A project may skip both:
its tickets then land as soon as they're submitted unless someone turns a review back on.

In a draft, a switch still on its project's default counts as inherited: `draftIsEmpty` and the
collapsed Options summary compare against the project ("With agent review" when a draft turns a
skipped review back on), and moving the draft to another project (`draftReviewSkipsPatch`) moves
such a switch to the new project's default while a switch the user flipped stays as it is. Since
the service fills in its own copy of the defaults, `draftCreateBody` always sends both switches.

They replace `requireHumanReview` (migration 25 dropped `require_human_review`), which skipped
the human review of every ticket in its project whatever the ticket said. The migration turned
`require_human_review = 0` into `skip_human_review = 1` on the project and on each of its
tickets, so nothing in flight changed. The service still sends `requireHumanReview`
(`!skipHumanReview`) for iPhone builds from before, which require the field, and maps one sent by
them onto `skipHumanReview` (`skipHumanReview` wins when both come); nothing else reads it.

### Drafts

A New session is saved as a **draft** while it's written: a real ticket with `Ticket.draft` set,
in planning, created with `CreateTicketBody.draft` (the spec may still be empty). It takes a key
like any ticket (a discarded draft leaves a gap in the numbers). Because it's an ordinary ticket,
the board, its order, search, keyboard focus and the WebSocket sync need nothing special: the
apps draw its card dashed and dimmed, and opening it shows the draft editor instead of the
ticket's tabs.

While `draft` is set:

- Nothing runs. `enqueueRun`, `begin` and `/start` refuse a draft, and the scheduler, run recovery
  and dependency auto-start skip it. Status moves, messages, reviews and completion get a 409.
- Agents don't see it: the MCP ticket tools and watcher triage leave drafts out, and a draft can't
  be a dependency.
- `UpdateTicketBody` also takes `kind`, `useWorktree` and `projectId` (a 409 on any other
  ticket, since they're fixed once it launches). A `projectId` change moves the draft into that
  project under its next key and keeps the old key as an alias, the same way a project rename
  does, so open panes follow it. A `spec` change needs no `baseRevision`, rewrites revision 1 in
  place (a draft has only the one revision until it launches) and re-derives the title.

`POST /tickets/:key/submit {start}` launches it: the flag is cleared, and the ticket then goes
exactly where a create with that `start` would have sent it (a work run, a plan run, or waiting
on its dependencies), keeping its place in the column. Discarding is `DELETE /tickets/:key`.

The editors save lazily. Nothing is sent until the draft stops being empty (`draftIsEmpty`: no
spec and every setting inherited); then one `POST /tickets`, and after that a debounced PATCH
of the changed fields (`draftPatch`). An open editor never takes the service's copy of the draft:
what the user typed is final, so a late echo of an earlier save (or another device's edit) can't
rewrite the prompt under the caret. Two devices editing one draft is last write wins, and only
the fields each one changed are sent. The store's copy still tells an open editor when the draft
was launched or discarded elsewhere. The draft helpers
(`shared/src/state/drafts.ts`) are the desktop's, and the iOS app's ports are fixture-checked
against them.

**One settings UI.** A ticket's Details tab and a draft's Options render the same component
(`app/src/renderer/components/TicketSettings.tsx` on the desktop, `ios/Harness/Features/Pickers/TicketSettingsForm.swift` on the phone)
with the rows Model, Permissions, Agent review, Human review, Branch, Base branch and Depends on.
`ticketSettingsRows` decides which rows show and which can change, and the two screens differ
only in what their `onPatch` does (an immediate PATCH in Details, the local state and debounced
save in a draft). In a draft the Branch row also decides the worktree: the branch the project
directory has checked out (`checkoutBranch`, matched on `BranchInfo.checkedOutAt`) means no
worktree, any other branch means one (`draftBranchPatch`). Base branch shows only with a worktree.

### Message drafts

The message a human is writing to a ticket's agent is saved on the ticket as `Ticket.messageDraft`
(`{ text, attachments, origin, updatedAt }`, null when there is none), so a reply started on one
device can be finished on another. A ticket has one, because each app has one composer per ticket.
`PUT /tickets/:key/message-draft { text, attachments?, origin? }` replaces it whole; empty text and
no attachments clear it, and a save that changes nothing emits nothing. It's stored in
`tickets.message_draft` without touching `updatedAt`, and every change is a `ticket.upserted`. A
draft ticket (it has no agent yet) answers 409. Its uploads count as referenced, so the startup
sweep keeps them, and they go when the ticket is deleted. Agents never see it: the board tools pick
their own fields.

`POST /tickets/:key/messages` from an app clears the draft once the message is delivered (a failed
send keeps it). An agent's `message_ticket` goes through the same delivery but leaves the human's
draft alone.

The composers (`app/src/renderer/state/messageDraftSession.ts`, HarnessKit's `MessageDraftSync`)
keep one session per ticket for the life of the window or store, save edits as debounced PUTs one
at a time, and tag each with an `origin`, a random id per session. When the store's copy changes,
`adoptMessageDraft` (shared/src/state/messageDrafts.ts) decides whether it replaces what the
composer shows. It never does for the composer's own save coming back, however late, or while the
field has focus (the input is uncontrolled while it's typed in, and the next save wins), or while
the composer has edits it hasn't saved. Otherwise it does: another device's edit, or its send
clearing the draft. Losing focus, including the composer going away while focused, catches up
with the store's copy. A send first stops the debounce and waits for a PUT on its way, and nothing
is saved until it finishes, so a late PUT can't bring back a draft the service just cleared.

**Uncontrolled fields on iOS.** `MentionTextEditor` (New session's prompt and the composer) keeps
its own copy of the text and draws its `TextField` in an Equatable child view. A parent redrawing
(a save's answer, any socket event) used to re-apply the text and selection to the text view, which
cancelled an autocorrection or inline prediction in progress and rewrote the text under the caret.
Now the field redraws only when its own inputs change, and takes `text` back only when it changes
to something the field didn't type (a send clearing it, a picked mention, another device's draft).

### Branches

**Base branch** is what a ticket's work lands on when it completes, and where a new ticket
branch starts. It resolves ticket → parent → project → settings (`resolveBaseBranch` in
`shared/src/branches.ts`; `Ticket.baseBranch`, the parent ticket's `branch`, `Project.baseBranch`,
`Settings.baseBranch`, default `"main"`); null or `""` inherits. The parent step (source
`"parent"`) applies to a child whose parent works in a worktree of its own and isn't done
(`Orchestrator.branchParent`): children branch from the conductor's branch and merge back into it,
so a conductor lands as one branch (see "Conductor"). Every value must pass `git check-ref-format --branch`
rules (`branchNameError`), or the request gets a 400. One fallback keeps older setups working:
when nothing overrides the setting and the repo has no branch of that name (a `master` repo under
the default `main`), the base is the branch checked out in the main checkout, which is what the
harness always used before base branches (`Orchestrator.baseBranchFor`, source `"checkout"`). An
explicit ticket or project base is taken as given.

**Ticket branch.** `Ticket.requestedBranch` is the branch chosen for the ticket
(`CreateTicketBody.branch`, `create_ticket`/`update_ticket` `branch`, `update_branch`); null means
`harness/<key>`. `Ticket.branch` is the branch its worktree has checked out, set once the worktree
exists: branch set ⇔ the ticket works in a git worktree of its own at `workdir`. `begin()` makes the
worktree at `worktrees/<KEY>`: an existing branch is checked out as is, a new one is created from
the base branch (`git worktree add -b <branch> <dir> <base>`). It blocks with "Could not create
worktree: …" naming the branch and path when the branch is already checked out in another
worktree, or naming the base when the base branch doesn't exist. `requestedBranch` can change
(HTTP, `update_ticket`) only while the ticket has no worktree on disk. `plannedBranch(ticket)` is
what clients show: the branch it uses, or will use. A ticket whose branch *is* its base branch
(both set to an existing pull request's head, as triage does for fixes on an open PR) works and
pushes on that branch directly: `system.work` tells it so (`onBase`), and approving it only
offers `cleanup` and `custom` (see "Completion"). `GET /projects/:id/branches?q=&limit=`
(`BranchInfo[]`: name, lastCommitAt, checkedOutAt) feeds the new-session branch picker.

**Re-pointing** is the ticket's own agent's job (`update_branch`, work and conductor runs): a
human tells it "use branch X for this ticket". When X is checked out in another worktree (a herdr
worktree, say), `ticket.workdir` and the session cwd move there; the agent integrates its commits
there first (cherry-pick or merge, with `git -C`), and the result counts commits still missing.
Otherwise the ticket's worktree switches to X (`git switch`, `-c` at HEAD for a new name; git's
refusal on a dirty tree comes back as the tool error). Nothing is deleted: the old harness worktree
and branch stay for the human. claude-code resumes a session only from the directory it started
in, so the driver copies the session transcript under the new workdir's project folder before
`--resume` (`carrySession`); a session it can't find starts fresh as before.

**Completion** is covered in the next section.

### Steering

A human message goes into the run that's going, when that run is the kind the message would
queue (plan for planning; the agent's own runs, work/conductor/chat, steer each other, so a chat
that unblocked its ticket still takes the next message) and its driver has `supportsSteering`
(claude-code, anthropic-api). A message to a blocked ticket carries the unblock note either way. There's no setting: steering is how
messages work, and the queue is only the fallback (HARNESS-68).

- `sendMessage` → `steerOrEnqueue`. The message is written to the transcript as a `user` entry
  of the **active** run right away, @-mentions attached as for a new run, then pushed into the
  run's `RunInput` (`drivers/input.ts`), created with the `ActiveRun` so a message sent while the
  run starts is waiting for the driver.
- The driver takes messages into the live conversation and calls `delivered(id)` once its agent
  has seen each, then closes the input when it stops taking more. A closed input refuses
  `push`, and checking for pending messages and closing happen in one synchronous step, so a
  message is never dropped between them.
- When the run ends, the orchestrator closes the input and queues a run of the same kind for
  each message the agent never saw (`enqueueRun(..., { skipTranscript: true })`, so it's shown
  once), before `afterRun`, like a message queued during the run: the pending work holds off
  auto-submit. A cancelled run drops them with the rest of the session's queue.
- Whenever a message has to wait although a run is going (a driver that can't steer, a
  different run kind, a run that already stopped taking input), the transcript gets the status
  line "Couldn't reach the running agent; queued for the next run".
- Review and complete runs never take messages: a message to a ticket in review gets a chat run
  queued behind the review, and the ticket stays in review.
- The composer shows no hint about where a message goes. On the Mac, (+), the input and Send
  (with ⌘↩ in it) share one row.

claude-code (verified against claude 2.1.284): each message is written to the open stdin as a
stream-json `user` line with its `uuid`. With `--replay-user-messages` the CLI echoes a line
(`isReplay: true`, same `uuid`) when its agent takes it in: mid-turn at the next tool boundary
(the agent changes course in the same turn, one `result`), or, when it arrives as the turn is
ending, as the start of a new turn (`init`, the replay, another `result`). Resume doesn't replay
history. At each `result` the driver keeps stdin open while a written message hasn't been echoed.
A finishing tool or an error still closes it; the unseen message then goes back to the queue. A
failed `--resume` writes the unseen messages again to the fresh attempt. anthropic-api: messages
join the user message carrying the tool results; at `end_turn` a waiting message becomes a new
user turn instead of ending the run. They count as delivered once they're in the conversation
state. `service/scripts/claude-code-steer-check.ts` checks both claude-code cases against the
real CLI.

Runs are serialized per session and limited globally by `settings.maxConcurrentRuns` (default 4).
`ticket.busy` / `session.busy` is true while a run is queued or running. A queued job may also
carry a `lock` (`RunQueue`): jobs sharing one never run at once, whatever their sessions. Merge
completions lock on where they merge (`merge:<parent id>` for a child on its parent's branch,
`merge:<project id>` otherwise), so sibling merges into one worktree don't collide on
`index.lock`.

### Completion

How an approved ticket's work lands is chosen per approval (`CompletionAction`, shared
`completion.ts`). Each action has its own pair of prompts, overridable like every other:

| Action | Prompts | What the complete run does |
| --- | --- | --- |
| `merge` ("Approve and merge") | `system.complete_merge`, `run.complete_merge` | Merges the ticket branch into the base branch by name, from wherever the base is checked out (`git worktree list`): merge there when a worktree has it; when none does, fast-forward it with `git fetch . <branch>:<base>` or merge in a temporary worktree. When the ticket branch is the base branch there is nothing to merge. Only what the harness made is removed: the worktree when it's inside `worktrees/`, the branch when it is `harness/<key>`, deleted from the worktree that has the base checked out (`branch -d` checks against what's checked out where it runs). A harness worktree left behind by `update_branch` is removed only once its commits are merged. |
| `pr` ("Approve and open PR") | `system.complete_pr`, `run.complete_pr` | Commits leftovers, checks `gh auth status --hostname <host>`, pushes the branch (`git push -u <remote> <branch>`, never forced), then updates the open pull request for the branch (a comment on what changed) or opens one with `gh pr create --repo <host>/<owner>/<repo> --base <base>`, ready for review, following the repo's PR template. It calls `record_pull_request { url }`, removes the harness worktree and keeps the branch. It never merges: the pull request is the end of the ticket, and teammates review and merge it on GitHub. |
| `cleanup` ("Approve and clean up") | `system.complete_cleanup`, `run.complete_cleanup` | For work that already landed or never needed git: a ticket on an existing pull request's head branch that pushed there itself, a branch merged by hand, or an empty worktree after a database or config change. It merges, pushes and opens nothing. It stops if the worktree has uncommitted changes or the branch has commits on no remote branch (and, off the base, not in the base branch); otherwise it removes the harness worktree and deletes `harness/<key>` with `branch -D` (the check already proved its commits are safe; `-d` refuses commits that are only on a remote). A branch the harness didn't create is kept. Afterwards the service checks: while the harness worktree or `harness/<key>` is still there, the ticket moves to `blocked` ("Cleanup didn't finish") instead of done, so the human can deal with the commits. |
| `custom` ("Approve and…") | `system.complete_custom`, `run.complete_custom` | Commits leftovers, then does what the approver's instructions say, merging, pushing or deleting nothing they don't ask for. With no instructions (the plain "Approve" of a folder outside git) it's a light wrap-up. |

**What a project offers** (`Project.completionActions`, worked out on every read like `isGit`):
`custom` only outside git; `merge`, `cleanup` and `custom` in a git repo; `pr` as well when
`Project.pullRequestHost` is set. That takes three checks, all file reads (`store/remotes.ts`,
cached for 2 s per path): `gh` is on the daemon's PATH; the repo's git config (following a
worktree's `.git` file to the common dir) has a remote, `origin` or the only one, whose URL parses
to a host and `owner/repo`; and gh's `hosts.yml` (`$GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, else
`~/.config/gh`) lists that host, or `GH_TOKEN`/`GITHUB_TOKEN` is set for github.com. So github.com
and GitHub Enterprise hosts work alike, and Bitbucket, GitLab and hosts gh isn't logged into get no
PR option.

**The project default** (`Project.completionAction`, migration 18, default `merge`) is what the
Approve button preselects and what completes a ticket nobody picks for (a skipped human review, a
conductor's `complete_ticket` without `action`). `create_project` /
`update_project` / `PATCH /projects/:id` refuse a default the project doesn't offer; a stored
default the project stops offering (gh logged out, the remote removed) falls back to merge, then
custom (`projectCompletionDefault`).

**The choice** is stored on the ticket (`Ticket.completionAction`, `completionInstructions`) when
it's approved (`POST /review`, `review_ticket`) or completed (`POST /complete`,
`complete_ticket`), because a human approval can come before the agent review finishes. A new
action without instructions drops the old instructions. `completionOptions` (shared) decides what
a ticket may do and what's preselected: a child on its parent's branch only merges; otherwise the
offered actions (`cleanup` always among them in git, even for a worktree with no commits, when
the work was a change outside git), less `merge` and `pr` when there's nothing to merge or open a
pull request from (`nothingToLand`): the ticket's branch is its effective base branch
(`worksOnBase`; triage makes such tickets with `dispatch_ticket { branch, base_branch }` for work
on an existing pull request's branch), it has no branch of its own (`hasNoBranch`: `branch` is
null, it ran in the project checkout), or its worktree has no changes (`Ticket.hasChanges` false).
It preselects the ticket's earlier choice, then `pr` for a ticket that already has a
`pullRequestUrl` (a re-approval updates the same pull request), then the project default, then the
first action left (so such a ticket preselects `cleanup`). The apps pass the base branch they resolve (`resolveBaseBranch`); the
service passes its own, which can also fall back to the main checkout's branch. An action the
ticket doesn't offer is a 400. `enqueueComplete` writes the resolved action back to the
ticket, so the run's system prompt and first message agree.

**Changes to land.** `Ticket.hasChanges` (column `has_changes`, migration 24) says whether the
ticket's worktree has anything to land: uncommitted changes (untracked files too), or commits on
its branch that the effective base branch doesn't have (`hasChangesToLand`). The service checks
with git, in the background, whenever the ticket moves to review, whenever GET /tickets/:key opens
it in review (so a commit made by hand shows up), and before `enqueueComplete` resolves the action.
A change is broadcast as `ticket.upserted`. It stays null for a ticket without a worktree of its
own, before the first check, and when git can't say (the worktree is gone, a branch is missing),
and null changes nothing.

**Pull requests.** `record_pull_request` (complete runs only; refused unless the completion is a
`pr` one) sets `Ticket.pullRequestUrl`, which the apps link to. A `pr` complete run that ends
without recording one blocks the ticket ("Completion ended without opening a pull request")
instead of moving it to done. After a re-open, `run.reopen` points the agent at the pull request's
review comments, and the next `pr` completion pushes to the same branch and updates it. The
harness doesn't follow the pull request after that: review and merge happen on GitHub.

**Approve and take no action** is `POST /complete { skipAgent: true }`, the same as Mark done: no
run, and the worktree and branch stay as they are. In review it also records the human approval.

### Conductor

Any ticket with children acts as a conductor (`isConductor`: `kind: "conductor"` or
`childCount > 0`). `kind` only decides the ticket's prompts and run kind: a `"conductor"` ticket
runs **conductor** runs whose instructions say to split the goal into children, a `"task"` runs
work runs. A task becomes a parent when its agent calls `create_ticket` with `child: true` (a
conductor's default), for example because the human asked for child tickets; its work runs then
get a "Your child tickets" section listing them. Everything below applies to both. Tickets carry
`childCount` (a subquery in the ticket repo), and creating or deleting a child re-sends the
parent's `ticket.upserted`, so the apps show the rollup, badge and Tickets tab as soon as a task
takes its first child. Children default to `autoStart: true`: they start as soon as all `dependsOn` are done
(immediately if none). Whenever a child changes status the orchestrator enqueues one
(coalesced) run of the parent's own kind (conductor or work) with `conductorUpdatePrompt`. The conductor acts as the human reviewer
for its children (`review_ticket`) and completes them (`complete_ticket`). When the parent works in
a worktree of its own, its children branch from its branch and merge back into it (the `"parent"`
base branch source, "Branches"): they only complete with `merge` (`pr`, `cleanup` and `custom` get a 400), and
the whole goal lands on the base branch, by the parent's own merge, pull request or custom
completion, only when the parent completes. So in the app a
child "needs you" only when it is blocked or waiting on a tool approval; a child in Review
with the human review pending is the conductor's to act on (it stays dimmed on the board and
isn't counted in the rollup). While the parent isn't done (`managingConductor`), the apps show
the child's Approve split button with its usual label, but disabled (the menu too), also once the
conductor approved it,
with `conductorManagedReason` ("Conductor managed: <parent> approves and lands this ticket") as the
tooltip, and the palette leaves out its commands. The service still takes a human approval
(over the API, say). A done parent hands its children back to the human: one it had approved
waits on the human's approval again, which lands it. Top-level tickets in Review still wait on the human. When all children
are done and the parent's run ends without submitting, the orchestrator submits it for review
automatically; while any child isn't done, a run that ends without submitting leaves the parent in
progress, and `submit_for_review` is refused (a parent in review or done would strand children
whose reviews and merges are its job).

### Watchers and triage

A watcher is **any command that prints text**, plus a **prompt** in the user's words saying what
to do with that text ("If this event is assigned to me and has actionable next steps, dispatch
it to an agent"). Nothing about the output's shape is required: JSON, log lines and prose all
work. `watch-jira`'s NDJSON is just text now.

**Command representation.** `command` + `args` (`Watcher` in `shared/src/protocol.ts`):

* `args` empty (every watcher the apps create): `command` is one shell command line, run as
  `$SHELL -lc <command>` (`/bin/zsh` when `$SHELL` isn't absolute). The login shell gives it the
  user's PATH, and pipes and loops like `while true; do curl -s …; sleep 60; done` work.
* `args` non-empty (watchers created before prompts existed): `command` is an executable,
  spawned directly with `args` and no shell, exactly as before. Saving such a watcher from a
  form turns it into a shell command line (`watcherCommandLine` in `shared/src/watchers.ts`
  quotes the args).

The prompt is read at delivery time, so editing it doesn't restart the process. Changing the
command, args, cwd, env, mode or interval does.

**Output → Inbox items** (`WatcherRunner`, `service/src/orchestrator/watchers.ts`):

* `mode: "interval"` runs the command every `intervalSec`. Each run's stdout is one item.
* `mode: "loop"` re-runs the command as soon as it exits (for blocking or long-running
  commands). Each **burst** of output is one item: lines that arrive close together, ended by
  `batchIdleMs` (200ms) of quiet or `batchMaxMs` (1s) of age. Going quiet delivers everything,
  so a response without a trailing newline (pretty JSON from `curl`) stays whole. Hitting the
  max age while output is still streaming stops at the last complete line and carries the
  partial line into the next item.
* Output is trimmed, and whitespace-only output is dropped. A chunk is cut at 16,000
  characters and marked truncated, and the triage prompt says so.
* Identical output from the same watcher is triaged once: `seen_items` records
  `(watcher id, sha256:<hash of the trimmed text>)`. Output that changes at all is a new item.
* Supervision is unchanged: exit 0 = ok, 4 = nothing to report, anything else is a failure
  (`lastError` carries the stderr tail, and loop mode backs off exponentially).

Each item starts an **ephemeral triage session** (`kind: "triage"`, key `TRIAGE-n`, visible in
the app's Inbox, not on the board). Its title is the output's first line with letters or digits
in it, cut at 80 characters. Triage replaces it with the dispatched ticket's title, or with
`decline_work`'s `title`. The triage prompt carries, in order: the watcher's name and the
provisional title, an instruction to pick the project from the user's prompt and the output (and
to decline when that leaves it ambiguous), the user's prompt, the local tickets whose keys
appear in the output, the raw output in a fence it can't close, and the project list. Triage
works out the title, key, link and project, then calls `dispatch_ticket` (once per separate item in the
output that qualifies) or `decline_work`. `dispatch_ticket`'s `key` is the item's remote ID
("Remote IDs"), and `ticket_key` names an existing local ticket:

- `key` without `ticket_key` always creates a **new** ticket with the project's next key, linked
  to the remote ID (`externalRef`). It never picks an existing ticket by key: a local ticket whose
  key happens to equal the remote ID isn't the same work. The outcome is
  `Dispatched to MH-124 (MH-62) in MH`.
- `ticket_key` (the current key or an alias; drafts don't count) posts the `spec` text to that
  ticket as a message (`Sent update to existing MH-123`). A done ticket is re-opened with it
  instead, as Re-open would, with the update as its prompt and a `reopened` entry by `system`
  (`Re-opened MH-123 with the update`): triage
  only dispatches work, so it re-opens up front rather than leaving it to a chat run's
  `resume_work`. Re-opening recreates the worktree the complete run may have removed. Adding `key` links a ticket that has no remote ID yet (`Linked MH-123 to MH-62 and
  sent update`, or `… and re-opened it with the update`). A ticket that already carries a
  different remote ID is refused.
- Neither creates a new, unlinked ticket with the next key.

The "Existing tickets" section of the triage prompt lists, for each ticket-style key in the output,
the local ticket with that key and every ticket linked to it as a remote ID, each with its status
and remote ID. Triage then decides whether an update belongs to one of them or starts a new ticket.
Outcomes always name the local key first, since `dispatchedKey` reads the first key. Triage runs get the board
read tools, and the triage instructions tell the agent to use `search_tickets` / `get_ticket` to
find tickets the output doesn't name by key (they're named only while triage runs have them).

**Routing lives in the watcher's prompt.** There is no separate key → project table: the prompt
says where work goes ("When an actionable ticket assigned to me comes in, dispatch it to the
PLAYR project"; "PLAYR-12 goes to PLAYR, MEDL-3 to MEDL"). The orchestrator finds ticket-style
keys (`[A-Z][A-Z0-9_]*-\d+`) in the output only to list the local tickets they name. Triage
sessions run in the harness home directory, since no project is chosen until dispatch.

`POST /watchers/inject { source, text, prompt? }` feeds output as if a watcher named `source`
printed it (`HarnessClient.injectOutput`). An object `text` (or the older `{ source, item }`
shape) is sent as its one-line JSON.

## Tools

Harness tools (always exposed, via MCP for claude-code):

| Tool | Run kinds | Input |
| --- | --- | --- |
| `post_note` | all ticket kinds | `{ note }`: a `note` Activity entry. No attachments; any length, though the prompt strongly recommends one line of 400 characters or less: Activity shows the first line (see "Activity") |
| `read_spec` | plan, work, review, complete, conductor, chat | `{ revision? }` → `Revision N (current)…` (with the approved baseline when there is one), then the text with line numbers like Read; an earlier `revision` is for reference only |
| `edit_spec` | plan, work, review (Open questions only, per its prompt), complete, conductor, chat | `{ base_revision, note, edits: [{ old_string, new_string, replace_all? } \| { start_line, end_line, new_text, expected? }] }`: atomic (one bad edit applies none), line numbers are the base revision's (an earlier edit in the call doesn't shift them; overlapping one is refused), `end_line = start_line - 1` inserts. A `base_revision` that isn't current, or a failed edit, errors with the current revision. Local images become attachments (see "Spec revisions and attachments") |
| `update_spec` | plan, work, complete, conductor, chat | `{ spec, note, base_revision, title? }`: replaces the whole spec as a new revision (planning writes the first full spec this way); same revision check and images as `edit_spec`; `title` retitles the ticket |
| `block` | work, chat (not a conductor ticket's) | `{ question }` |
| `unblock` | work, conductor, chat | `{ note? }`: blocked → in progress once the human's message resolves the block |
| `resume_work` | work, conductor, chat | `{ note? }`: review or done → in progress before a chat works on the ticket again (both reviews start over; a done ticket is re-opened, its worktree recreated, and the result names it when it moved) |
| `submit_for_review` | work, conductor, chat | `{ note, spec_is_up_to_date, skip_agent_review?, skip_human_review? }`: `spec_is_up_to_date` is advertised as required and must be `true` (anything else is refused with a message saying to update the spec first); `note` covers this round only; Activity shows its first line (see "Activity"). `skip_agent_review` / `skip_human_review` set the ticket's `skipAgentReview` / `skipHumanReview` first (turning one on is refused when the other review would be skipped too; see "Skipping the agent review" and "Skipping the human review") |
| `review_decision` | review | `{ decision: "approve"\|"request_changes", notes }`: any length; Activity shows the first line, which must state the outcome on its own (see "Activity") |
| `update_branch` | work, conductor, chat | `{ branch?, base_branch? }`: the run's own ticket (`update_ticket` refuses it). `branch` re-points it: a branch checked out in another worktree moves the ticket (`workdir`, session cwd) into that worktree; any other branch is switched to in the ticket's worktree (`git switch`, `-c` at HEAD when new; git's message when it refuses). `base_branch` sets `ticket.baseBranch` (`"inherit"`/`""` → null). Never deletes a branch or worktree. See "Branches" |
| `create_ticket` | work, conductor | `{ title, spec, project_key?, depends_on?: string[], start?, auto_start?, conductor?, child?, driver?, model?, use_worktree?, base_branch?, branch?, skip_agent_review?, skip_human_review?, remote_id?, remote_url?, attachments?: string[] }`. `attachments` sets `promptAttachments` (paths that exist now, relative ones against the run's cwd; see "Prompt attachments"). `remote_id` / `remote_url` link the new ticket to a remote ID ("Remote IDs": validated like the PATCH, source `"manual"`; `remote_url` without `remote_id` is refused). `base_branch` / `branch` set `baseBranch` / `requestedBranch` ("Branches"); `skip_agent_review` / `skip_human_review` set `skipAgentReview` / `skipHumanReview` (omitted: the project's defaults, "Review defaults"). `child` (default true for a `kind: "conductor"` caller, false otherwise): a child (`parentId` = the caller, `auto_start` default true, the caller's driver/model by default). Otherwise: a top-level ticket in the run's project or `project_key` (`start` default false → planning with a plan run; driver defaults like `POST /tickets`). depends_on takes keys, e.g. from earlier create_ticket calls; `model: ""` means the driver default. `use_worktree` sets the new ticket's `useWorktree` (false: the project checkout); omitted, it follows the project's `useWorktrees`, a conductor's children included |
| `update_ticket` | plan (own ticket only), work, conductor | `{ key, title?, spec?, base_revision?, driver?, model?, permission_mode?: "auto"\|"ask"\|"read_only"\|"inherit", depends_on?, base_branch?, branch?, skip_agent_review?, skip_human_review?, remote_id?, remote_url? }` → `Orchestrator.updateTicket` (same validation as `PATCH /tickets/:key`; `spec` is a new revision, author `agent`, note "Rewritten with update_ticket"; it needs `base_revision`, the `specRevision` from `get_ticket`, and a spec that changed since is refused with the current revision, like `edit_spec`). `remote_id` / `remote_url` become `externalRef`: `remote_id: ""` unlinks, a remote ID alone keeps the link of the one the ticket already carries (a different one starts with none), `remote_url` alone re-links the current remote ID (`""` clears the link) and is refused on an unlinked ticket. `branch` only while the ticket has no worktree; after that the error says to ask its agent (`update_branch`) |
| `move_ticket` | work, conductor | `{ key, status, position? }`: moves a card on the board (`updateTicket` with status/position). Agents move cards; the Mac board has no manual moves. `position` is the 0-based slot in the target column, turned into a sort key with `positionForDrop` like the iPhone app's move menu; the same status with a position reorders |
| `list_tickets` | all | `{ scope?: "children"\|"project"\|"all", project_key?, status?: TicketStatus[], limit? }`. Default scope: a ticket with children (or a conductor) → children, other ticket runs → the ticket's project (or `project_key`), triage → all. Board order (done newest-completed first), capped at `limit` (default 50, max 200) with a "Showing n of total" note |
| `get_ticket` | all | `{ key, include_transcript?: 1..50 }`: any project, old keys resolve (`resolvedFrom`), remote IDs never do: a key only tickets carry as their remote ID returns `{ ticket: null, requested, relatedTickets }`, and a found ticket carries `externalKey`, `externalUrl` and `relatedTickets` ("Remote IDs"). Spec, `specRevision`, `specBaselineRevision`, status, reviews, blocked reason, parent/children keys, dependsOn, driver/model, branches (`branch`, `requestedBranch`, `baseBranch`, `effectiveBaseBranch` + `baseBranchSource`), `activity` (kind, author, body, meta, createdAt), `attachments` (id, name, kind and stored file `path`), `promptAttachments` (name, path, `missing`); with include_transcript the last N text/status/error transcript entries, each clipped to 2000 chars |
| `search_tickets` | all | `{ query, project_key?, limit?, cursor? }` → `{ total, hits: [{ key, title, status, project, snippet }], nextCursor }`. Same matching, ranking and cursors as `GET /tickets/search` ("Paging and search"); default limit 20 |
| `list_projects` | all | `{}` → each project's key, name, path and settings, with `completionAction`, the offered `completionActions` and `pullRequestHost` |
| `list_inbox` | all | `{ status?: TriageStatus[], source?, key?, limit?, include_output? }` (`key` picks one item, e.g. `TRIAGE-12`; `get_ticket` on an Inbox key fails pointing here) → Inbox items (triage sessions) newest first: key, title, source (watcher name), status, outcome, the watcher prompt, and with include_output the output (clipped to 2000 chars). Default limit 20, max 100, with a "Showing n of total" note |
| `start_ticket` | work, conductor | `{ key }` → `startTicket` (any ticket, not only children) |
| `message_ticket` | work, conductor, chat | `{ key, text }` → `sendMessage`, as a human message (never with `move`: the ticket stays in its column and its agent moves it) |
| `cancel_ticket` | work, conductor | `{ key }` → `cancelTicket` (abort the active run, drop queued runs) |
| `reopen_ticket` | work, conductor | `{ key, notes }` → `reopenTicket` |
| `review_ticket` | work, conductor | `{ key, decision, notes, action? }`: only the caller's own children. `action` (with approve) is how the child's work lands ("Completion") |
| `complete_ticket` | work, conductor | `{ key, instructions?, action? }`: only the caller's own children |
| `record_pull_request` | complete | `{ url }`: the pull request a `pr` completion opened or updated (`Ticket.pullRequestUrl`); refused in any other completion |
| `dispatch_ticket` | triage | `{ project_key, key?, ticket_key?, url?, title, spec, start?, conductor?, branch?, base_branch? }`: `key` is the remote ID, `ticket_key` an existing local ticket to update (see "Watchers" and "Remote IDs"); `branch` and `base_branch` are the new ticket's, both set to an existing branch (an open pull request's head) for work that lands there directly (see "Completion") |
| `decline_work` | triage | `{ reason, title? }` |
| `list_watchers` | all | `{}` (env values shown as `"(set)"`) |
| `get_settings` | all | `{ include_prompts? }` → public settings (`anthropicApiKeySet` and `claudeOauthTokenSet`, never the secrets; `customizedPrompts` lists overridden prompt ids, and `include_prompts` adds the `GET /prompts` catalog as `prompts`) |
| `list_drivers` | all | `{}` → drivers with their models |
| `create_watcher` | work, conductor, chat (gated) | `{ name, command, prompt?, args? (legacy), cwd?, env?, mode?, interval_sec?, enabled?, driver?, models? }` (`models` merges per driver like `default_models`) |
| `update_watcher` | ″ | `{ watcher (id or name), …fields }` (env merges; `""` removes a variable) |
| `delete_watcher`, `run_watcher` | ″ | `{ watcher }` |
| `create_project` | ″ | `{ path, key?, name?, default_driver?, use_worktrees?, skip_agent_review?, skip_human_review?, completion_action?, permission_mode?, default_models?, color?, group?, base_branch? }` |
| `update_project` | ″ | `{ project_key, key? (rename), path?, …same fields }` |
| `delete_project` | ″ | `{ project_key }` (never the project of the run's ticket or its ancestors) |
| `update_settings` | ″ | `{ default_driver?, max_concurrent_runs?, permission_mode?, classifier?, default_models?, review_models?, watcher_driver?, watcher_models?, listen?, base_branch?, prompts? }` (`prompts` merges per id; null resets one) |
| `delete_ticket` | ″ | `{ key }` (never the run's own ticket or an ancestor) |
| `browser_open` | plan, work, review, conductor, chat | `{ url, tab?, new_tab?, device?, width?, height?, wait_for? }` → names the tab and its size; `tab` with `new_tab` is refused; the size is set before the page loads. See "Browser tabs" |
| `browser_tabs` | ″ | `{ tab? }` → one line per tab: number, title, URL, mode and size, and its failed-request and console-error counts; with `tab`, that tab in full (state, size, scroll, requests failed-first, console). A suspended tab isn't reopened |
| `browser_resize` | ″ | `{ device?, width?, height?, tab?, wait_for? }` (at least one): `device` resets to its preset size and reloads; `width`/`height` keep the mode. Any tab of the session ("your own tabs" is prompt guidance only); ends a viewer's Responsive |
| `browser_close_tab` | ″ | `{ tab }` |
| `browser_content` | ″ | `{ selector?, format?: "text"\|"html", max_chars?, tab?, wait_for? }` |
| `browser_click` | ″ | `{ selector, tab?, wait_for? }` → says so when the target was disabled or inside `[aria-busy]` |
| `browser_type` | ″ | `{ selector, text, submit?, tab?, wait_for? }` |
| `browser_eval` | ″ | `{ expression, tab?, wait_for? }` → JSON from Chrome's deep serialization (elements as `tag#id.class`, cycles as `"[Circular]"`); a navigation mid-expression is an error naming the new URL |
| `browser_screenshot` | ″ | `{ save_to?, tab?, wait_for? }` → image; with `save_to` the PNG is also written to a file and the text result names the path. Confined, see "Spec revisions and attachments" |
| `browser_wait` | ″ | `{ selector?, state?, text?, url?, idle?, timeout?, tab? }`: the `wait_for` wait without an action. See "Browser waits and scripts" |
| `browser_run` | ″ | `{ script, tab?, timeout?, wait? }` → starts a script job, returns its number and log after `wait` s. See "Browser waits and scripts" |
| `browser_run_status` | ″ | `{ job, wait? }` → the job's state and its new log lines; a failure adds the script line, step, URL and a screenshot |
| `browser_run_stop` | ″ | `{ job }` |
| `permission_prompt` | all, for drivers with `usesPermissionPromptTool` (claude-code, dummy) | `{ tool_name, input, tool_use_id }` → text JSON `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`; calls `HarnessOps.requestApproval`. Called by the CLI itself (`--permission-prompt-tool`), not the model |

The five board tools (`service/src/tools/board.ts`, the `// --- board (read) ---` section of
`HarnessOps`) only read: every run kind gets them so an agent can look up related or earlier
work anywhere on the board, or check what a watcher it set up has put in the Inbox. Each prompt
has a short "Board" section naming them, and a "Harness configuration" section naming the
config reads. Work, conductor and chat prompts add the board write tools and the gated config tools,
and say that every config call waits for a human and is then repeated exactly.

### Board changes by agents

The write tools (`service/src/tools/board-write.ts`, the `// --- board (write) ---` section of
`HarnessOps`) let work and conductor runs do to other cards what a person does on the board, and
a plan run set up its own card.
They call the same `Orchestrator` methods as the HTTP API, so validation and side effects
(moving to in_progress starts a work run, a move back from done re-opens, and so on) are shared.
The guard rails live in the orchestrator ops, not in tool text, so a driver calling ops directly
hits them too:

- **Run kinds.** Only work and conductor runs, plus `update_ticket` in plan runs. Review,
  complete and triage runs don't get the tools, plan runs get no other write tool, and the ops
  throw for them.
- **Never the caller's own ticket**, except a plan run's `update_ticket`. Its own state changes
  go through `block` / `submit_for_review`. Keys resolve like the HTTP API (old aliases too), so
  an alias of the caller's key is refused as well.
- **A plan run edits only its own ticket, with full access.** `update_ticket` from a plan run
  (`ownPlanTarget`) refuses any other key ("In a planning run, update_ticket only edits your own
  ticket"). On its own ticket every field works, a looser `permission_mode` included: the
  `system.plan` prompt has the agent apply the settings the spec asks for (`/depends: A-1`,
  `/branch: main`, `/skip-human-review`, or plain words), and the human sees them with the plan
  before pressing Start. Dependency and branch validation still run (`Orchestrator.updateTicket`).
- **Reviews stay with reviewers.** No move goes into review (only the ticket's own agent submits)
  or out of it (the agent reviewer, then the human or the parent conductor via `review_ticket` /
  `complete_ticket`, decide). `message_ticket` on a ticket in review is refused too, since a
  message sends it back to in progress, unless the caller is that ticket's parent conductor.
- **Review skips.** `create_ticket` / `update_ticket` may turn either skip on, or both, like the
  ticket's own `submit_for_review` ("Skipping the agent review", "Skipping the human review").
  `update_ticket` `skip_agent_review` /
  `skip_human_review` on a ticket in review is refused unless the caller is its parent conductor
  (its reviewer): it would end, start or approve the review under way.
- **Done only from planning.** `move_ticket` to done works only on a ticket still in planning
  (closing one that isn't needed). Anything that ran goes through review and a complete run.
- **Tool approvals are a human's.** A ticket with a `pendingApproval` can't be messaged (a
  message would deny it), moved to another column, started, or cancelled (nothing is running,
  and cancelling would only strand the approval). There is no tool to answer one.
- **Permission modes only tighten** on another ticket. `update_ticket` compares the ticket's effective mode before
  and after (`resolvePermissionMode`, order auto < ask < read_only) and refuses a looser one,
  including `"inherit"` when the project's mode is looser.
- **No escalation through other tickets.** A ticket an agent creates (work or conductor run)
  runs no looser than the caller: when the caller's effective mode is stricter than what the new
  ticket would inherit from its project, the ticket gets the caller's mode explicitly; otherwise
  `permissionMode` stays null (inherit). (`create_ticket` with `depends_on` also checks that the
  new ticket isn't looser, since the scheduler may start it on its own. The rule above already
  guarantees that, so the check is a backstop.) An agent can't put work into a ticket whose
  effective mode is looser than its own: `message_ticket`, `start_ticket`, `reopen_ticket` and
  `move_ticket` to in_progress or planning are refused ("<KEY> runs in auto, looser than your
  read_only; ask a human"). Nor can it edit one with `update_ticket`, whatever the field: the
  spec is what its next run follows and `depends_on` lets the scheduler start it.
  The one exception is a call that only changes `permission_mode` to a stricter one, which can
  only make the ticket safer. Equal modes are fine, so a conductor steers and edits children
  created under its own mode.

Deleting tickets isn't a board tool: `delete_ticket` is a config tool behind a human approval
(see "Config tools").

### Config tools

The config tools (`service/src/tools/config.ts`) cover the Settings and Project Settings
screens, so a ticket like "add a watcher that polls our events API every minute and dispatches
anything assigned to me with next steps" can be done end to end. Watchers are generic (see
"Watchers and triage"), so the tool descriptions don't teach an output format. `command` is a
shell command line whose stdout text goes to the Inbox, `prompt` is the user's instructions to
the triage agent, and `mode` is `loop` for long-running or self-looping commands (`while true; do
curl …; sleep 60; done`) or `interval`. A non-zero exit shows as the watcher's error. `args` is
described as legacy only. The tools pass `prompt` straight through to
`Orchestrator.createWatcher` / `updateWatcher`, which validate and store it like the HTTP API.
`list_watchers` shows it when set, and the approval summary includes it, since the prompt decides
what happens to the output, including which project it goes to: the tool descriptions tell the
agent to put the project the user names into the prompt. Approval cards show the command line as written (`commandLine` in
`shared/src/commandLine.ts`: `watcherCommandLine`, plus the line inside a legacy `zsh -lc`).

Reads go to every run kind. Every mutation is a **gated tool** (`defineGatedTool` in
`tools/util.ts`), because a watcher's command runs as the user outside any ticket sandbox and
settings like `permissionMode` or `listen` loosen the permission model or network exposure. A
gated call:

1. runs the op in dry-run mode first (`HarnessOps.*(…, dryRun = true)`: the same validation as
   the HTTP API), so a bad call is a tool error and never reaches a human;
2. calls `requestApproval` with `{ summary, reason, source: "policy", onceOnly: true }` whatever
   the ticket's permission mode. Read-only tickets are denied outright; otherwise the ticket
   blocks with a `pendingApproval` whose `summary` (e.g. `Create watcher "events" (loop): while
   true; do curl …; done; prompt: "…"; env: EVENTS_TOKEN, ZDOTDIR; cwd: ~/work`) is the card's
   subtitle and blocked reason. Watcher summaries name `env` keys and a non-empty `cwd`, since
   both change what the command does (`ZDOTDIR` changes what the login shell runs), but never
   env values; `update_watcher` lists keys set and keys removed separately and says
   `cwd: service default` when it's cleared. The card's "Other input" row
   (`describeApprovalInput` in `shared/src/state/format.ts`) deliberately shows env values
   unmasked: the approver has to see exactly what they authorize (`ZDOTDIR=/tmp/x`, a `PATH`
   override), and the proposing agent already knows every value, so masking would hide it only
   from the human. Values stay hidden from agents in `list_watchers`;
3. after **Allow once**, the resumed agent repeats the identical call, which consumes the one-time
   grant and runs the op.

`onceOnly` approvals refuse `allow_tool` (400) and the cards hide "Always allow": each watcher
command, settings change or delete is its own decision. `ticket.allowedTools` never unlocks a
gated tool, and gated grants are consumed in-process, so `runGrants` doesn't pass them to the
driver (claude-code would otherwise drop an auto run to acceptEdits for a grant it can't express
as a CLI rule). The orchestrator ops also refuse anything but work and conductor runs, whichever
tool reaches them. A conductor can't approve a child's config call either: a message to a ticket
with a pending approval answers it with deny.

Left out on purpose: setting `anthropicApiKey` or `claudeOauthToken` (secrets don't pass through a model; the op
refuses it and `list_watchers` hides env values), device pairing and token rotation (they
hand out access to the service itself), driver login (interactive OAuth in the user's browser),
the network status readout (`GET /network`; `get_settings` has the listen setting), and the
appearance/theme settings (client-side preferences, not service state).

### UI parity

What a person can do in the Mac and iPhone apps, against the agent tools. "Local" rows are
client state, not service state.

| Area | In the apps | Agent tool | Left out, and why |
| --- | --- | --- | --- |
| Board | search, list, page Done, open a ticket, its spec (and revisions), Activity, transcript | `search_tickets`, `list_tickets`, `get_ticket` (`include_transcript`); `read_spec` (`revision`) for the run's own ticket | other tickets' earlier revisions and spec diffs have no tool |
| Board | create a ticket (task or conductor, driver, model, permission mode, start or plan, branch picked from the project's branches, base branch) | `create_ticket` (`branch`, `base_branch`; `remote_id`, `remote_url` link it as the Remote ID field does) | the branch list itself (`GET /projects/:id/branches`) has no tool: agents run `git branch` |
| Board | edit title, spec, dependencies, driver, model, permission mode, base branch, branch (until it has a worktree), remote ID and its link | `update_ticket` (`remote_id`, `remote_url`; a plan run's on its own ticket) | permission modes only tighten on another ticket |
| Board | move a ticket's work to another branch after it started | `update_branch` (the ticket's own agent; ask it with a message) | the apps don't re-point a running ticket themselves: the agent has to move its commits |
| Board | move to another column or reorder (iPhone only, from the touch-and-hold menu; the Mac board leaves moves to agents) | `move_ticket` | not into or out of review; done only from planning |
| Board | start, message or answer a question, cancel, re-open | `start_ticket`, `message_ticket`, `cancel_ticket`, `reopen_ticket` | |
| Board | attach files to a new session (drop, pick, paste; images go to the agent inline) and see them, missing ones flagged, on the Spec tab | `create_ticket` (`attachments`), `get_ticket` (`promptAttachments`) | uploads (`POST /uploads`) have no tool: an agent's files are already on disk |
| Board | annotate a spec image, a prompt or message attachment, a browser tab's page, or an image in the composer or a New session with numbered arrows and notes, as part of a message | none | annotations are a human's way of pointing at things; agents send images with `update_spec` |
| Board | @-mention project files in a new session or a message (autocomplete; the files are attached to the run) | none | agents read files with their own tools; `message_ticket` text with `@path` still gets the files attached |
| Board | start a new session or a message with an agent's `/command` or skill (autocomplete; the agent expands it) | none | agents run their own skills; `message_ticket` or `create_ticket` text that starts with `/name` still reaches a claude-code agent as a command |
| Board | delete a ticket | `delete_ticket` (gated) | never the caller's own ticket or an ancestor |
| Board | approve a review choosing how it lands (merge, open PR, "Approve and…" with instructions, take no action), request changes, re-run the agent review, complete or mark done; open a ticket's pull request | parents only, for their own children: `review_ticket`, `complete_ticket` (`action`) | reviews and merges are the reviewers' and the human's; an agent can't sign off its own or a sibling's work |
| Board | answer a tool approval (allow once, always allow, deny) | none | a human's decision by design; a message to a ticket waiting on one is refused |
| Inbox | list triage items, open one, open its dispatched ticket | `list_inbox` (`include_output`), `get_ticket` | the apps have no Inbox actions beyond reading |
| Watchers | create, edit (command line, prompt, cwd, driver, mode, interval), pause or resume, run now, delete | `create_watcher`, `update_watcher` (`enabled`), `run_watcher`, `delete_watcher` (all gated); `list_watchers` | `env` is tool-only (the forms don't edit it); values are never shown |
| Projects | add, rename, change key or folder, default driver and models, permission mode, worktrees, base branch, review defaults, what approving does ("When approved"), color, group, remove | `create_project`, `update_project`, `delete_project` (gated); `list_projects` | reveal in Finder and "new session here" are Local |
| Settings | default driver, concurrent runs, default and review models, permission mode, classifier, network listen mode, base branch | `update_settings` (gated), `get_settings` | |
| Settings | prompts: read the built-in text and variables, override a prompt, reset it | `update_settings` (`prompts`, gated), `get_settings` (`include_prompts`) | |
| Settings | Anthropic API key, long-lived Claude token, GitHub Copilot token | none | secrets don't pass through a model; `get_settings` shows only `anthropicApiKeySet` and `claudeOauthTokenSet` |
| Settings | network status, pairing QR, token copy or rotation, pairing and switching Macs on the iPhone | none | they hand out access to the service itself, or are device-local |
| Drivers | list drivers and models, refresh models | `list_drivers` | |
| Drivers | log in to a driver | none | interactive OAuth in the human's browser |
| Browser | watch or drive a session's browser tabs, open and close tabs | `browser_*` on the run's own session's tabs | other sessions' tabs are a human's live view |
| Plugins | Git Changes tab (diff, log, file view) | none | read-only view of the ticket's git history; agents run `git` in their worktree |
| Board | a ticket's sub-agents and their transcripts, and its background tasks and their output (Agents & tasks tab) | none | a sub-agent reports back to the agent that started it; other agents read that agent's Activity and transcript |
| Local | appearance and themes, layout (sidebar, panes), board project filter, show or hide children, last-used project | none | client preferences, not service state |

`service/src/orchestrator/generic-watcher-e2e.test.ts` walks the headline scenario with the
dummy driver: a work run creates a looping `zsh -lc` watcher around
`__fixtures__/events-api.ts` (a stand-in for `curl` against an events API) after an approval,
each event becomes an Inbox item carrying the watcher's prompt, and triage dispatches or
declines it by that prompt. `service/scripts/claude-code-watcher-check.ts` runs the same
scenario by hand with the real claude-code driver for both the setup and triage, against a
throwaway `HARNESS_HOME`.

Harness tools are advertised over MCP with `readOnlyHint: true`: Claude Code refuses
non-read-only MCP tools in `--permission-mode plan`.

Native tools (only for drivers with `hasBuiltinTools: false`): `bash {command, timeout_ms?}`,
`read_file {path, offset?, limit?}`, `write_file {path, content}`,
`edit_file {path, old_string, new_string, replace_all?}`, `list_files {path?, pattern?}`.
Paths resolve relative to the run cwd. Review, plan and conductor runs get read-only native
tools (`read_file`, `list_files`, `bash`); triage gets none. Every native call first asks
`HarnessOps.checkPermission` (the PermissionGate, see "Permissions"); a deny becomes the tool's
error result.

`toolsForRun(kind, driver)` in `service/src/tools/index.ts` is the single source of truth.

File tools over the shell: every ticket run's system prompt has a "Files" section telling the
model to read and edit through its file tools (claude-code's `Read`/`Edit`/`Write`/`Grep`/`Glob`,
or the native `read_file`/`edit_file`/`write_file`/`list_files` when `hasBuiltinTools` is false),
not `cat`/`sed -i`/heredocs through bash. Claude Code's auto mode prompt tells the model shell
edits are fine; the section overrides that, because edits in the workdir are auto-allowed (ask →
`acceptEdits`, and the PermissionGate's edit-in-workdir path) while the same change through bash
goes to a permission prompt or the classifier. Plan, review and conductor runs get only the read
half. We don't reimplement the file tools for claude-code: the CLI's own are used as-is.

File links: every ticket run (not triage) also gets a "File links" section (`system.file_links`)
asking the model to put a `[path:start-end](harness://file/path#Lstart-Lend)` link before any code
it quotes from the working directory, and to use the same link for a file:line named in prose.
The apps open those links in the file pane (`shared/src/fileLinks.ts` defines the format). Claude
Code's own prompt asks for bare `file_path:line_number` references; the section overrides that.

## Drivers

- **dummy** — deterministic, no network. Used by tests and for fast manual testing (see below).
  Test-only: `createDrivers` adds it when the service's env has `HARNESS_DUMMY_DRIVER=1`, which
  the scripts that boot `daemon.ts` set. Installs leave it out; `harness service install|ensure`
  run with the variable set writes it into the launchd plist (acceptance.ts does this for its
  `dummy` run), and the next one without it takes it back out. `bun test` injects `DummyDriver`
  directly.
- **claude-code** — wraps the `claude` CLI (`claude -p --input-format stream-json --output-format
  stream-json --verbose --include-partial-messages`), which carries your **team-plan OAuth** login
  (`claude auth login --claudeai`; status via `claude auth status --json`), plus
  `--replay-user-messages` for steering (see "Steering"). Harness tools are
  injected with `--mcp-config` pointing at `POST /mcp/:runToken`. Conversation continuity via
  `--resume <session_id>` (stored as driver state). `--permission-mode` comes from the ticket's
  harness permission mode (see "Permissions"); plan runs use `--permission-mode plan`. Every
  prompt the mode doesn't auto-allow goes to `--permission-prompt-tool
  mcp__harness__permission_prompt` → `requestApproval` → a human. The harness server entry sets
  `alwaysLoad: true` so its tools skip ToolSearch deferral.

  **Sign-in.** A service started by launchd can't always read the login the CLI keeps in the
  Keychain. The CLI then falls back to `~/.claude/.credentials.json`, whose refresh token a
  terminal session may already have used up (refresh tokens are single-use), and every run fails
  with "OAuth session expired and could not be refreshed" while `claude auth status` still says
  `loggedIn` (HARNESS-230). Settings → Drivers → Claude Code takes a long-lived token from
  `claude setup-token` (`claudeOauthToken`, write-only like `anthropicApiKey`; clients see
  `claudeOauthTokenSet`). Every CLI call the service makes (runs, `auth status`, models and
  commands, the claude-cli classifier, auto-mode rules) gets it as `CLAUDE_CODE_OAUTH_TOKEN`, over
  one in the service's env; `auth login` still uses the CLI's own login. A run whose error is a
  sign-in failure (`isClaudeAuthFailure`) fails with a message that says how to fix it, and the
  driver's `info()` reports it signed out until a run gets through, a login finishes, or the stored
  token changes.

  **Background tasks and stdin** (verified against claude 2.1.284). The prompt goes in as one
  stream-json `user` message and stdin stays open. Each turn ends in a `result`; the CLI exits
  once stdin is closed after it. In plain `-p` mode the CLI waits for background agents and
  Monitor tasks, but it kills a background Bash command the moment the turn ends (even with
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`), including one Bash moved to the background after
  its 120 s timeout. With stdin open, the task's completion starts another turn instead. So at
  each `result` the driver closes stdin unless the agent's own tasks are still running
  (`task_started` → `task_notification` / terminal `task_updated`; a task whose tool result
  isn't a "running in background" / "moved to the background" / "Monitor started" / "Async
  agent launched" notice ends with that result). It also closes stdin when the turn called a
  finishing tool (`submit_for_review`, `block`, `review_decision`, `dispatch_ticket`,
  `decline_work`), so a dev server left running doesn't hold the run open, and when the result
  is an error. A wait posts a status line and has no time limit (a monitor or an import can
  run for days; `backgroundWaitMs` sets one, counted from the latest turn's end, for tests). The
  background Bash commands and Monitors it waits on are listed on the ticket's Agents & tasks tab
  with their output ("Sub-agents" → "Background tasks"). The
  work prompt tells the agent to pair a long background job with a check-in timer (a background
  `sleep`) so it wakes periodically instead of sitting silent; a human can stop the run. `total_cost_usd` is cumulative across turns, so each `usage` is charged
  the difference from the previous result. Before this, a work run whose agent ended its turn
  to wait on a background test run was cut short, and the orchestrator auto-submitted the
  "I'll be notified…" text (HARNESS-81).

  A resumed session whose last process ended with background tasks still running (a submit
  with a dev server up, say) opens differently (claude 2.1.286): the CLI reports those tasks
  `stopped` ("didn't finish before the previous session ended"), then emits an `init` and an
  empty `result` (`num_turns: 0`) before it reads the prompt, whose replay comes after. The
  driver ignores a non-error `num_turns: 0` result that arrives before the prompt's replay (the
  prompt is written with its own uuid). Before this, that result closed stdin, so the prompt's
  turn still ran but the CLI exited after it and killed whatever it had put in the background:
  HARNESS-139's completion run started sim-check in the background and was marked done.
- **anthropic-api** — direct Messages API with an API key (settings or `ANTHROPIC_API_KEY`),
  streaming, native tool loop over the harness + native tools. Message history is driver state.
- **github-copilot** — wraps the GitHub Copilot CLI (`copilot -p <prompt> --output-format json`,
  verified against 1.0.91). Driver state is `{ sessionId }`: the driver picks a UUID on the first
  run and passes `--session-id` every run, which creates the session or resumes it. Sessions live in
  `$COPILOT_HOME/session-state`, not per workdir, so a moved workdir still resumes. Harness tools come
  from `--additional-mcp-config` as the `harness` server; the CLI names them `harness-<tool>` and the
  driver reports them under their own names. There's no system-prompt flag, so the run's system
  prompt goes in front of the prompt inside `<harness_instructions>`. Prompt mode reads no stdin,
  so the driver doesn't steer, and attached images aren't sent (the prompt lists their paths).
  Permissions: auto → `--allow-all-tools`; ask → `--allow-tool write` plus the ticket's grants
  (`bash` → `shell`, edits → `write`, a one-time grant of a simple command → `shell(<command>)`);
  read-only and plan runs → `--deny-tool write --deny-tool shell`. The harness server is always
  allowed and `--no-ask-user` is always set. A call the rules don't allow fails with
  `error.code: "denied"`, which the driver reports as `permission_denied`, so it becomes a pending
  approval. Usage carries no tokens or cost: Copilot bills premium requests. A GitHub token in
  Settings (`copilotGithubToken`, write-only like `claudeOauthToken`; clients see
  `copilotGithubTokenSet`) goes to every CLI call as `COPILOT_GITHUB_TOKEN`, which the CLI prefers
  over its Keychain login. A run that fails to sign in marks the driver signed out until a run gets
  through, a login finishes or the token changes.

### Permissions

A ticket's **permission mode** is `ticket.permissionMode ?? project.permissionMode ??
settings.permissionMode` (`resolvePermissionMode` in `shared/src/permissions.ts`; default
`auto`). Null at a level means "inherit". Plan and triage runs are always read-only; chat
runs follow the ticket's mode, grants and approvals like work runs. A plan run's `ExitPlanMode`
(Claude Code's plan mode asking to leave it) is denied with `PLAN_APPROVAL_MESSAGE`: the human
approves the spec with Start.

| Mode | Meaning | claude-code (`--permission-mode`) | Native-tool drivers (PermissionGate) |
| --- | --- | --- | --- |
| `auto` | a classifier judges each unapproved action | `auto` (Claude Code's classifier) | classifier (below) |
| `ask` | edits inside the workdir run; everything else asks a human | `acceptEdits` + prompt tool | human approval |
| `read_only` | reads and read-only commands only | `dontAsk`, no prompt tool | deny |

claude-code, verified against claude 2.1.283 from a clean `env -i` shell:
- `auto` works headless. Its classifier's denials do **not** go through the permission prompt
  tool: the model gets an is_error tool_result "Permission for this action was denied by the
  Claude Code auto mode classifier. Reason: [Code from External]…". The driver logs each as a
  permission entry (`backend: "claude-code"`) and emits `permission_denied` (callId, toolName,
  input, reason); see "Classifier denials" below. Anything the CLI still asks about goes to the
  prompt tool.
- `auto` isn't available for every model (haiku): the CLI silently runs in `default`. The
  driver compares the init event's `permissionMode` with what it asked for and posts
  "Auto mode isn't available for <model>; unapproved actions will ask you instead." Those
  prompts then reach the human through the prompt tool.
- `read_only` uses `dontAsk`, not `plan`: dontAsk allows reads and read-only Bash and denies
  the rest without prompting; plan writes a plan file under `~/.claude/plans` and asks to
  `ExitPlanMode` through the prompt tool.
- `cleanClaudeEnv` strips what a parent Claude Code session leaks (`CLAUDECODE`, `CLAUDE_PID`,
  `CLAUDE_EFFORT`, `AI_AGENT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_*` except user config).
- Agent runs also get `MCP_CONNECTION_NONBLOCKING=0` (`claudeRunEnv`, unless the user set it).
  With stream-json input, claude 2.1.284 starts the first turn while claude.ai connectors are
  still `pending`, so the model sees none of their tools until a later turn. A plugin that ships
  its own copy of a connector (the `jira` plugin's `hc-jira`) is listed as needing auth until the
  connector list dedupes it. A one-turn triage run then declined with "the Jira MCP isn't
  available". With `0` the first turn waits for the connectors (about a second, capped at
  `MCP_CONNECT_TIMEOUT_MS`).

**Classifier denials → approval cards.** A classifier denial doesn't stop the run. The
system prompt ("Tool approvals") tells the agent to rethink the step and take a genuinely safer
route to the same goal if there is one (not the same action reworded or moved to another tool),
and to block (complete/conductor runs: stop) only when nothing else gets the task done. The
orchestrator collects a work/complete/conductor/chat run's `permission_denied` events and the
PermissionGate's deferred soft denials, dropping any whose exact call (`grantKey`) later
succeeded in the same run. When the run succeeds and a denial is left:
- the agent submitted (a work or conductor run): it got there another way, so the review goes
  ahead; a system `permission` Activity entry lists the denied calls and their reasons for the
  reviewer and human;
- otherwise the last denial becomes a `pendingApproval` (`source: "classifier"`, `reason` = the
  classifier's reason, tool + input of the denied tool_use). If the agent called `block`, the
  approval is attached to that block and its question stays `blockedReason`; if not,
  in_progress (or review, for a complete run) → blocked, as `requestApproval` does. A chat's
  card leaves the ticket in its column.
- The tool is already in `ticket.allowedTools` (auto mode ignores bare `Bash`, below): no
  card; the call gets a one-time grant and the run is resumed ("…the human allows Bash on this
  ticket. Retry it now"; a chat retries as a chat, where the ticket is), at most `MAX_AUTO_RETRIES` (3) times in a row before asking a human
  (a human answer or message resets the count).
Not in read_only, not for review/plan/triage runs. allow_once / allow_tool / deny answer it like
any card; allow_tool on a classifier card also adds a one-time grant for the denied call, so
the retry passes as an exact rule.

**Human grants → the CLI.** Work/complete/conductor/chat runs get `RunRequest.grants` = `{ tools:
ticket.allowedTools, once: the ticket's one-time grants }`; review runs don't (reviewers are
independent and start fresh), nor plan/triage runs or read_only tickets. claude-code
(`planGrants`) appends them to `--allowedTools` after `mcp__harness`, one argv entry per rule:
- a tool grant → the bare name, only if it matches `^[A-Za-z][A-Za-z0-9_-]*$` (so a stored
  name can't be a pattern like `Bash(*)` or a second rule);
- a Bash one-time grant → `Bash(<command>)`, rule content escaped `\` → `\\`, `(` → `\(`,
  `)` → `\)` (the CLI unescapes `\(` `\)` then `\\`). The driver emits `grant_applied` and
  the orchestrator consumes the grant: it's for that run only;
- anything else (other tools: `Edit(path)` or `WebFetch(domain:…)` would allow more than the
  one call; Bash commands the rule can't match exactly) stays with the prompt tool, which
  consumes the grant for exactly that call. In auto mode the prompt tool is never asked about a
  classifier denial, so such a run uses `acceptEdits` instead, with the notice "Claude Code
  can't pre-approve … so this turn runs in ask mode". A call whose exact rule was passed and
  still denied is remembered (in memory) and its next grant goes this way (`viaPrompt`).
  The ticket is still in auto mode, so every other call the CLI then asks the prompt tool about
  (`ApprovalMeta.viaPromptTool`) goes through the harness classifier (`PermissionGate.judge`)
  before a human, the same way as for native-tool drivers: allow → runs, soft_deny → denied to
  the agent and deferred, hard_deny → denied. Without this, one "Allow once" on a piped command
  sent every later `cat` or `ls` in that run to a human (MEDL-1).

Measured against claude 2.1.283 (`--permission-mode dontAsk` to isolate rule matching, then
auto): `Bash(<cmd>)` with spaces, quotes, `&&`, `;`, `||`, backticks, escaped parens and
backslashes matches exactly; an exact rule overrides auto mode's classifier. No match for
pipelines (checked per segment), globs (`*` makes the rule a wildcard; `\*` didn't match
either), redirections (`>`, `2>/dev/null`) or `$(…)`; multi-line commands and a trailing
backslash aren't risked. Auto mode also strips allow rules it treats as arbitrary code
execution before its classifier runs: bare `Bash` and `Bash(npx:*)` had no effect (they work in
ask mode). One-time grants match on tool + canonical input; a Bash call's `description`,
`timeout` and `run_in_background` are ignored (the model changes them on a retry). A matching
one-time grant is consumed before `allowedTools` is checked. A grant is for the run it's handed
to: when that run succeeds, whatever it didn't consume is dropped (the CLI doesn't always ask:
acceptEdits runs read-only Bash itself, so a leftover grant would keep every later run in ask
mode). A failed or cancelled run's grants carry over to the next run.

**PermissionGate** (`service/src/permissions/gate.ts`) for bash, write_file, edit_file and
read_file/list_files, per call:
1. Static policy: hard-deny patterns (`permissions/bash.ts`: recursive rm/chmod of `/`, `~`,
   system dirs; download piped into a shell/interpreter; force-push or delete of main/master;
   disk formatting; fork bombs) → deny in every mode. Read-only bash (a conservative allowlist:
   ls, cat, rg, grep, find without -delete/-exec, git status/diff/log/…; any `$`, backtick,
   subshell, redirect to a file, env prefix or unknown command falls through) → allow. Reads
   inside the workdir → allow (not logged). Workdir checks resolve `..`, `~` and symlinks.
2. `read_only` → deny anything else (grants don't apply).
3. Edits inside the workdir (not `.git/`) → allow.
4. Human grants (`ticket.allowedTools`, one-time grants) → allow.
5. `ask` → `requestApproval` (source `policy`). `auto` → the classifier (`judge`): `allow` →
   run; `soft_deny` → denied to the agent with the reason and a nudge to find a safer way
   (`CLASSIFIER_DENIED…`), and recorded as a run denial (`GateEnv.defer`), so it becomes a card
   only if the run ends stuck on it (see "Classifier denials"). Without `defer` (a context with
   no active approvable run) it goes to `requestApproval` with the classifier's reason (source
   `classifier`). `hard_deny` → deny with the reason. Timeout (60s), error or
   `classifier: "off"` → `requestApproval`, never allow.

Every decision on a gated call is appended as a transcript status entry with
`content.permission` (tool, input summary, decision allow/ask/deny, reason, source,
backend, latency, mode): "Auto-approved: git init — …". Approval cards show
`pendingApproval.reason` / `source`. `requestApproval` refuses outright in `read_only`.

**Classifier** (`permissions/classifier.ts`, `settings.classifier`): `claude-cli` (default) runs
`claude -p --model sonnet --output-format json --json-schema {decision, reason} --tools ""
--permission-mode dontAsk --strict-mcp-config --no-session-persistence --system-prompt-file …`
in the workdir (dontAsk rather than plan: plan mode's context made the model reason about plan
mode); `anthropic-api` calls the Messages API with the stored key and a forced `decide` tool;
`off` asks a human. The system prompt carries Claude Code's auto-mode rules from `claude
auto-mode config` (environment, allow, soft_deny, hard_deny; cached in
`$HARNESS_HOME/auto-mode-rules.json`, refreshed daily or when `~/.claude/settings.json`
changes; a built-in summary when the CLI is missing). The user turn has the tool call, cwd,
run kind, ticket title + spec and the last 16 transcript lines. Measured: 4–9 s per call
(`--effort low` is ~4 s but judged more harshly, so it isn't used).

Migration 4 maps the old `claudePermissionMode` setting: `acceptEdits`/`bypassPermissions` →
`ask`, `auto` → `auto`, `dontAsk` → `read_only` (dontAsk denied every write that wasn't
pre-approved). PATCH /settings still accepts `claudePermissionMode` from older clients.

Real checks (not `bun test`): `service/scripts/permissions-classifier-check.ts`,
`service/scripts/claude-code-permissions-check.ts`,
`service/scripts/claude-code-classifier-approval-check.ts` (a whole harness on a temp home and
random port, sonnet in auto: `npx -y <missing package> init` from a README is denied
[Code from External] → card → allow_once → the retry runs under the exact rule; `curl … | sh`
→ card → allow_once → the retry runs in acceptEdits through the prompt tool). Run them from a
clean `env -i HOME="$HOME" PATH="$PATH" USER="$USER"` shell.

### Models

Every driver implements `listModels(): Promise<ModelInfo[]>` (`{ id, name, description?, default? }`),
served as `GET /drivers/:id/models[?refresh=1]` → `DriverModels { driverId, models, error, fetchedAt }`.
The orchestrator caches each driver's list for 10 min (failures for 30 s, returned as `models: []`
or a fallback list plus `error`, never an HTTP error); `?refresh=1` re-queries, a login or API-key
change invalidates. `GET /drivers` does not include models (listing can spawn the CLI).

- **claude-code** asks the CLI itself: `claude -p --input-format stream-json --output-format
  stream-json --verbose`, write one `{"type":"control_request","request_id":…,"request":{"subtype":
  "initialize"}}` line, read until the matching `control_response`, kill the child. Its
  `response.models` (`value`, `displayName`, `description`, `resolvedModel`) is what `/model` shows,
  already filtered by the org's `availableModels`. No user message is sent, so no tokens are spent
  (SessionStart hooks do run). The synthetic `default` entry is dropped and the model it resolves
  to is marked `default`. On failure: the aliases `sonnet`, `opus`, `fable`, `haiku` plus the error.
- **anthropic-api**: `GET /v1/models` (SDK `models.list`, all pages) with the stored key; no key →
  error. Default model when none is chosen: `claude-sonnet-5`.
- **github-copilot**: the `model` list in `copilot help config` (no tokens spent), after `auto`
  (Copilot picks), which is the default. On failure: a short built-in list plus the error.
- **dummy**: `dummy-fast` (default) and `dummy-slow` (10× the per-word delay, ≥ 50 ms); any other
  model fails the run.

Which model a run uses is resolved when the run starts (`orchestrator/models.ts`), first set wins:
review runs → `settings.reviewModels[driver]`; `ticket.model`; `project.defaultModels[driver]`;
`settings.defaultModels[driver]`; else `null` (the driver's own default). It reaches the driver
as `RunRequest.model` (claude-code `--model`, anthropic-api `model`). Changing a ticket's model
applies from its next run; claude-code resumes the same conversation with the new `--model`
(verified against the real CLI). Changing a ticket's driver clears its model. Both settings maps
and `project.defaultModels` PATCH-merge per driver (`null` clears one). Migration 3 moved the old
`claudeModel` / `anthropicModel` settings into `defaultModels`.

Triage runs have no ticket or project, so they resolve through the watcher instead. The driver is
fixed when the triage session is created: `watcher.driver`, else `settings.watcherDriver`, else
`settings.defaultDriver` (injected output has no watcher and starts at `settings.watcherDriver`).
The model is resolved when the run starts: `watcher.models[driver]`, then
`settings.watcherModels[driver]`, then `settings.defaultModels[driver]`, else `null`
(`watcherDriver` / `watcherModel` in `shared/src/watchers.ts`). The triage session's meta keeps the
watcher id, so a model edit applies to the watcher's next run. `watcher.models` and
`settings.watcherModels` PATCH-merge per driver like the other maps (migration 15 added the column).

### Sub-agents

A sub-agent is an agent a run's agent starts inside its own session (Claude Code's `Agent` tool,
`Task` on older CLIs), not a ticket. It shares the session and the run, and it reports back to
the agent that started it. The apps show them on the ticket's **Agents & tasks** tab, together with
the run's background tasks (see "Background tasks" below).

**Driver contract** (`service/src/drivers/types.ts`, driver-agnostic). A driver that runs
sub-agents reports each one with `{ type: "subagent", subagent: SubagentReport }`: an id unique
within the session (the id of the tool call that started it), and whatever it knows of
`parentId` (nested agents), `description`, `agentType`, `prompt`, `status` (`running`,
`succeeded`, `failed`, `stopped`) and `result`. The first report creates the sub-agent, running
unless it says otherwise, and later reports fill in the fields they carry. Once it has finished,
later reports can add a missing result but never change its status. `text`, `thinking`,
`tool_call`, `tool_result` and `permission` events carry `subagentId` when a sub-agent produced
them. Drivers without sub-agents (anthropic-api) never send any of this.

**Orchestrator.** Reports upsert the `subagents` table (migration 11, keyed by session + id) and
emit `subagent.upserted` when something changed. Tagged entries are stored with
`transcript.subagent_id`. They share the session's seq, so `after` paging works in either view.
When a run ends (or a stale run is recovered on boot), its sub-agents that are still running
become `stopped`. A sub-agent's text never becomes the run's `lastText`, so it isn't the
auto-submit note. Its classifier denials are logged in its own transcript but never become the
ticket's pending approval, because the sub-agent reports the denial to its agent.

**Reading them.** `TicketDetail.subagents` (oldest first), `GET /sessions/:id/subagents`, and
`GET /sessions/:id/transcript?subagent=<id>` (404 for an unknown id). The plain transcript route
and the board's `get_ticket` transcript tail leave sub-agent entries out, so older clients see
the same session transcript as before.

**claude-code** (verified against claude 2.1.283). An `Agent`/`Task` tool call starts a sub-agent
(`description`, `subagent_type`, `prompt` from its input; `parentId` is the call's own
`parent_tool_use_id`). Stream messages with `parent_tool_use_id` set are that sub-agent's output.
Its streaming deltas are dropped because the full blocks follow. Agents run in the background by
default: the tool result only says `Async agent launched…`, and the outcome arrives later as a
`system` `task_notification` (`tool_use_id`, `status`, `summary`) or `task_updated` (by
`task_id`, mapped from `task_started`), inside the same `claude -p` process (the CLI takes
another turn after the notification). A foreground agent's tool result is its outcome.
`task_started` for other task types (background Bash, Monitor) doesn't make a sub-agent: the
driver tracks it as a running task (see "Drivers"), and one that stays in the background is a
background task (below). Only conversation messages
(`assistant` / `user`) under a `parent_tool_use_id` are a sub-agent's output: anything else is
the tool's own progress, like the `tool_progress` heartbeat a Bash call sends every 30 s while
it runs, and is dropped. Output from a sub-agent the parser didn't see start creates one called
"Sub-agent", unless that id is a known call of another tool. Migration 13 deleted the empty
"Sub-agent" rows those heartbeats created before this was fixed.

**Apps** (`@harness/shared/state` `subagents.ts`, `tabs.ts`). State keeps `subagents[sessionId]`
and each sub-agent's transcript under `transcriptKey(sessionId, subagentId)` (`<session>/<id>`).
The Agents & tasks tab (route id `agents`) exists only once the session has a sub-agent or a
background task: until then (and on a session without any) the tab is hidden, and `agents` or
`agent:<id>` fall back to the Spec, while the requested tab is kept so a deep link opens when
they arrive. It lists sub-agents and tasks in one list, the latest updated first
(`sortSubagents`: `updatedAt` desc, then `startedAt` desc). A row opens the tab `agent:<id>`: a
sub-agent's transcript, with its task above it and a breadcrumb back through its parents, or a
task's output view. An unknown id falls back to the list. In every transcript, a tool row that
started a sub-agent links to its transcript ("Open transcript"), and one that started a task to
its output ("Open output").

#### Background tasks

A background task is a Bash command or a Monitor the agent left running: `Bash` with
`run_in_background`, a Bash call the CLI moved to the background after its 120 s timeout, or a
`Monitor`. A foreground call never is one, even a long one the CLI reports with `task_started`,
since the transcript already shows it. Tasks are `subagents` rows of their own `kind` (`bash` or
`monitor`; `agent` for sub-agents, absent from older services), so they reuse the sub-agents'
store, events, stop-at-run-end, tab, count, live dot and `agent:<id>` routes. They have no
transcript of their own. Older apps list them like a sub-agent with an empty transcript.

**claude-code** (verified against claude 2.1.286). The parser reports a Bash or Monitor call as a
task once it knows it's in the background: `task_started` says `is_backgrounded: true`, or the
tool result is a "Command running in background with ID: …", "…moved to the background (ID: …)"
or "Monitor started (task …" notice. The task's id is the call's id; its `description` is the
call's `description` input, else the `task_started` description, else the command; `command` is
the input's. The output file comes from the result's "Output is being written to: <path>" or the
`task_notification`'s `output_file`. A Monitor's result names only its task, so its file is taken
to be next to an earlier task's (`<dir>/<task>.output`), else in the CLI's layout,
`<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<cwd, non-alphanumerics as "-">/<session>/tasks/<task>.output`.
`task_notification` (or a terminal `task_updated`, found by task id) sets its status through
the same mapping as an agent's, with the notification's `summary` as `result`. A sub-agent's own
background commands aren't the session's tasks.

**Store** (migration 22). `subagents` gains `kind`, `command`, `output_path` (service-side only;
clients see `hasOutput`) and the kept output: `output` holds the raw tail of the file (up to
256 KB) from byte `output_start` of `output_size`. The output path is set once and never moved.
When a task finishes (a finishing report, a run's stop, a stale run's recovery), the orchestrator
copies the tail of its file into `output`, because the CLI's files live in /tmp and don't survive
a cleanup or a reboot. A later report takes it again while the file is there: the CLI sends the
terminal `task_updated` before the `task_notification`, and the file's last line ("[exited with
code 0]") may land in between.

**Output** (`service/src/task-output.ts`). `GET /sessions/:id/subagents/:subagentId/output?offset=N`
→ `TaskOutput { text, start, end, size, done, available }` (offsets in bytes; 404 for an unknown
id or a sub-agent, 400 for an offset that isn't a whole number). Without `offset` it sends the
tail, up to 256 KB; with one, what follows it, skipping ahead to the tail when more than 256 KB
came in since (a gap: `start` > the offset asked for). A running task's read stops before a
UTF-8 character or a terminal escape sequence that's cut off, so the next read picks it up, and
a tail starting mid-file skips to a whole character. Escape sequences are stripped from the text.
Once the task has finished it reads from the kept tail. The path the stream named must resolve
(realpath, so symlinks count) inside `claude-<uid>` under /tmp, `$CLAUDE_CODE_TMPDIR` or the OS
temp folder; anything else reads as `available: false`.

**Apps.** Output isn't pushed over the socket: the service would still have to poll the file and
send every chunk to every client. A task's view reads the tail when it opens, then polls with
`offset = end` every `TASK_OUTPUT_POLL_MS` (1 s) while the task runs, and once more when it
finishes. State keeps it in `taskOutputs[transcriptKey(session, id)]` (`mergeTaskOutput`): a slice
starting where the text ends is appended, a repeated one only updates `done`, and anything else
(the first read, a gap) replaces it, marked `truncated` when it doesn't start at 0. A client keeps
at most `TASK_OUTPUT_KEEP_CHARS` (512 K characters), dropping the oldest lines past it. The view
shows the command, the output (following the end until the user scrolls up), and the result.

### Prompt overrides

Every agent prompt is a template in `service/src/orchestrator/prompt-templates.ts` under a stable
id (`PROMPT_IDS` in protocol.ts): `system.*` for the sections of a run's system prompt (intro,
context, lifecycle, the per-run-kind instructions, children, branches, files, spec, file links, board,
board changes, config, approvals, browser) and `run.*` for the message that starts a run (work
and conductor start, review, the three completions, conductor update, changes requested, reopen,
triage). `system.complete` and `run.complete` were renamed `system.complete_merge` and
`run.complete_merge` when the pull request and custom completions arrived (`RENAMED_PROMPT_IDS`):
migration 18 moves stored overrides to the new ids, and settings read or sent under an old id apply
to the new one. `system.summaries` became `system.spec` ("Spec and Activity") with different
instructions, so migration 26 drops a saved `system.summaries` override instead of moving it, and
at startup the service logs a warning for each saved override that still names `update_plan` or
`post_summary`.
`prompts.ts` works out each template's variables from the run (child lists, the recent Activity lines,
tool names and the fenced triage output are computed there), decides which sections a run gets,
and joins them in order; none of that is overridable.

`settings.prompts` maps id → template or null. Every id defaults to null, which means the
built-in text that ships with the service, so an uncustomized install picks up prompt changes on
update. PATCH /settings `{ prompts }` merges per id, and null or `""` resets one. The service
refuses unknown ids, malformed templates and variables the prompt doesn't have with a 400, except
for an override sent back exactly as stored (clients echo whole settings objects). Stored ids
that no longer exist are dropped when settings resolve. A stored override that no longer
validates (a variable the prompt lost in an update) is kept for the user to fix, reported as
`overrideError` by `GET /prompts`, and ignored at render time in favour of the built-in.

Templates (`shared/src/templates.ts`) have `{{name}}`, `{{#if name}}`, `{{else if name}}`,
`{{else}}` and `{{/if}}`, with a non-empty string, true or a non-zero number as truthy. Text
outside tags is copied exactly, and the rendered prompt is trimmed at both ends; a section that
renders to nothing is left out. Values are inserted as text and never re-parsed.

`GET /prompts` (`HarnessClient.listPrompts`) returns `PromptEntry[]` in `PROMPT_IDS` order:
`{ id, group, label, description, variables: [{ name, description }], builtin, override,
overrideError }`. The settings screens edit `override` starting from `builtin`.
`prompts-builtin.test.ts` snapshots the built-in output for a matrix of inputs, so a template
edit that changes a built-in prompt shows up as a snapshot diff (`bun test --update-snapshots`
after an intended change).

### Dummy driver script

Streams its text word by word (`HARNESS_DUMMY_DELAY_MS`, default 15ms; tests use 0).
Directives are read from the run prompt:

| Kind | Behaviour |
| --- | --- |
| plan | text `Here's a plan for: <first line>` + numbered steps; calls `read_spec`, then `update_spec` with the plan (note "Plan drafted") at the revision it read |
| work | text `Hello from the dummy driver! You said: "<prompt>"`; then: `/block <q>` → `block`; `/fail <msg>` → error; `/browse <url>` → `browser_open` + `browser_content`; `/bash <cmd>` → `bash` if present (through the PermissionGate, so the permission flow runs offline; tests inject a fake classifier); `/tools [{"name":…,"input":{…}},…]` → calls those harness tools in order, stops at the first error and keeps the rest in driver state; a later prompt with "Retry it now" (an answered approval) repeats from the failed call, then `submit_for_review`; `/agents [n]` → n sub-agents (default 2, at most 5; from three on, the last is started by the one before it), each an `Agent` call, `subagent` reports and tagged text + a `Read` call, then `submit_for_review`; `/bgtask [n]` → a background `Bash` call (`run_in_background`) with its "Command running in background" result and a `bash` task report whose output file (under `/tmp/claude-<uid>/harness-dummy/<run>/`) gets `line 1`…`line n` (default 20, at most 500), one every 20× the word delay, every fifth in color, then the task's `succeeded` report and `submit_for_review`; `/child <title>` → `create_ticket` with `child: true`, then the run ends without submitting; a `conductorUpdatePrompt` ("Child ticket updates:…") steers like a later conductor run; `/approve <tool> [json input]` → `permission_prompt` (→ `requestApproval`, the same path claude-code uses; the dummy driver has `usesPermissionPromptTool`), then on allow text `Approved <tool>` + `submit_for_review`, on deny the run just ends; otherwise `post_note` + submit. Every submit here first calls `read_spec` and `edit_spec`, replacing the body of `## Status` (up to the next heading, with `expected` set to it) with one `* <note>` line, or adding the section when the spec has none; a run started by requested changes notes "addressed the review notes", then `submit_for_review` with `spec_is_up_to_date: true` |
| review | calls `review_decision` approve, or request_changes when the prompt contains `[dummy:reject]`, or `[dummy:reject-once]` on round 1 only (a prompt without "Earlier review rounds") |
| chat | text `(dummy chat) You said: "<message>"` (without the blocked note); `[dummy:unblock]` → `unblock`, `[dummy:resume]` → `resume_work`, then `[dummy:block]` → `block` or `[dummy:submit]` → `submit_for_review` |
| complete | text + `post_note("Completed.")`; a `pr` completion first calls `record_pull_request` with a made-up `https://github.com/example/dummy/pull/<n>` (or the ticket's existing URL) |
| conductor | first run: creates one child per `- ` bullet in the prompt (default two, second depends on first); later runs: approve (`review_ticket`) children whose agent review approved (or was skipped) and human review pending, `complete_ticket` approved ones, `submit_for_review` when all done |
| triage | the project is the `[dummy:project KEY]` in the watcher's prompt section (never the output); the key (remote ID) is the first `KEY-123` in the fenced output, and a `[dummy:ticket KEY]` in the prompt section passes `ticket_key`. A `[dummy:dispatch-if /re/flags]` rule in the watcher's prompt decides by itself: output matching the regex → `dispatch_ticket(start: true)` to the project, anything else → `decline_work`; only the fenced output is matched. Without a rule: `[unscoped]` in the output → `decline_work`; no project in the prompt → decline; `[big]` → `dispatch_ticket` with `conductor: true`; else `dispatch_ticket(start: true)` with the key, the project and the `Inbox title` |

## HTTP API

All routes require `Authorization: Bearer <token>` (WS: `?token=`), except `GET /health` and
the static plugin UIs under `/plugins/:id/ui/`. `GET /attachments/:id` also takes the token as
`?token=`, because `<img>` and `<video>` can't send headers; no other HTTP route reads it from
the query. That holds for loopback and remote clients alike;
`/mcp/:runToken` is additionally refused (403) to anything but loopback.
Responses are `{ data }` or `{ error }` with a 4xx/5xx status.

```
GET    /health                   → { ok, version, pid, build, stale }; 503 while shutting down (see "Service updates")
POST   /service/restart          → { ok }; exits so its supervisor restarts it (409 when unsupervised)
GET    /projects                 POST /projects            PATCH/DELETE /projects/:id
GET    /projects/:id/files?q=&limit=50&ignored=1&kind=file   GET /tickets/:key/files?…   → FileMatch[] (@-mention autocomplete; ignored/kind for the file browser)
GET    /projects/:id/commands?q=&driver=&limit=50   GET /tickets/:key/commands?q=&limit=50   → CommandMatch[] (/command autocomplete; see "Slash commands")
GET    /projects/:id/file?path=   GET /tickets/:key/file?path=   → FileView (see "File viewer")
GET    /projects/:id/file/diff?path=   GET /tickets/:key/file/diff?path=   → FileDiff (409 outside a git repo)
GET    /projects/:id/branches?q=&limit=50   → BranchInfo[] (branch picker; see "Branches")
GET    /tickets?projectId=&status=planning,review   POST /tickets {spec, …}   (no status = every ticket)
GET    /tickets/page?status=done&projectId=&group=&q=&limit=50&cursor= → TicketPage
GET    /tickets/search?q=&projectId=&group=&limit=100&cursor=       → TicketPage
GET    /tickets/:key             PATCH/DELETE /tickets/:key      → TicketDetail / Ticket
PATCH  /tickets/:key {spec, baseRevision, specNote?, …}   (baseRevision required with spec outside drafts → 400; stale → 409, data SpecConflict)
POST   /tickets/:key/start | /messages {text, move?, attachments?} | /review | /reopen | /complete | /cancel | /agent-review
PUT    /tickets/:key/message-draft {text, attachments?, origin?}   → Ticket (see "Message drafts"; empty clears it)
GET    /tickets/:key/activity    → ActivityEntry[] (oldest first)
GET    /tickets/:key/spec/revisions        → SpecRevisionInfo[] (oldest first, no bodies)
GET    /tickets/:key/spec/revisions/:rev?diff=<other>   → SpecRevision, or SpecDiff with diff
GET    /attachments/:id          (any attachment's file; bearer or ?token=; HEAD too; Range → 206; 404 unknown id or gone)
POST   /attachments {path, name?}   (register a file already on the service's machine → Attachment; see "One attachment model")
POST   /uploads?name=        (raw bytes → Attachment under uploads/; see "One attachment model")
GET    /tickets/:key/prompt-attachments/:index   (legacy, for older iPhone apps: a prompt attachment by index)
GET    /transcript/:entryId/attachments/:index   (legacy, for older iPhone apps: a message's file by index)
GET    /browser/:sessionId/screenshot?tab=       → BrowserScreenshot (a PNG of the tab's viewport; see "Annotations")
POST   /browser/:sessionId/element {tabId, x, y, url, scroll}   → BrowserElement | null (see "Annotations")
GET    /sessions?kind=           GET /sessions/:id         GET /sessions/:id/transcript?after=seq&subagent=
GET    /sessions/:id/subagents   → Subagent[]       GET /sessions/:id/subagents/:subagentId/output?offset= → TaskOutput
GET    /watchers                 POST /watchers            PATCH/DELETE /watchers/:id
POST   /watchers/:id/run         POST /watchers/inject { source, text, prompt? }
GET    /drivers                  POST /drivers/:id/login   GET /drivers/:id/models?refresh=1
GET    /settings                 PATCH /settings           (PATCH { listen } rebinds live; 409 keeps the old binding)
GET    /prompts                  → PromptEntry[] (see "Prompt overrides")
GET    /network                  → NetworkStatus           GET /pairing → PairingInfo (409 in localhost mode)
POST   /token/rotate             → { token }; the old token is rejected at once, open sockets closed
GET    /browser/:sessionId?tab=  POST /browser/:sessionId/navigate { url, tabId? }  (a tab that isn't open: GET → null, POST → 404)
GET    /plugins                  GET /tickets/:key/tabs    → PluginInfo[] / PluginTab[]
*      /plugins/:id/api/*        (plugin routes, bearer auth)
GET    /plugins/:id/ui/*         (plugin static UI, no auth)
POST   /mcp/:runToken            (MCP streamable-HTTP, JSON responses; run-scoped token)
GET    /ws?token=                (WebSocket; ServerMessage / ClientMessage)
```

Every mutation emits a `HarnessEvent`; the WS forwards all events to every client, except
`browser.frame`/`browser.state`, which go only to clients subscribed to that session. A new
Activity entry is `activity.added { entry }`; a new spec revision is `spec.revised { ticketId, rev,
author, note, runId, runKind, createdAt }`, followed by the `ticket.upserted` that carries the new
body.

### Browser tabs

Each session's browser (`service/src/browser/manager.ts`) holds numbered tabs, each a Chrome page
target in its own headless window (so every tab paints and can screencast). Numbers count up from
1 per session and are never reused, so a number an agent holds can't come to mean another page.

- **Which tab a call acts on.** Every `BrowserService` call takes `{ tab? }`. An explicit tab that
  isn't open throws `No browser tab N. Open tabs: …` and never opens one; without `tab` it is the
  lowest open tab, created as the next number when the session has none. `open { newTab }` always
  makes a new one. That default never moves on its own (no "current tab" that one caller's action
  could shift under another), so parallel sub-agents that each pass their own tab can't collide.
- **Popups.** A page target whose `openerId` is one of a session's tabs (`target="_blank"`,
  `window.open`) is attached as that session's next tab. A page that closes itself drops its tab.
- **Viewers.** Each view of a session's browser is one subscriber and watches one tab:
  `browser.subscribe { tabId?, viewerId? }` (again with another `tabId` switches; again without
  one is a no-op). `viewerId` names the view, so one socket can hold several viewers of a session
  (the ticket's Browser and torn-off browser tabs beside it, each streaming its own tab): the
  manager's subscriber id is `<socketId>:<viewerId>`, `browser.frame`/`browser.state` sent to that
  subscription carry the `viewerId` (clients filter with `isBrowserEventFor`), and
  `browser.unsubscribe { viewerId }` drops only that one. The desktop's `BrowserView` uses its
  pane's leaf id. Without a `viewerId` a socket is one viewer, as older clients expect. A
  subscriber whose tab closes falls back to the lowest open tab. Only watched tabs
  screencast. `browser.state` carries the watched tab's url/title/loading as `tabId` plus every
  open tab in `tabs`, and goes to every subscriber whenever any tab changes, since all of them
  draw the tab strip. A subscriber that has just moved to a tab gets its state and then its last
  frame; frames carry `tabId` so a client drops in-flight frames from the tab it left.
- **Viewer input.** `browser.input { tabId?, viewerId? }` without a tab goes to that viewer's
  watched tab. `newTab { url? }` opens a tab and moves that viewer to it; `closeTab` closes the input's tab, and
  closing the last one while anyone watches leaves a blank tab in its place. The size inputs are
  below.
- **Sizes.** Each tab has its own `BrowserSize { device, width, height, responsive }`
  (`BrowserState.size`, `BrowserTab.size`), so an agent can keep one tab on desktop and another on
  a phone. New tabs start as desktop and Responsive at `BROWSER_DESKTOP` (1280×800), so a page
  fills the pane of whoever has it open, as the browser always did; a popup opens in its opener's
  mode and size. `device` is the input mode: `"desktop"` is Chrome's own mouse and user agent;
  `"mobile"` sets `setDeviceMetricsOverride { mobile: true }` (so `<meta name="viewport">` applies,
  and a page without one lays out 980 wide and is shown shrunk, as on a phone), touch emulation
  (`pointer: coarse`, touch events) and `BROWSER_MOBILE_UA` (iOS Safari). On a mobile tab, mouse
  presses (a viewer's left button, an agent's `click`) are sent as `Input.dispatchTouchEvent`
  touches, which the page turns into the click a phone makes; hover moves are dropped and the
  wheel still scrolls. (Chrome's `setEmitTouchEventsForMouse` is not used: the mouse presses it
  converts never answer `Input.dispatchMouseEvent`.) The width and height are free in either mode,
  clamped to 100–4096, and `deviceScaleFactor` stays 1. The inputs:
  - `device { device }` (the Desktop | Mobile buttons): that mode at its preset size
    (`BROWSER_DESKTOP`, `BROWSER_MOBILE` 393×852), Responsive off, and the page reloads so the
    server sees the user agent too, even when the mode didn't change (the button is a reset).
  - `size { width, height }` (the width × height inputs): keeps the mode, Responsive off, no reload.
  - `responsive { on, width?, height? }` (the switch): on, the tab takes the sender's stage size
    and follows it; that subscriber becomes the owner, and the last to switch it on wins. Off keeps
    the size.
  - `resize { width, height }` is a viewer's stage size. It counts only from the owner while
    Responsive is on and is dropped otherwise, so opening a pane never resizes a tab (older apps
    keep sending it and just see the tab's size).
  The owner gets `BrowserState.sizeOwner: true` (every other viewer `false`). A Responsive tab
  without an owner (a new tab, or its owner unsubscribed, switched tabs or its socket closed) is
  handed to the newest viewer watching it (`refresh`), which then sends its stage size; with nobody
  watching, it keeps its size and stays Responsive for the next viewer. An agent that needs a size
  that holds still sets one, which turns Responsive off. Agents set sizes with `browser_open { device?, width?, height? }` (applied before the page
  loads, so no reload) and `browser_resize`; either one ends a viewer's Responsive, like a button.
  Nothing records who opened a tab: "resize your own tabs" is guidance in the run prompt. Both
  apps keep the controls for the tab on screen in a size row under the URL bar, shown or hidden by
  a Size toggle beside Annotate (remembered); the bar itself has only back, forward, reload, the
  URL and those icon buttons, and + sits at the pinned right end of the scrolling tab strip. Both draw the frame letterboxed, and a pinch (a trackpad pinch, `wheel` with `ctrlKey`,
  on the Mac) zooms the drawn frame 1–4× and pans it (`shared/src/state/browserZoom.ts`, ported to
  HarnessKit's `BrowserZoom`), so a desktop page shrunk onto a phone stays usable; the page never
  sees the pinch, and input maps through the zoomed frame.
- **Page info.** Each live tab keeps, since its main frame last navigated, its last 100 network
  requests (`Network.enable`: method, URL, type, status, failure, duration) and its last 50
  console errors and warnings and uncaught exceptions (`Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`). `tabs()` adds each tab's failed-request (failed, not canceled, or
  status ≥ 400) and console counts; `tabInfo(sessionId, tab)` returns them in full with the scroll
  position, for `browser_tabs { tab }`. A suspended tab reports its stored URL, title and size.
- **Suspended tabs.** A tab outlives its Chrome page, since Chrome runs with background throttling
  off and every leftover page keeps its timers and rendering going. A suspended tab keeps its
  number, URL and title with no page (`BrowserTab.suspended`, and `BrowserState.suspended` for a
  viewer on one). It still counts as open: `tabs()` lists it, a call without `tab` uses the lowest
  tab whether live or suspended, and `closeTab` (or deleting the session) is the only way a tab goes.
  Watching a suspended tab or any call on it reopens a page under the same number on the stored URL
  (an agent's call waits for it to load; `open` skips the reload and navigates). Tabs are
  suspended when:
  - **Idle.** `reapIdleTabs` (swept every 30 s) suspends any tab nobody watches that no agent call or
    viewer input has used for `browserIdleTabMinutes` (Settings, default 5, 0 = never). `lastUsed`
    is set when a page opens, whenever a call resolves to the tab, on viewer input, and when a viewer
    leaves it (unsubscribe or a switch), so the countdown starts once nobody is looking.
  - **Done.** A ticket that moves to done gets `suspendTabs(sessionId)` (from
    `Orchestrator.transition`). Tabs nobody watches are suspended at once. The session is marked
    retired, so a watched tab is suspended as soon as its viewer leaves, until an agent call on the
    session (a re-opened ticket) clears the mark. Other column moves leave tabs alone.
  - **Chrome goes away.** A crash, a Chrome that died, or the service stopping suspends every tab,
    and a page that closes itself (`window.close()`) removes its tab.
  A refresh reopens any suspended tab someone watches, so a viewer is never left on a page-less tab.
- **Storage.** Each session's tabs are kept in the `browser_tabs` table (one row per session: the
  next tab number and every tab's id, URL, title and size (`{ device, width, height, responsive }`,
  never the owner, which is a live viewer; a missing or broken one loads as a new tab's) as JSON,
  deleted with the session). Writes
  follow every state change (navigation, in-page navigation, title changes), coalesced 200 ms, and
  `shutdown` flushes them. After a restart a session's entry is loaded on first use with every tab
  suspended; listing tabs doesn't start Chrome.
- **Stopping Chrome.** Once no tab in any session has a page and nothing is opening one
  (`stopChromeIfIdle`, run 5 s after a suspension or close, and on every sweep), Chrome is closed
  gracefully. The next call that needs a page relaunches it, waiting for the old one to finish
  exiting since both use one profile.
- **Compatibility.** `tabId`/`tabs` are optional on the wire: older services omit them and the
  apps then show no strip; older apps omit `tabId` and keep seeing the lowest open tab.

### Browser waits and scripts

Agents wait for a page instead of sleeping, and run multi-step flows as scripts (HARNESS-278).

- **One wait.** `WaitCondition` (`browser/wait.ts`) is `{ selector?, state?: visible | hidden |
  gone | enabled, text?, url?, idle?, timeout? }`, every field given holding at once, and
  `BrowserManager.waitFor` is its only implementation. It polls every 100 ms with a fresh
  `Runtime.evaluate` (never one long in-page promise), so a navigation costs a tick, not the wait.
  `enabled` is visible and not `:disabled`, `aria-disabled` or inside `[aria-busy=true]`; `idle`
  is no main-frame loading and no request in flight for 500 ms, ignoring WebSockets, EventSource
  and requests open over 5 s. The timeout is 15 s by default, at most 120 s. A timeout returns
  (never throws) a report: the URL, loading, `aria-busy` count, the last check's counts, requests
  in flight and console errors seen while waiting. A selector that doesn't parse fails at once.
- **Where it runs.** `browser_open`, `browser_click`, `browser_type` and `browser_resize` take
  `wait_for` and wait after acting; `browser_screenshot`, `browser_content` and `browser_eval` wait
  before reading. `browser_wait` is the wait alone. `wait_for` is checked before the tool acts. A
  timed-out wait makes the result an error that still carries what the tool did or read (a
  screenshot is taken anyway). The wording of the condition (`WAIT_CONDITION_DOC`) is shared by
  the tool descriptions and the Browser prompt section, and a prompt test checks the section names
  exactly the tools whose schema has `wait_for`.
- **Page events.** `BrowserService.watch(sessionId, listener)` streams each tab's console (every
  level), uncaught exceptions, main-frame navigations, failed requests (not canceled ones; status
  400+) and closes, for scripts' logs and waits' reports.
- **Scripts.** `browser_run` (`tools/browser-run.ts`) writes the script, wrapped as
  `export default await (async () => {…})()` on its first line so its line numbers hold, to the
  run's scratch folder and starts it in its own process: `bun browser/script-child.ts <file>`
  in a checkout, `harness-service browser-script <file>` in Harness.app. The child has no CDP: its
  globals (`click`, `type`, `wait`, `evaluate`, `content`, `screenshot`, `open`, `resize`, `url`,
  `log`, `sleep`) send calls over Bun IPC, and the service runs each through the browser tool of
  the same name with the job's tab, so waits and errors behave exactly as for the agent. A failed
  call rejects in the script with the tool's text and a stack made at the call site.
- **Jobs.** One running job per tab. A job's log (at most 2,000 lines kept) holds its start,
  each step and its result, the script's `console.*`/`log()` and raw stdout/stderr, and the tab's
  page events. `browser_run` blocks up to `wait` s (default 20, max 60) or until the job ends;
  `browser_run_status` blocks until a new line (gathering 300 ms more) or the end; each returns
  the lines since the last report (at most 200). A failure, or the timeout (default 120 s, max
  600 s), records the script line (from the stack), the failed step, the URL and a screenshot
  saved to the scratch folder. Jobs are killed at their timeout, by `browser_run_stop`, when their
  tab closes, when the run's signal aborts, and when the run ends (`stopBrowserJobs` in the run's
  `finally`). The log is mirrored to the transcript as status lines, batched each second, up to
  300 lines a job (`HarnessOps.statusLine`). There is no MCP progress: the model doesn't see
  `notifications/progress`, and polling works on every driver.

### Activity

Activity is a ticket's at-a-glance progress, one line per entry: the Activity tab next to the spec,
the news line on its board card and in a conductor's Tickets tab, search's latest note, and the
last few entries in every run's prompt. It replaced summaries (migration 26 turned each summary
into a `note` entry). An `ActivityEntry` is `{ id, sessionId, ticketId, kind, author
(agent/human/system), body (one line of markdown), meta, createdAt }`, stored in `activity` (`meta`
as JSON) and listed oldest first by `ActivityRepo.listBySession`. The kinds (`ACTIVITY_KINDS`) and
their `ActivityMeta`:

| Kind | Recorded when | meta |
| --- | --- | --- |
| `note` | an agent calls `post_note` | |
| `submitted` | the work goes to review (`submit_for_review`'s note, or the first line of the auto-submit's last text, author `system`) | `specRevision` |
| `spec_revised` | a new spec revision after the first (`reviseSpec`: `update_spec`, `edit_spec`, `update_ticket`, a human's PATCH); the body is the revision's note, the author whoever wrote it | `specRevision` |
| `blocked` | the agent blocks (`block`, or a run ending on a question), or the service does (too many rejections, a PR completion without a pull request, a cleanup that didn't finish) | `question` |
| `unblocked` | the agent calls `unblock` | `note` when it gave one |
| `review_approved` | the agent review approves | `by`, `round`, `commit` (see "Agent review") |
| `changes_requested` | the agent review, a conductor or a human requests changes | `by`; the agent review adds `round` and `commit`; a reviewer's or conductor's notes are summarized, with all of them in `detail` |
| `approved` | a human (or a conductor) approves | `by` |
| `reopened` | a done ticket goes back to work | |
| `moved` | the ticket changes columns and no other entry records it (a drag, Start, resume_work, Completed); the body says why in one line, or is empty | `from`, `to` |
| `failed` | a run fails, or a worktree can't be made | `detail` when the error ran past one line |
| `permission` | a tool approval is asked for or answered, or the classifier denied calls in a run that still submitted | `detail`: the classifier's reason, or the denied calls |
| `system` | anything else the service records | |
| `message`, `answer` | legacy: older services logged a human's message from the Spec or Activity tab and the agent's reply. Never written now; clients still render them | |

**One line each.** Nothing is refused or cut. Every entry's body is the first line of what was
written (`activityLine` in `service/src/activity.ts`: the first non-empty line, heading and list
markers dropped, whitespace collapsed, never shortened), and when there's more, the whole text is
in `meta.detail`. That covers agents' notes, submit notes, reviewer and conductor decisions, run
errors, approval reasons, classifier denials, auto-submits and unblock notes; human-written text
(approvals, request-changes notes, re-open notes) is kept as written. The prompts and tool
descriptions strongly recommend one line of `ACTIVITY_LINE_MAX` (400) characters or less, and say
the first line is all Activity shows: the rest sits behind Show details, which the human may never
open, so the first line has to say what happened on its own ("Approved, with three open questions
in the spec."). The next agent review reads earlier rounds' notes from `detail`, and the work run's
prompt carries a reviewer's full notes. The work prompts (`system.spec` with `submits`) ask for a
note at each milestone and at least every 10 minutes ("Still running tests: 3 of 10 suites done").
That's an instruction, not a timer: a steered message still undelivered when a run ends becomes a
queued run, so a service-side nudge could start runs on its own.

**Spec revisions write their own entry.** A run that changes the spec has done something worth a
line, and the revision's note is already mandatory, so `reviseSpec` records each revision as a
`spec_revised` entry rather than relying on the agent to `post_note` it. This is what keeps
planning runs, which never submit and aren't asked for progress notes, visible in Activity. The
prompt and the `note` parameter of `update_spec`/`edit_spec` say the note is that Activity line and
needn't be repeated with `post_note`. Each revision gets its own entry; nothing folds a run's
revisions together, since Activity is append-only and clients have no update event for an entry.

**Show details.** Both apps offer Show details under an entry whose `detail` says more than its
body, revealing `activityDetail(entry)` (`shared/src/state/activity.ts`, held for HarnessKit's
`ActivityRows.fullText` by `activityDetailCases`): the detail after the line the body already
shows, or all of it when it doesn't start with that line (a permission entry's classifier reason).

**Every column change is in Activity.** `transition()` records each status change. An entry that
moved the ticket itself carries `meta.from`/`meta.to` (`moveMeta`: submitted, blocked, unblocked,
changes_requested, reopened, failed → blocked, a permission entry that blocks); otherwise
`transition()` adds a `moved` entry by the mover (`human` for a drag or an approval, `agent` for
`resume_work`, else `system`). The apps end such an entry's heading with "→ <column>". Board cards
and the Tickets tab show the newest entry of `NEWS_KINDS` (no moves, questions or permission
entries).

Blocked stays a column: the `blocked` entry records the question next to `blockedReason`.
Every entry is broadcast as `activity.added { entry }`; `GET /tickets/:key/activity` and
`TicketDetail.activity` return the list, and the reducer keeps `activity[sessionId]`.

**Tabs.** A ticket opens on the Spec tab (`openingTab()`), followed by Activity (`TICKET_TABS`).
Old links and saved routes with `summaries` open the Spec, the default view that replaced the Summaries tab (`RENAMED_TABS`, `ticketTabFrom`).

On the Mac (`app/src/renderer/views/SpecTab.tsx`, `ActivityTab.tsx`):
- The Spec tab's history bar shows one revision ("Rev 7 of 7 · Agent · 3m ago · *note*"), with ←/→
  and a slider. It follows the newest revision until the user steps back, and pins there until
  they return to the newest (`state/specHistory.ts`). Bodies load lazily from
  `/spec/revisions/:rev` into the store. **Show changes** keeps the rendered spec and marks what
  the revision on show changed from the one before it (`MarkdownDiff` in
  `components/Markdown.tsx`): `specDiff` (`shared/src/state/specDiff.ts`) parses both bodies with
  `parseBlocks`, aligns the blocks with an LCS, pairs changed blocks of the same kind (paragraphs,
  headings and quotes only when at least 40% of their words are shared) and diffs their words,
  keeping each word's inline style, so added text is green and removed text red and struck
  through, inside the same headings, lists, table cells and code blocks. Unpaired blocks show
  whole, added or removed. Its output is plain JSON, pinned by `shared/fixtures/cases/specDiff.ts`
  for HarnessKit's port (`MarkdownDiff` in `Logic/SpecDiff.swift`), which the iPhone/iPad Spec tab
  draws the same way through `MarkdownView(text:previous:)`; the file's header spells out the
  algorithm. The baseline
  revision is tagged "Approved plan".
- The Activity tab is a timeline styled per kind (`state/activity.ts`): `blocked` is an attention
  card, review decisions show their round and short commit, an entry that moved the ticket ends
  its heading with "→ <column>", an entry with more than its line offers Show details, and older
  services' messages and answers are bubbles.
- The composer switches to the Transcript once a message is sent (`tabAfterSend`), from any tab.
- The Details spec editor sends `baseRevision`; a 409 offers Reload (take the current spec) or
  Overwrite (resend against the new revision).
- `bun run spec-activity` (in `app/`) drives all of this against the real service and the dummy
  driver and saves screenshots to `app/out/screenshots/spec-activity`.

### Spec revisions and attachments

A ticket's **spec** is its living markdown document, what a human reads to know where the work
stands: Goal (the request and its acceptance criteria, changed only when the human asks), Plan,
Status (what's done and left, decisions, how each piece was verified, screenshots inline) and
Open questions. It replaced the ticket description and the plan (migration 26 renamed
`tickets.description` to `tickets.spec`). Agents keep it current rather than appending to it,
since its history lives in its revisions.

- **Revisions.** Every write is a row in `spec_revisions` (`ticket_id`, `rev` from 1, `body`,
  `author` `agent`/`human`/`system`, `run_id`, `run_kind`, `note`, `approved_baseline`,
  `created_at`; unique on ticket + rev, ON DELETE CASCADE). `tickets.spec` and
  `tickets.spec_revision` cache the current one, and the wire has `Ticket.spec`, `specRevision`
  and `specBaselineRevision`. Creating a ticket (`POST /tickets`, `create_ticket`,
  `dispatch_ticket`, triage) writes revision 1 (`system`, "Created") with it, in
  `TicketRepo.create`. Every revision after creation goes through `Orchestrator.reviseSpec`:
  `PATCH /tickets/:key { spec, baseRevision }`, `update_spec`, `edit_spec` and
  `update_ticket { spec, base_revision }`, each naming the revision it replaces, so no write
  overwrites a concurrent one. It checks the base revision, adds the next revision
  (none when the body didn't change), appends a `Spec revision N: <note>` status line, records a
  `spec_revised` Activity entry (the note as its line, by the revision's author) and emits
  `spec.revised`. Revision 1 adds no Activity entry: a new ticket isn't news. A draft's spec has no history: its PATCH rewrites revision 1 in place
  (`SpecRepo.replaceDraft`).
- **Conflicts.** A spec write names the revision it started from. `PATCH` needs `baseRevision`
  with `spec` outside drafts (400 without it); `specNote` is the revision's note (default "Edited
  by hand"). A stale one gets a 409 whose `data` is `SpecConflict { currentRevision, spec }`
  (`specConflict(err)` in the client reads it), and nothing in the PATCH is applied. The agent
  tools take `base_revision` and fail with the current revision in the message, so the agent
  reads it again and redoes the change. `update_ticket` writes over the current revision.
- **Approved baseline.** Pressing Start (planning → work in `begin()`) marks the current revision
  `approved_baseline` and sets `specBaselineRevision`. The agent review diffs the spec against it
  (see "Agent review"); a ticket started without planning has none. Migration 26 gave every
  existing ticket revision 1, marked as the baseline once it had left planning.
- **Reading.** `GET /tickets/:key/spec/revisions` lists `SpecRevisionInfo` (no bodies),
  `GET …/spec/revisions/:rev` returns a `SpecRevision` with its body, and `?diff=<other>` returns
  `SpecDiff { from, to, diff }` instead: a unified diff from `other` to `rev` (`unifiedDiff` in
  `service/src/spec.ts`, `""` when equal) that `parseDiff` in `shared/src/diff.ts` and HarnessKit
  read. `HarnessClient.specRevisions` / `specRevision` / `specDiff` wrap them, and the reducer
  keeps `specRevisions[ticketId]` (grown by `spec.revised`, `approvedBaseline` following the
  ticket) and fetched bodies in `specBodies` (`specBodyKey(ticketId, rev)`).
- **Agent tools.** `read_spec { revision? }` shows the revision number and the text with line
  numbers. `edit_spec` applies `old_string`/`new_string` or line-range edits atomically against
  the base revision's line numbers (`applySpecEdits`); `update_spec` replaces the whole text and
  can retitle the ticket. Plan, work, chat, conductor and complete runs get all three; review runs
  get `read_spec` and `edit_spec`, to record what the review found under Open questions (the ops
  refuse `update_spec` from review, and every write from triage); triage gets none.
  `submit_for_review` takes `spec_is_up_to_date`, which must be `true`, so a submit is a
  confirmation that the spec already describes the finished work. See "Tools".
- **Prompts.** `system.spec` ("Spec and Activity", every ticket run) names the current revision
  and the baseline, asks to change only what changed, lists the sections, explains images, holds
  Activity notes to one line without repeating the spec, says each spec revision's note becomes its
  Activity line (so it isn't repeated with `post_note`), asks work runs for a progress note at
  least every 10 minutes, and ends with the last five Activity entries. `run.work_start`, `run.changes_requested` and `run.reopen` name the
  revision, and the latter two ask for edits to the parts this round changed.

**Attachments.** Agents show their work with images and videos in the spec: markdown images that
point at local files (`![After](shots/after.png)`, absolute or relative to the run's cwd) in
`update_spec` / `edit_spec`. `browser_screenshot { save_to }` writes a screenshot to a file for
that.

- **Layout** (`parseBlocks` in `shared/src/state/markdown.ts`, ported to HarnessKit's
  `Markdown.swift`). An attachment image alone on its line is an `img` block: a figure across the
  full width (a tall one letterboxed), with its alt text as the caption. The title `"thumb"` (or
  `"thumbnail"`, any case) makes it a thumbnail (`Media.thumb`), and a line holding only
  thumbnails is a `thumbs` block: a wrapping row of 100×100 crops, each labelled with its alt
  text. A thumbnail line right under another joins its row; a blank line starts a new one. Inside
  text, a thumbnail is still a 100×100 square. Other titles are ignored. Any of them opens the
  lightbox (Mac) or the full-screen viewer (iOS). The prompt (`system.spec`) and the spec tools'
  descriptions teach agents both forms.

- **Rewriting.** `localImageSources` finds each local src once; `attachment:`, `http(s):`,
  `data:` and `mailto:` srcs are left as written. The files are validated and copied
  (`prepareAttachments`, `storeAttachments`), each src becomes `attachment:<id>`
  (`rewriteImageSources`), and the attachment rows and the revision are stored in one
  transaction. A failure removes the copied files, and the tool result lists each stored
  `name → attachment:<id>`.
- **Where `save_to` may write** (`resolveSaveTo` in `service/src/tools/browser.ts`, scope from
  `HarnessOps.fileOutputScope`). The permission gate never sees this write, so the tool confines
  it itself. The target, with its deepest existing ancestor resolved through `realpath` (a
  dangling symlink is refused), has to be inside the run's scratch folder
  `$HARNESS_HOME/tmp/<sessionId>/` or its working directory. A read-only run (plan or review,
  or `read_only` as the effective mode, ticket → project → settings) gets only the scratch
  folder, and its relative paths resolve there, so `save_to: "shot.png"` still works for a
  reviewer. Other runs resolve relative paths against the cwd. An existing target is replaced
  only when it already starts with the PNG signature. A refused path fails the call before the
  screenshot is taken, and nothing is written. The result says where the file went, noting the
  scratch folder when it landed there.
- **Validation** (`prepareAttachments` in `service/src/attachments.ts`) runs over every path
  before anything is stored, so a bad image fails the tool call and the spec stays at its
  revision. The limits are 10 new files per spec write and 100 MB per file. Allowed types are png,
  jpg/jpeg, gif and webp (kind `image`) and mp4, webm and mov (kind `video`). The extension picks
  the type, and the first bytes have to match it (PNG signature, JPEG SOI, `GIF8`, `RIFF…WEBP`,
  an ISO-BMFF `ftyp` box, EBML, QuickTime atoms). Width and height come from the PNG, GIF, JPEG
  or WebP header, when it has them.
- **Storage.** Each file is copied to `$HARNESS_HOME/attachments/<id>.<ext>` when the spec is
  written, because worktrees are deleted after the merge. The original path is never referenced
  again. Each is a row of the `attachments` registry with `source` "spec" and its `ticket_id`
  (ON DELETE CASCADE), keyed by ticket rather than by revision, so an attachment lives until its
  ticket is deleted, whichever revisions still show it (see "One attachment model"). Migration 26
  moved the old summary attachments into what was then `ticket_attachments` (files unchanged) and
  linked them from the migrated note as `![name](attachment:<id>)`; migration 30 folded that table
  into `attachments`.
- **Wire.** Spec media are ordinary `Attachment`s (source "spec"), listed in
  `TicketDetail.attachments`. `HarnessClient.attachmentUrl(id)` builds
  `…/attachments/<id>?token=<token>` for `<img>`, `<video>` and AVPlayer, which is how clients
  resolve `attachment:<id>` srcs, and the apps take the record from the detail by id.
- **Serving.** `GET /attachments/:id` streams the file with its `Content-Type`,
  `Content-Length`, `Cache-Control: private, max-age=31536000, immutable` (spec media only; every
  other source gets `no-cache`, since its file can change or vanish) and
  `Accept-Ranges: bytes`. A single `Range: bytes=a-b` / `a-` / `-n` gets a 206 with
  `Content-Range` (416 past the end), so players can seek. Unknown ids, and ids whose file is
  missing, get a 404.
- **Agents.** `get_ticket` lists the ticket's attachments with id, name, kind and the stored
  absolute path, so reviewer and conductor agents can open them with a file tool.
- **Deletion.** Deleting a ticket (so also a project) collects its attachment files, deletes the
  rows with the ticket, then removes the files.
- **Apps.** The Mac and iPhone/iPad apps render spec images inline from `attachmentUrl` and show
  the Activity tab next to the Spec tab (the children of HARNESS-194 implement them).
  `shared/src/state/attachments.ts` keeps the lightbox stepping helper.

**Paging and search.** Big projects make the Done column long, so boards load
`GET /tickets?status=` with every status except done and page done separately. `TicketPage` is
`{ tickets, nextCursor, total }`: `total` counts everything matching the filter, and
`nextCursor` (opaque, null on the last page) goes back as `cursor`. `limit` is clamped to
1..200. Paging is keyset, not OFFSET: the cursor holds the last row's sort key and id, so tickets
completed, moved or deleted between fetches never duplicate or skip a row.

- `/tickets/page` takes exactly one `status`. done sorts by `completedAt` desc; other statuses by
  `position`, then `createdAt`. `q` narrows the page to search hits (an empty `q` is a 400).
  `projectId` narrows a page or a search to one project and `group` to the projects in a group
  ("Project groups").
- `Ticket.completedAt` is when the ticket last entered done, and null outside done. SQLite
  triggers maintain it (migration 6 backfilled existing done tickets from `updatedAt`), so every
  write path gets it right.
- `/tickets/search` spans every status. It matches the ticket key, exact or prefix and
  case-insensitive, including old keys from `ticket_key_aliases`. It also matches title, spec
  and the latest note (the newest `note` or `submitted` Activity entry). Every term has to match, as a prefix. Ranking puts an exact
  key first, then a key prefix, then hits with every term in the title, then the rest, and
  newest-created first within each rank. An empty or whitespace `q` is a 400.
- The index is `ticket_search` (one row per ticket with `key`, `aliases`, `title`, `spec`,
  `latest_note` and `external_key`, kept current by triggers on tickets, aliases and Activity;
  migration 26 renamed `description` and `summary` and rebuilt the triggers) plus an external-content FTS5 table `ticket_fts` over it. User input never
  reaches FTS syntax: each term becomes a quoted string with `"` doubled and a trailing `*`, and
  punctuation-only terms are dropped. `ticket_fts` is derived data, created and rebuilt on open
  when missing. Without FTS5, search falls back to LIKE over `ticket_search` with the same
  ranking.

**One attachment model.** Every file a ticket refers to is an `Attachment { id, path, name,
source, kind, mimeType, size?, width?, height?, annotation? }`: a spec's media (source "spec"),
a file referenced in place on the service's machine ("file"), or bytes the service stored with
`POST /uploads` ("upload"). `kind` is "image", "video" or "file" (PNG, JPEG, GIF and WebP by their
bytes; a video by its extension and bytes; anything else, HEIC included, a file).

- **Registry.** The `attachments` table (migration 30, which folded in `ticket_attachments` and
  backfilled ids for every list already stored) has a row per file: `id`, `ticket_id` (set only
  for spec media), `path`, `name`, `source`, `kind`, `mime_type`, `size`, `width`, `height`. The
  same file is the same row (matched by path and source). `service/src/store/attachments.ts` is the
  repo, and `service/src/attachment-lists.ts` turns inputs into records.
- **Lists.** A New session's files (`tickets.prompt_attachments`), a queued run's
  (`runs.attachments`) and a sent message's (its transcript entry) are lists of whole
  `Attachment` records. Each list entry keeps its own name and annotation, so the same spec image
  can carry different notes in two messages.
- **Inputs.** `AttachmentInput { id?, path?, name?, annotation? }` (a full `Attachment` is a valid
  input; the service reads only those four). `id` reuses any registered attachment: a spec image,
  an upload, a registered file or a file from an earlier message (400 for an unknown id or a new
  one whose file is gone). `path` registers a file (absolute and existing; 400 otherwise), which
  is how agents and the CLI attach. An entry the list already had is kept even when its file has
  gone missing (`resolveAttachments`, `registerFile`).
- **Registering on the Mac.** `POST /attachments { path, name? }` registers a dropped or picked
  file when the service is on this Mac (`registerAttachment`); otherwise the app uploads it. Every
  waiting attachment in the apps is a registered record with an id.
- **Serving.** `GET /attachments/:id` serves every attachment (see "Spec revisions and
  attachments" for its headers). The per-index routes for prompt and message files stay for
  iPhone apps from before this model.
- **Deleting and sweeping.** Deleting a ticket deletes its spec media rows and files, even when
  another ticket's message sent one on by id (it shows as missing there), and its uploads unless
  another ticket still references the same id or path. "file" attachments are never deleted. At
  startup the sweep also forgets unowned rows whose file is gone, and unowned rows nothing refers
  to after a day.

**Prompt attachments.** A New session can carry files for the agent: `Ticket.promptAttachments`,
a list of `Attachment`s stored as JSON in `tickets.prompt_attachments` (migration 28). Files are
referenced where they are on the service's machine (or in its uploads folder) and never copied,
so a ticket keeps working after one is moved or deleted.

- **Setting them.** `CreateTicketBody.promptAttachments` and, on drafts only (409 otherwise),
  `UpdateTicketBody.promptAttachments` take `AttachmentInput`s and replace the whole list
  (`resolveAttachments`, see "One attachment model"). A file the ticket already had stays as it is
  even when it's gone, so a reopened draft still saves. Duplicates collapse, the limit is
  `MAX_PROMPT_ATTACHMENTS` (20), and the name defaults to the file's. The shared draft helpers carry the list like any other field: an attachment alone makes a
  draft non-empty (`draftIsEmpty`), and `draftCreateBody` / `draftPatch` send it. The pure list
  helpers live in `shared/src/state/promptAttachments.ts`, ported to HarnessKit and checked against
  fixtures.
- **Uploads.** Pastes, and anything from the iPhone or iPad (its files aren't on the Mac), go to
  `POST /uploads?name=<file name>` with the raw bytes as the body (up to 100 MB; empty is a 400,
  bigger a 413). The service writes `$HARNESS_HOME/uploads/<uuid>/<name>`, with the name cut down
  to one safe path component (`safeUploadName`, adding the MIME type's extension when there's
  none), registers it and answers the `Attachment`. `HarnessClient.uploadAttachment` wraps it.
  Deleting a ticket deletes its upload folders, except one another ticket still lists (a conductor
  can pass a pasted screenshot's path on to a child with `create_ticket`), and never a `file`
  attachment. When the service
  starts, `sweepUploads` removes upload folders over a day old that no ticket refers to, such as a
  paste taken back out of a draft.
- **Serving and missing files.** `GET`/`HEAD /attachments/:id` streams the file, and a file that
  is gone gets a 404. The apps draw image previews from `attachmentUrl(id)` and
  probe other files with HEAD, and a 404 shows the attachment as missing, with its name and the
  path it was at. Nothing else about the ticket depends on the files.
- **To the agent.** A plan, work, conductor or chat run of a ticket with attachments, while its
  session has no earlier succeeded run of those kinds, appends an `<attachments>` block to the
  prompt (`runAttachments`). The block lists every path and marks missing files, so the agent can
  open any of them with its file tools. Images whose first bytes are PNG, JPEG, GIF or WebP, up to
  3.75 MB each (5 MB once base64-encoded, the API's limit) and 10 per run, also go in
  `RunRequest.images`. claude-code sends them as image blocks in its stream-json user message
  (`userContent`), and anthropic-api adds them to the user turn. anthropic-api saves its
  conversation with each image replaced by a line of text (`savedMessages`), so the session row
  stays small. Later runs resume the conversation, so they aren't sent again. The transcript gets
  `Attached a.png, notes.md`, then `Attachment missing: <name> (was at <path>)` or
  `Sent <name> by path only: <reason>` lines as needed.
- **Agents and the CLI.** `get_ticket` lists `promptAttachments` with `missing`. `create_ticket`
  takes `attachments` (paths, relative ones against the run's cwd). `harness new` takes
  `--attach <file>`, which can repeat.
- **Mac app.** The draft editor lists the attachments under the prompt (the same list as the Spec
  tab, below, with × on each row and a spinner row per upload), a paperclip that opens a multi-select file input, drag and drop of files from anywhere, and
  image paste. A file with a path (`window.harness.pathForFile`, Electron's
  `webUtils.getPathForFile`) is registered in place (`POST /attachments`). Pathless image data (a screenshot on the
  clipboard, an image dragged out of a browser) is uploaded. A plain text paste stays text. When
  the service isn't on this Mac (`isLocalService(client.baseUrl)` is false: anything but
  `localhost`, `::1` or `127.x`), every file is uploaded under its own name instead, since its path
  means nothing there (`planFiles` in `state/promptAttachmentFiles.ts`). A window-level guard stops
  a file dropped outside the draft pane from navigating the window to it. `app/scripts/attachments-check.ts` drives the whole flow
  against the real service.
- **iPhone and iPad.** The New session has the same list as the Spec tab (× on each row, a
  spinner row per upload), and an Attach menu with Photos, Files
  and Paste. iPad also takes drops. Everything is uploaded, and HEIC photos are converted to JPEG
  first, since the agent APIs don't take HEIC.
- **One list** (`PromptAttachmentList` in `components/PromptAttachments.tsx` on the Mac and
  `Features/Content/PromptAttachmentList.swift` on iOS) draws the attachments in both places: in
  the New session, editable, and on the Spec tab, read-only at the bottom of the spec under an
  Attachments heading. One row each, a square of the same size for every row (the image's
  thumbnail, or a file icon) and then the name, so the names line up. A missing file's row is
  dimmed, with a dashed square and "Missing — was at <path>" under the name. An image opens the
  lightbox (Mac) or full-screen viewer (iOS); another file is revealed in Finder (Mac) or opens in
  Quick Look (iOS). The Transcript uses it read-only too, under a message sent with attachments.
- **Message attachments.** A message to a ticket can carry files the same way:
  `MessageBody.attachments` (`AttachmentInput[]`, resolved against an empty list, so every file
  must exist). The text may then be empty. While a tool
  approval waits they're refused with a 409, since that message answers the approval as a deny.
  The human message's transcript entry carries them (`{ type: "text", text, attachments }`), and
  each is served by id like any other attachment. A queued run keeps them in
  `runs.attachments` (migration 29, `Run.attachments`), so they survive a restart, and its
  `<attachments>` block and inline images come from them (with the ticket's own on its first run).
  A message steered into a running agent gets the block in its text and its images in
  `SteerMessage.images`: claude-code writes them as image blocks in the stream-json user message,
  anthropic-api puts them after the message's text block. A steered message the run never took in
  is queued with its attachments (`RunInput.undelivered` returns `{ text, attachments }`).
  Uploads sent with a message count as referenced for the startup sweep and for another ticket's
  deletion, and go when their ticket is deleted. In both apps the composer has a (+) button at its
  left: on the Mac it offers Choose files… and Paste image, and the composer takes drops and image
  pastes too (`usePromptAttachmentInput`, shared with the draft editor). On iOS it offers Photos,
  Files and Paste, and iPad takes drops, like the New session. The attachments are listed above the
  field with × to remove each before sending. Send works with attachments alone, waits for uploads
  to finish, and the (+) is hidden while a tool approval waits. `app/scripts/composer-attachments-check.ts`
  drives the Mac flow against the real service.
- **Annotations.** A human can draw numbered notes on an image to go with a message: any image
  in the spec, any prompt attachment on the Spec tab, any image sent with an earlier message in the
  Transcript, a screenshot of a session browser tab (`GET /browser/:sessionId/screenshot`, a PNG of
  the tab's viewport with its CSS viewport size, device scale and scroll, `BrowserScreenshot`, from
  `BrowserService.capture`; 404 when the tab doesn't exist, and a suspended tab reloads first), an
  image waiting in the ticket's composer, or an image attached to a New session. Annotations never
  speak to the agent on their own: they augment a message. And they never change the image: an
  annotation is metadata on the attachment, `Attachment.annotation` (`AttachmentAnnotation`: the
  image's pixel size, the marks numbered 1…n in those pixels, and for a browser screenshot the
  page's URL, title, tab, CSS viewport and scale). It rides in the list entry, so it travels with
  the file through the New session, the message, the queued run and the transcript entry with no
  fields of its own.
  - **Drawing.** Pressing on the image sets an anchor and dragging pulls out an arrow whose head
    points at it; the number sits at the arrow's tail, or on the anchor for a plain click. The
    rules for drawing and editing marks (the click/drag threshold, hit-testing, the arrow's
    geometry, the style that scales with the image) and for annotating an attachment in a list
    (`annotateAttachment`: the same file is annotated in place, another is added) live in
    `shared/src/state/annotations.ts` and `promptAttachments.ts`, mirrored in HarnessKit and checked
    against computed fixtures. The notes are listed beside the image (Mac, iPad) or below it
    (iPhone), never on it.
  - **Into the message.** **Add to message** puts the attachment, with its annotation, into the
    message being written: on a ticket, the composer's waiting attachments; in a New session, the
    draft's. A spec image goes as itself (its id from `TicketDetail.attachments`), not a copy. A
    browser screenshot is uploaded as is. Since the image is untouched, an annotation can be
    reopened and edited at any time before the message goes.
  - **Showing them.** The apps draw the marks over the image wherever an annotated attachment shows
    (thumbnails, the lightbox or viewer), with an "N notes" line that opens to the list: the
    composer, the New session, the Spec tab's attachment list and the Transcript.
  - **The element under a browser mark.** Each time a browser mark's anchor is placed or moved, the
    annotator asks `POST /browser/:sessionId/element { tabId, x, y, url, scroll, viewport }` (the
    anchor in the page's CSS pixels, and the screenshot's URL, scroll and viewport). The service runs `findElement`
    (`service/src/browser/element.ts`) in the page with `elementFromPoint`, never scrolling or
    waking it. It answers the element's CSS selector and its visible text (`BrowserElement`): `#id`
    when an id is unique in the page, else `tag:nth-of-type(n)` steps from the nearest unique id or
    `body`, up to 1000 characters, and innerText with whitespace collapsed, up to 200. It answers
    null when the tab has navigated, scrolled or been resized since the screenshot (a size change,
    or the pane of a Responsive viewer, reflows the page), so a mark never names the wrong element.
    When this viewer drives the size (Responsive), Annotate in the browser pane first applies any
    resize still waiting on its debounce and waits (up to 2 s) for a frame at the pane's size, so
    the screenshot shows the page at the size the lookups will find it. The mark keeps them as `path` and `text` (valid only with `page`), shown under
    its note as `#save · "Save"`. Moving an anchor forgets its element until the next answer
    (`moveMark`, `setMarkElement`).
  - **To the agent.** The service validates each annotation when it resolves the attachments (an
    image by its first bytes, marks in order and inside the image, message, path and text lengths,
    a well-formed page; 400 otherwise; a kept attachment whose file went missing isn't re-checked)
    and, not the apps, writes the agent's text: the `<attachments>` block lists each annotated
    image's notes under its path, with each mark's position in pixels and as a share of the image,
    plus CSS pixels and the element for a browser page, since the agent drives the page and edits
    the source with those. The image goes to the agent inline, unchanged. `get_ticket` lists each
    prompt attachment's notes. `app/scripts/annotate-check.ts` drives the Mac flow against the real
    service.

**File mentions.** The new-session prompt and the follow-up composer autocomplete `@path`
mentions of project files, like Claude Code (`@src/app.ts`, or `@"docs/My Notes.md"` for a path
with spaces). `shared/src/mentions.ts` holds the pure parts (the iOS app ports them, fixture-checked): `activeMention`
finds the mention at the caret (an `@` counts only at the start, after whitespace, or after an
opening bracket or quote, so `mark@example.com` never is), `insertMention` completes it (files get
a trailing space; folders end in `/` and keep the list open inside them), `parseMentions` pulls
the paths out of a prompt, and `rankPaths` orders candidates: path prefix, then name prefix, then
folder-name prefix, then substring, with in-order letters (`fmt` → `format.ts`) only when nothing
matches outright. A folder the query already names (`src/`) lists its contents, not itself; a
file typed in full (`.env`) stays in the list, first.

- **Autocomplete.** `/projects/:id/files` searches the project folder (new session);
  `/tickets/:key/files` searches where the ticket's next run works: its worktree, else the
  session's cwd, else the project folder. Gitignored files are included, since build output,
  local specs and `.env` files are often exactly what someone wants to mention.
  `service/src/orchestrator/files.ts` lists `git ls-files --cached --others --exclude-standard` in
  a git repo, then `git ls-files --others --ignored --exclude-standard --directory`, which reports
  each ignored folder once (`dist/`) instead of every file in it, and walks those folders itself.
  Other folders are walked from the top. Walks are breadth first and stop at 20,000 files (in a
  git repo, on top of git's own list), so shallow files make the cut in a huge tree. `.git`, `.hg`,
  `.svn` and `.DS_Store` are left out; `node_modules` is listed as a folder but not walked. A query
  inside a folder (`node_modules/react/`) also lists that folder straight from disk, so anything the
  index skipped or cut short can still be reached one level at a time. Browsing resolves
  symlinks and refuses a folder whose real path is outside the root, never enters or lists
  `.git`/`.hg`/`.svn`, and drops `.DS_Store`.
  Every folder that holds a file is added, and the list is cached per folder for 5 seconds so
  typing doesn't re-run git on each key.
- **Attaching.** `Orchestrator.execute()` passes plan, work, conductor and chat prompts
  through `attachMentions` with the run's cwd before the driver sees them; review, complete and
  triage prompts are left alone (review and complete runs work from the spec and the branch,
  whose files the earlier runs already had, and triage prompts are watcher output). Each mention that resolves to a file or folder inside the cwd is appended in a
  `<mentioned-files>` block: `<file path="…">` with the contents, or `<directory path="…/">` with
  a one-level listing. Mentions that aren't paths (`@someone`) are ignored. Paths that resolve
  outside the cwd, symlinks included, are refused; binary files (a NUL in the first 8 KB) are
  skipped; a file is cut at 256 KB (the tag says so) and the whole attachment at 1 MB. The
  transcript keeps the prompt as typed plus a status line, `Attached @README.md, @src/app.ts`,
  and one `Didn't attach @…: <reason>` line per skipped path. Contents are read when the run
  starts, so a message queued behind a run gets the files as they are when it runs.
- **The file browser's search.** `?ignored=1` on either `/files` route (the command palette's
  file browser; the autocomplete never sends it) builds a separate, deeper index that also walks
  `node_modules` (anywhere), after everything else, with its own budget of 200,000 entries and
  1.5 seconds, cached for 30 seconds. Gitignored paths (and everything in `node_modules`) rank
  behind the rest of their match rank, so `util` finds `src/util.ts` before `dist/util.ts`, and
  come back as `{ path, kind, ignored: true }` (the autocomplete's matches never carry the field).
  `?kind=file` (or `dir`) keeps one kind, the one-level browse included.

**Slash commands.** The same two fields autocomplete a `/command` or skill that starts the text,
like Claude Code's prompt (`/code-walk this branch`). The harness doesn't read or expand skills
itself: the driver lists what its agent offers, and the text goes to the agent as typed, so the
agent expands the command the way it would in its own terminal. `shared/src/commands.ts` holds the
shared parts: `activeCommand` finds the command at the caret (a `/` only counts as the text's
first character, as in the CLI, and only until the first whitespace, so `/code-walk @src/` still
autocompletes the `@`), `insertCommand` completes it with a trailing space for the arguments, and
`rankCommands` orders the list: name prefix, then a prefix of a `:`/`-`/`_` part (`deploy` →
`vercel:deploy`), then substring, and descriptions only when no name matches. Ties keep the
driver's order. Names with whitespace (MCP prompts) can't be typed as one word and are dropped.

- **Listing.** `Driver.listCommands(cwd)` is optional. claude-code starts the CLI in `cwd` in
  stream-json input mode and sends the SDK `initialize` control request, the same one the model
  list uses (`claude-code-models.ts`), and reads `commands` from the answer: built-ins, the user's
  and the project's skills and commands, and plugin commands, each with its description and
  argument hint. No user message is sent, so no tokens are spent. Internal names (`__…`) are
  dropped. anthropic-api and dummy don't implement it, so their sessions list nothing.
- **Which agent.** `/projects/:id/commands` asks the driver a new session will use (`?driver=`,
  else the project's, else the settings'), in the project folder. `/tickets/:key/commands` asks the
  ticket's driver in the folder its next run works in (as `/tickets/:key/files`), so a
  worktree's own `.claude/skills` show up.
- **Caching.** `CommandCatalog` (`service/src/drivers/commands.ts`) keeps a list per driver and
  folder. Starting the CLI takes two to four seconds, so only the first lookup for a folder waits.
  After that, lookups answer at once, and a list older than 60 seconds is refreshed in the
  background. A failure lists nothing (or keeps the last good list) and retries after 15 seconds.
- **Running.** Nothing changes on the way to the agent: `/name args` is the run's prompt (a new
  ticket's first run) or the message, as typed, with any @-mentioned files appended after it.
  The CLI treats a user message that starts with `/name` as that command.

## File viewer

The desktop file pane and the iPhone file viewer read one file where a project or ticket works,
syntax-highlight it, and show a diff tab when it has uncommitted changes
(`service/src/orchestrator/file-view.ts`). The root is the project folder, or for a ticket the
same folder `/tickets/:key/files` searches (worktree, else session cwd, else project folder).

- **Paths.** `?path=` is relative to the root, or absolute inside it (made relative, with the
  root's real path accepted too, e.g. macOS's `/private/var`). `safeJoin`
  (`service/src/safe-path.ts`, shared with the plugin static UIs) refuses NUL, `..` and anything
  whose real path leaves the root, so symlinks can't escape: those are 400, as are folders, the
  root itself and anything inside `.git`. A missing file is 404.
- **Contents** (`FileView`) are read from disk, not git, so gitignored files open like any
  other. A NUL in the first 8 KB makes a file `binary`; a file over 2 MiB is `tooLarge`; either
  way `contents` is null. `truncated` flags a file that grew past the cap while being read.
  `git` comes from one `git status --porcelain -z --untracked-files=all --ignored=matching` for
  the path: `untracked` (`??`), `ignored` (`!!`), `tracked` otherwise, `dirty` for any entry but
  an ignored one; all false outside a repository.
- **Diff** (`FileDiff`) is the working tree against `HEAD` (the empty tree before the first
  commit), staged and unstaged together, with the git plugin's flags (`--no-color --no-ext-diff
  --no-textconv --src-prefix=a/ --dst-prefix=b/`, no `-M`: renames aren't followed) plus
  `--relative`, so paths match `path` when the root is a folder inside the repository. An
  untracked file is `git diff --no-index -- /dev/null <path>`, so it shows as added. A clean or
  ignored file has an empty patch; a deleted one still diffs. `oldContents` is `HEAD:./<path>`
  and `newContents` the disk copy, each null when missing, binary or over 2 MiB; a patch over
  4 MiB comes back empty with `tooLarge`. A root outside any repository is a 409 (the viewer knows
  from `FileView.git.repo` not to ask). Git runs without a shell, with `--literal-pathspecs`,
  the path after `--`, and `GIT_OPTIONAL_LOCKS=0` so it never takes the index lock.

## Service updates

A service run from a checkout runs the code on disk, so a merge into that checkout (a ticket's
complete run, a `git pull`) changes the code under a service that keeps running the old code.
Routes the new app calls then 404 until the service restarts.

- At boot the daemon hashes the files it loads (`sourceFingerprint` in `service/src/code-watch.ts`):
  `service/src`, `shared/src` and `plugins`, skipping tests, `node_modules`, `dist` and dotfiles,
  plus the package manifests and `bun.lock`. `build` is that hash.
- The compiled executable has no source on disk, so it fingerprints its own file instead
  (`executableFingerprint`: inode, size, mtime). Replacing Harness.app with a new build makes a
  service launchd still runs from the old one stale. While the file is missing (mid-replace, or
  the app moved) the last value stands.
- Every 20s it hashes again. When the result differs from `build` the service is `stale`:
  `/health` says so and a `service.status { build, stale }` event goes out (again if the code
  changes back).
- A stale supervised service (launchd's, or the app's child; see "Service supervision") restarts by itself once the
  new code is settled (the same hash two checks in a row, so a checkout still writing files isn't
  loaded half-done) and nothing is queued, running or starting (`Orchestrator.isIdle`). It exits
  through the normal shutdown and its supervisor starts the new code (under launchd, through
  `kickstart -k`; see "Service supervision"). Run by hand, it only reports stale.
- `POST /service/restart` restarts right away. Running agents are stopped: their runs end
  cancelled and their tickets stay in their columns.
- Tests and embedded services don't track their source: `/health` reports `build: null`,
  `stale: false`.

The desktop app shows a banner under the main view while the service is stale, and it can't be
dismissed. A service whose `/health` has no `build` at all predates build tracking. It never
restarts by itself, and the app counts it as stale too. "Restart now" asks for confirmation when
agents are running. The app restarts its own child in place. For a login item the main process
runs `cli.ts service restart` (`launchctl kickstart -k`), which works on a service of any age.
Other connections call `POST /service/restart`. The banner goes away when the reconnected service
reports fresh code.

**Reinstalling a login item.** `service ensure` rewrites the plist when this build's differs (a
`--checkout` app replacing a bundled one, or the reverse), and a changed plist means a reload:
`launchctl bootout`, then `bootstrap`. Two details make that safe:

- `bootout` returns as soon as it has sent SIGTERM, but launchd keeps the job (`print` still finds
  it, and `bootstrap` fails with 5) until the daemon exits, which can take up to `ExitTimeOut`
  (30s) while it closes Chrome. `Cli.bootout` polls `print` until the job is gone before anything
  bootstraps it again. Before that wait, a bootstrap that failed with 5 looked successful because
  `print` still found the dying job, and launchd then removed the job with nothing to replace it.
- `/health` answers 503 from the moment shutdown starts (the HTTP listeners close last), so
  neither `ensure` nor the app mistakes a dying service for a healthy one.

While agents are running, `ensure` leaves a changed plist alone. It doesn't write the new plist or
reload the job, and it returns `deferred: { busy }` with the running service's details. The app
connects to that service and shows a banner. Every 10s its main process asks whether any agents
are still busy (`ServiceManager.settleDeferred`), and once none are it runs `ensure` again, which
now reloads. `ensure --force` and `service restart` reload right away. `restart` also checks for a
changed plist, because `kickstart -k` would relaunch the definition launchd already has.

A window whose socket stays down for 8s says so: a "Can't reach the harness service" card in place
of the loading spinner when nothing has loaded yet, otherwise a banner. Retry runs the same
connect path as launch, which starts the service again.

## Network

The service always answers on loopback, so the desktop app, agents' MCP URLs and the `harness`
CLI keep using `http://127.0.0.1:<port>` whatever the setting. `settings.listen` adds to that:

| `listen.mode` | Binds |
| --- | --- |
| `localhost` (default) | `127.0.0.1` |
| `tailscale` | the Tailscale IPv4 (`tailscale status --json`, else `tailscale ip -4`; PATH, `/usr/local/bin`, `/opt/homebrew/bin`, the app bundle) + `127.0.0.1` |
| `any` | `0.0.0.0` (covers loopback) |
| `custom` | `listen.host`, which must be (or resolve to) an address of a local interface, + `127.0.0.1` |

The port stays `HARNESS_PORT` / 7717. Each address is its own `Bun.serve` listener sharing one
fetch/WebSocket handler (`api/network.ts` `NetworkManager`). `PATCH /settings { listen }`
validates the whole body, rebinds, then persists: new listeners start before old ones stop
(macOS lets `0.0.0.0` and a specific address share a port), and if any fails to bind the partial
starts are undone, the old set keeps serving and the error comes back as 409 and as
`NetworkStatus.error`. Removed listeners are retired: requests to addresses nothing else serves
get 503, and they close (with their keep-alive and WebSocket connections) after a 1s drain. On
boot, a mode that can't bind (Tailscale not up yet) falls back to loopback, logs it, and retries
every 30s; `/network` shows `active: "localhost"` next to the configured `mode` meanwhile.
`HARNESS_HOST` (`localhost` / `tailscale` / `any` / a host) overrides the setting for tests and
dev; the setting can't be changed while it's set.

**Pairing.** `GET /pairing` returns `{ url, token, pairUrl }` for the best address a phone can
reach: the Tailscale IP (bound directly or covered by `0.0.0.0`) > the custom host > the first LAN
IPv4 under `any`. `pairUrl` is exactly
`harness://pair?url=<encodeURIComponent(url)>&token=<encodeURIComponent(token)>`
(`shared/src/pairing.ts` builds and parses it); the desktop shows it as a QR code. `POST
/token/rotate` writes a new token file (0600, atomic rename), rejects the old token immediately,
closes every open WebSocket, and the desktop re-reads the token file and reconnects.

**Exposure.** The bearer token is full control of the service: it can start agents that run
commands in your projects. Anything beyond `localhost` puts that behind the token alone, sent in
plain HTTP. Prefer `tailscale`, where only your tailnet can reach the port and WireGuard encrypts
the traffic; `any` exposes the port to every network the Mac joins (coffee-shop Wi-Fi included)
with the token readable by anyone on the path. Rotate the token if a phone is lost or a QR code
leaks.

## Color themes

Themes live in `shared/src/themes` (`@harness/shared/themes`); the desktop, the phone (through a
JSON copy generated into HarnessKit) and plugins all read the same registry. A theme is `{ id, name, appearance: "light" | "dark", source,
syntaxTheme, tokens }`, where `tokens` (`ThemeTokens`, `types.ts`) is the semantic set the apps
use: surfaces (`bg`, `bgSidebar`, `bgElev`, `bgSunken`, `bgColumn`, hover/active washes, borders),
three text levels, accent (+ hover, soft, `accentText`, `onAccent`), `focus`, `selection`, shadows,
the modal scrim, one color per board column (`planning` … `done`), tones (`green`, `red` +
`redSolid`/`onDanger`, `amber` + `onAmber`, `violet`, each with a soft fill) and diff colors.
`CSS_VAR` maps each token to the desktop's custom property (`--bg`, `--text-2`, `--c-blocked`, …).

Bundled: Harness Light / Harness Dark (the original look, verbatim, and the defaults), One Light,
Atom One Dark, Catppuccin Latte / Frappé / Macchiato / Mocha, Solarized Light / Dark, GitHub Light /
Dark, Dracula, Nord, Gruvbox Light / Dark, Tokyo Night / Tokyo Night Day, Rosé Pine / Rosé Pine
Dawn. Each cites its palette. Non-Harness themes go through `defineTheme` (`define.ts`): the
palette names surfaces, text, accent and hues; washes, soft fills, focus, shadows and on-colors are
derived the same way for every theme, and text / accent text / tone text are nudged toward the
theme's ink only as far as WCAG AA needs (body text aims for 7:1, status dots 3:1).
`themes.test.ts` recomputes contrast for every pair the UI relies on (text levels on every
surface, text on the selected row, on-colors on accent/danger/amber fills, tones in their pills,
diff colors, status dots on columns and cards) and fails below AA; the Harness themes carry a
pinned, exact list of their original sub-AA pairs, since they must stay pixel-identical. It also
checks status colors stay apart (OKLab ΔE ≥ 0.08) and text levels keep their order.

Settings → Appearance keeps System / Light / Dark and adds a Light theme and a Dark theme pick
(only themes of that appearance, previewed as a mini board in the theme's own tokens). The active
theme is the light pick when the resolved appearance is light, the dark pick when dark
(`resolveThemeChoice`). Desktop: `preferences.json` holds `{ theme, lightTheme, darkTheme }`; the
preload reads it synchronously and stamps `<html data-theme>` (resolved appearance — the plugin
contract), `data-theme-id` and the tokens as custom properties on `<html style>` before first
paint; the renderer restamps on every change. No stylesheet defines a theme token
(`theme-tokens.test.ts`). `HARNESS_THEME_ID=<id>` forces a theme (screenshots:
`scripts/shoot.ts --themes=<ids>`). Phone: see "iPhone and iPad app".

## Plugins

A plugin adds ticket tabs (a web UI in an iframe) and, optionally, server routes. Plugin UIs
are plain web pages served by the service, so any host (the Electron app and the iOS app) can
embed them without Electron APIs. Author docs: [plugins/README.md](plugins/README.md).

**Discovery.** At start the service scans `<repo>/plugins/*` (builtin), then
`$HARNESS_HOME/plugins/*` (user). A directory is a plugin when it has a `plugin.json`. A user
plugin with the same `id` replaces the builtin one. Changes are picked up on service restart.

```jsonc
{
  "id": "git",                 // /^[a-z0-9][a-z0-9_-]{0,63}$/
  "name": "Git", "version": "0.1.0", "description": "…",
  "server": "server.ts",       // optional; dynamic-imported by the service (Bun: .ts or .js)
  "ui": "dist/",               // optional; required when there are tabs
  "build": "build.ts",         // optional; run with the service's bun when ui/index.html is missing or
                               // older than the plugin's sources (node_modules, dotfiles, *.test.* ignored)
  "tabs": [{ "id": "changes", "title": "Changes", "icon": "branch", "when": "workdir" }]
}
```

**Isolation.** A bad manifest, a server module that throws on import or has no default export,
a `routes()` that throws, or a failed UI build (with no previous bundle) marks that plugin with
`error`. It stays listed in `GET /plugins`, its API answers 503, and its tabs are not offered.
Everything else keeps working. Errors in `onTicketEvent` are logged and swallowed.

**Server API** (`plugins/sdk/server.ts`). `export default definePlugin({ routes(router, ctx),
onTicketEvent?(event, ctx), showTab?(tab, ctx), dispose?() })`. Routes are mounted at `/plugins/<id>/api/*` behind the
same bearer auth as every other route (`router.get("/changes", …)` → `GET /plugins/<id>/api/changes`;
`:param` segments). Handlers return JSON-able data (sent as `{ data }`) or a `Response`; throwing an
error with a numeric `status` (e.g. `PluginHttpError`) sends `{ error }` with that status. The
context is read-only: `getTicket(key)` → `{ ticket, project }`, `ticketWorkdir(key)` (the ticket's
workdir when set and present on disk), `exec(cmd, args, { cwd, env, timeoutMs, maxBytes, stdin })`
(no shell; never throws; reports `truncated`/`timedOut`), `log.info|warn|error`. `onTicketEvent`
receives `ticket.upserted` / `ticket.deleted`. Plugins are trusted code: they run in the service
process with its privileges.

**Tabs.** `GET /tickets/:key/tabs` returns the tabs of healthy plugins whose `when` holds, sorted
by plugin id:

| `when` | Shown when |
| --- | --- |
| `always` | every ticket |
| `workdir` | `ticket.workdir` is set, exists, and `git rev-parse --is-inside-work-tree` is true there |
| `worktree` | `ticket.branch` is set and `ticket.workdir` exists (the ticket's own worktree: a harness one, or the one `update_branch` moved it to) |

When a tab's `when` doesn't hold and its plugin defines `showTab({ id, ticket, project }, ctx)`, the
tab is offered if that returns `true` (a throw is logged and counts as `false`). The git plugin uses
it to keep Changes on a ticket whose worktree was removed.

The app lists plugin tabs after Spec, Activity, Transcript, Browser and Details. Their route is
`#/board/<project>/ticket/<KEY>/plugin:<pluginId>:<tabId>`; a plugin tab that no longer applies
falls back to the Spec.

**UI hosting.** The tab body is `<iframe src="<baseUrl>/plugins/<id>/ui/index.html?tab=<tabId>"
sandbox="allow-scripts allow-same-origin allow-forms allow-downloads">`. The iframe's origin is the
service origin, so the plugin's API calls are same-origin and only need the bearer token (the
renderer's CSP allows `frame-src` for local service origins). Static UI files are served without
auth (they carry no data), with path-traversal and symlink-escape protection.

**Bridge** (`PluginHostMessage` / `PluginFrameMessage` in `protocol.ts`; host logic in
`shared/src/state/pluginBridge.ts`, used by the desktop iframe, and ported to Swift for the iOS web view):

| Direction | Message | When |
| --- | --- | --- |
| page → host | `{ type: "harness:ready" }` | the SDK's `connect()` starts; the host answers with init |
| host → page | `{ type: "harness:init", baseUrl, token, ticketKey, tabId, theme, appearance?, themeId?, themeName?, syntaxTheme?, tokens? }` | page load and every ready |
| host → page | `{ type: "harness:theme", theme, appearance?, themeId?, themeName?, syntaxTheme?, tokens? }` | the theme changes: light/dark or the color theme (desktop: `<html data-theme>` / `data-theme-id` MutationObserver) |
| host → page | `{ type: "harness:ticket", ticket }` | every `ticket.upserted` for that ticket |
| page → host | `{ type: "harness:openExternal", url }` | http(s)/mailto only |
| page → host | `{ type: "harness:navigate", ticketKey }` | open another ticket |

Transports. Desktop: the page is an iframe; host → page is `iframe.contentWindow.postMessage` and
page → host is `window.parent.postMessage`. iOS: the page is a WKWebView
(`ios/HarnessKit/Sources/HarnessKit/Logic/PluginHost.swift`, wired up in
`ios/Harness/Features/Ticket/PluginWebHost.swift`); host → page is `evaluateJavaScript` of
`(function(){ if (location.origin !== <serviceOrigin>) return; window.postMessage(<msg>, <serviceOrigin>); })(); true;`,
and page → host is `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`, which a
document-start user script defines over a `WKScriptMessageHandler`. The host adapts each message to
`{ data: JSON.parse(data), origin: <the web view URL's origin>, source: <frame adapter> }`. The name
`ReactNativeWebView` is historical (the 1.x iOS app was React Native); it stays because the plugin
SDK and existing plugin UIs use it.

Origin rules: the host only ever sends to the service origin (iframe `targetOrigin`, or the
injected `location.origin` guard), so the token never reaches a page that navigated elsewhere, and
accepts messages only when `event.source` is its own frame and `event.origin` is the service
origin. The SDK picks its transport by whether `window.ReactNativeWebView.postMessage` exists. In an
iframe it accepts messages only from `window.parent`, first from an allowed host origin
(`file://`/`null` for Electron, local http(s) origins, or ones passed as `allowedOrigins`). In a
WebView it accepts them only when `event.source` is its own window and `event.origin` is its own
origin (the service origin, which may be a Tailscale address); a top-level page without
`ReactNativeWebView` never trusts its own origin. In both, after init only the origin that sent init
is trusted. `theme` is always the resolved `"light" | "dark"`, which old plugins keep reading. Hosts
with color themes also send the active theme's `themeId`, `themeName`, `syntaxTheme` (the matching
Shiki theme, or null) and `tokens` (`ThemeTokens`). The SDK validates them and mirrors all of it
onto the page: `<html data-theme>`, `color-scheme`, `data-theme-id`, and each token as
`--harness-<app var>` (`--harness-bg`, `--harness-text-2`, `--harness-c-planning`,
`--harness-diff-add`, …), removing stale ones. `onTheme(theme, info)` fires on any change,
including dark → dark. Plugin CSS should use the vars with fallbacks so older hosts still work.

**Builds.** Plugin bundles are not committed (`dist` is gitignored). `bun run plugins:build` at the
root builds every builtin plugin, `app/scripts/build.ts` runs it, and the service runs a plugin's
`build` script at start when its bundle is missing or stale. UI requests wait for an in-flight build.

### Git plugin (`plugins/git`)

Tab **Changes** (`when: "workdir"`, kept by `showTab` while a pin exists). Routes:

- `GET /plugins/git/api/changes?ticket=KEY[&maxBytes=N]` → `{ mode, base, baseSha, head, branch, files, patch,
  truncated, additions, deletions, worktree? }`, `files: [{ path, oldPath?, status, additions, deletions, binary }]`
  with `status` ∈ `added | modified | deleted | renamed | untracked`.
  - **branch mode** (ticket has a branch): the diff runs from `merge-base(base, HEAD)` to the worktree
    **as it is on disk**, so committed, staged, unstaged and untracked (not ignored) changes all show.
    `base` is the ticket's or project's `baseBranch` override when the repo has it, else the branch
    checked out at the project path, falling back to `main`/`master`.
  - **workdir mode** (no branch): uncommitted + untracked changes against `HEAD` (or the empty tree in
    a repo without commits).
  - **pinned mode** (ticket has a branch, its workdir is gone): the diff saved while the worktree
    existed, read from the project repo. See "Pinned diffs" below.
  - The user's index is never touched. The plugin copies it (keeping its mtime so git's racy-clean
    detection still works) to a temp `GIT_INDEX_FILE`, runs `git add -A` there, and diffs `--cached`
    with rename detection and config-independent flags.
  - `patch` is capped at 4 MiB by default (`maxBytes`, up to 64 MiB) and cut at a file boundary with
    `truncated: true`. The file list is always complete.
- `GET /plugins/git/api/log?ticket=KEY` → `{ mode, base, commits: [{ sha, shortSha, subject, author, email, date }] }`,
  the branch's commits since the merge-base (empty in workdir mode; `base..head` of the pin in pinned mode).
- `GET /plugins/git/api/file?ticket=KEY&side=old|new&path=P[&ref=<sha>]` → `{ contents }`, one side of a file, used to
  expand unchanged context. Paths are repo-relative; `..`, absolute paths and `.git` are rejected. In
  pinned mode the new side comes from the pinned commit, not the project checkout.

**Pinned diffs.** The complete run merges the branch, removes the worktree and deletes the branch,
so the live diff can't be computed afterwards. On every `ticket.upserted` for a ticket that has a
branch, a worktree on disk and isn't `done`, the plugin pins the diff as refs in the project repo
(runs coalesce per ticket):

| Ref | Points at |
| --- | --- |
| `refs/harness/changes/<ticket id>/base` | the merge-base with the base branch |
| `refs/harness/changes/<ticket id>/head` | the branch head |
| `refs/harness/changes/<ticket id>/worktree` | only when the worktree had uncommitted or untracked changes: a snapshot commit (parent: head, author "Harness") of the worktree tree, built from the same throwaway index |

The diff is `base..(worktree ?? head)`. The ticket id (not the key) names the refs, since keys
change when a project is renamed. Enqueueing the complete run emits `ticket.upserted`, so the last
pin holds the work as approved. An empty diff never replaces an existing pin: after the merge,
merge-base == HEAD and the live diff is empty, but the pin should keep showing what the ticket
changed. The refs keep the commits reachable after a squash merge or `gc`. They sit outside
`refs/heads` and `refs/tags`, so `git push` doesn't send them. Deleting the ticket removes them
(best effort: the plugin needs to have seen the ticket since the service started, because the
delete event only carries the id).

**The tab is built into the apps.** The Mac app (`app/src/renderer/views/ChangesView.tsx`) and the
iPhone/iPad app (HarnessKit `Changes*`) draw Changes themselves from these routes, rather than
hosting the plugin's page. The service still lists it as the plugin's `git:changes` tab, which is
how the apps know a ticket has a diff. `shared/src/state/changesTab.ts` (and its Swift twin,
`ChangesTab.swift`) layers the built-in `changes` tab on top of `tabs.ts`: `plugin:git:changes`
normalizes to `changes`, git:changes leaves the plugin tabs, and the tab sits after Browser, ahead
of Details, while the service lists it (or, before the tab list loads, while the ticket has a
workdir). The payload types, Viewed marks (fingerprinted per file diff, so a file changed again
reads as unviewed), the Unified/Split and sidebar preferences and the empty/notice text live in
`shared/src/state/changes.ts`, which the plugin's page shares.

The plugin's own page (`plugins/git/ui`, for other hosts) and the Mac tab look and behave the same.
Both use Pierre's [@pierre/trees](https://trees.software) for the changed-file tree (git status
colors plus `+a −d` decorations) and [@pierre/diffs](https://diffs.com) `CodeView` for the stacked,
virtualized diffs with sticky headers and syntax highlighting (the Mac app through their React
bindings, loaded lazily). They offer unified/split view, expandable context, a commits dropdown,
empty/error/truncated states, a "Saved" marker in pinned mode, a Viewed checkbox and disclosure
arrow on each file, and follow the app theme: the chrome uses its tokens (the page gets them as
`--harness-*`), and diffs and the tree use the app theme's `syntaxTheme`, falling back to
pierre-light / pierre-dark when there is none or it fails to load.
They refresh on ticket events (debounced 600 ms), poll every 4 s while the ticket is busy (file
edits don't emit ticket events), and have a refresh button. Below 720 px the tree becomes a drawer.

## Testing

`bun test` in each package. No test touches the network or a real model; the claude-code
driver is tested against a fake `claude` executable that replays stream-json. Browser tests
use the local Chrome and skip when it is missing. End-to-end tests boot the service on an
ephemeral port with a temp `HARNESS_HOME` and drive it through `HarnessClient`.

The service's `bun run test` runs one `bun test` process per file, several at once
(`shared/src/testing/parallel.ts`), since its files mostly wait on git, Chrome and child
daemons. So test files must not share fixed ports or paths. Test servers bind `127.0.0.1`, the
address they're dialed on: a wildcard listener on an ephemeral port can be shadowed by another
process holding `127.0.0.1` on the same port. Tests wait on the state they need (a held driver,
a delivered output) rather than sleeping or waiting out `idle()`'s timeout.

## Desktop app (`app/`)

Electron main (`app/src/main`) plus a React renderer (`app/src/renderer`). The left sidebar
collapses and resizes (`state/layout.ts`); the rest of the window (`<main>`) shows Inbox,
Settings, project settings, or on the board route the pane workspace.

- **Pane workspace.** A tmux-style split tree (`state/panes.ts`) per board scope: each project's
  board has its own, each project group's board has one, and All projects has one too.
  `harness.panes` stores `{ scopes: { [scope]: PaneState } }`, keyed like Done paging (`scopeOf`:
  the project id, `groupScope(name)`, or `ALL_SCOPE` = `"*"`), and a board with no entry shows a
  bare board. The operations work on one
  scope's `PaneState`. The store takes the scope (`usePanes(scope)`, `updatePanes(scope, fn)`),
  and `updateAllPanes` covers the edits that reach every board: a deleted ticket (`ticket.deleted`
  runs `pruneTickets`) and a renamed key (`renameTicketKey`). Removing a project, from the sidebar
  or through `project.deleted`, drops its scope and closes its tickets on All projects
  (`forgetProject`). A snapshot drops the scopes of projects and groups that no longer exist,
  apart from the one on screen. The single tree stored before scopes existed migrates into All projects. It was
  shared by every board, and All projects is the board that can show all of its tickets; project
  boards start bare. Parsing drops a scope entry it can't read. Pane ids are unique across all
  scopes, because content is keyed by leaf id: loading seeds the id sequence past every stored `p<N>` (`seedPaneIds`), a later scope
  that repeats an id gets a new one, and a scope that isn't stored yet gets the fixed board id
  `b:<scope>`, so re-reading the store (another window wrote it) doesn't remount that board.
  `paneScopeOf(route)` (`state/route.ts`) is the route's scope. `PaneWorkspace` takes it as a
  prop and provides it to the panes (`usePaneScope`, `components/paneContext.ts`). Switching
  scope unmounts the other board's panes rather than keeping every board mounted. Leaves mount
  again by id when you come back, and a terminal re-attaches to its shell, which lives in the
  main process. Keeping every board mounted would mean running a board per project, each with its
  own search. Leaves show content (`{ kind: "board" }`, `{ kind: "ticket", ticketKey, tab }` or
  `{ kind: "terminal", sessionId, cwd, title? }`, `{ kind: "file", root, path, startLine?, endLine?, tab? }`,
  `{ kind: "ticketTab", ticketKey, tab, browserTab? }`), splits lay their children out side by side
  (`row`) or stacked (`column`) with sizes that sum to 1. Each scope always has exactly one board
  pane, and a ticket, a torn-off tab (`tornKey`), a terminal session or a file (its root plus
  path, `fileKey`) is open in at most one pane of any scope. `PaneWorkspace.tsx`
  renders the leaves as flat, absolutely positioned siblings (`layoutPanes` turns the tree into
  boxes), so reshaping the tree never remounts a pane: the board keeps its search and scroll, and
  a ticket keeps its transcript, browser canvas and plugin iframes. The zoomed pane fills the
  workspace while the others stay mounted underneath, hidden.
- **Opening tickets.** Clicking a card runs `openTicket`: an open ticket gets focused, otherwise
  it replaces the ticket pane just right of the board, or the board splits 60/40 with the ticket
  on the right. Links inside a ticket pane (child rows, the parent crumb, dependency links, a
  plugin's open-ticket request) replace that pane's content through `useOpenTicket`
  (`components/paneContext.ts`), or focus the pane already showing that ticket. Cards are
  highlighted when their ticket is open in a pane, most strongly in the focused one.
- **File panes.** `views/FilePane.tsx` shows one file in full through the File viewer endpoints
  (see "File viewer"). Its `root` is `{ ticketKey }` (the ticket's workdir) or `{ projectId }`.
  File links in chat (`harness://file/…` or plain paths, `shared/src/fileLinks.ts`) render as
  `.file-link` anchors in `components/Markdown.tsx` and call the store's `openFile`. A link's own
  `?ticket=`/`?project=` names its root, else the `FileLinkScope` the text renders in (the ticket
  pane's ticket, the Inbox session's dispatched project; `state/fileOpen.ts`). `openFile` in
  `state/panes.ts` focuses the pane already showing that file and moves it to the link's lines
  (switching to the File tab), else shows it in the pane it's opened from when that's a file pane
  (the palette's file browser over one), else reuses a file pane just right of that pane, else
  docks a new one on its right. `FileViewer.tsx` (loaded lazily) draws the file with
  @pierre/diffs' `File`: the syntax theme, line numbers, `startLine..endLine` as its selected
  lines, scrolled into view on open and when a link moves the pane (not when you pick lines in
  the gutter, which updates the pane's range in place with `setFileView`). A file with
  uncommitted changes in a repo (`git.dirty` or `git.untracked`) gets a Diff tab, a
  `MultiFileDiff` of HEAD against the working tree (a `PatchDiff` of git's patch when a side is
  binary or too big), with the Changes tab's `lineDiffType` and hunk separators. Contents and diff
  refetch on window focus, reconnect, the ticket's workdir or branch changing, and the refresh
  button. File panes persist with the rest of the tree, follow a ticket rename, and close when
  their ticket is deleted. `scripts/file-pane-check.ts` drives the whole flow against the real
  service.
- **Torn-off tabs.** Any tab of a ticket pane (Spec, Activity, Transcript, Agents, Tickets,
  Changes, Details, Browser, sub-agent and plugin tabs), one chip of its browser strip, or its
  composer can be torn off into a pane of its own: a `ticketTab` leaf, `tab` being a `TicketTab`
  or the reserved `"composer"`, and `browserTab` pinning a Browser pane to one browser tab.
  `views/TicketTabPane.tsx` renders it with a slim header (grip, key, the tab's name, a pinned
  page's title; More has Return to ticket and the Move pane rows) and no strip. Its body is the
  ticket pane's own (`TicketTabBody`, `MessageComposer`), with the same handlers, so it's fully
  working, and it registers the ticket's actions (`useTicketActions`) and carries
  `data-pane-ticket`, so the palette's ticket commands, j/k/Space/g/G and `i` (the ticket's one
  composer, wherever it is: `focusTicketComposer`) work from it. A pinned browser pane has no chip
  strip and closes when its tab does; a whole Browser tab torn off keeps its strip. Identity is
  `tornKey` = ticket + `tornId` (`browser:<n>` for a pinned tab, else the tab's strip entry, so a
  sub-agent's transcript is the Agents tab's; or `composer`), deduped by `normalize`,
  `checkPanes`, `dropContent` and `replaceContent`; a rename follows it and deleting the ticket
  closes it; closing the ticket pane leaves it open. Across a window's scopes (its board plus every
  pop-out) the store ops dedupe too: `dropInStore` brings a ticket or tab back from a pop-out
  instead of opening it twice, and moves a ticket pane showing the tab it just tore off to the
  first tab still there. `tornOffTabs(store, ticketKey, boardScope)` says which tabs are torn off
  and where, read from the shared store so the main window and pop-outs agree. The ticket pane
  keeps a torn-off tab in its strip with a mark; selecting it shows "Transcript is in another
  pane / window" with **Return to this window** (`returnTab`: close that pane or pop-out, then
  show and focus the tab in the ticket pane). A torn-off chip's canvas gets the same placeholder,
  and a torn-off composer leaves a one-line bar. Closing a torn-off pane any other way brings the
  tab back by itself, since the placeholder is derived from the store. Each tab, chip and the
  composer's grip has a context menu: Open to the Right/Below/Left/Above, Open in New Window, and
  Return to this window once torn off. `scripts/tear-off-check.ts` drives all of it against the
  real service and real Chrome.
- **Drag to split.** Board cards, a conductor's child rows, a pane's header grip, a ticket's tab
  buttons, browser chips and the composer's top-edge grip are drag sources (`dragProps` in
  `components/paneDrag.tsx`). They put the ticket key (`application/x-harness-ticket`), the pane's
  leaf id (`application/x-harness-pane`) or `{ ticketKey, tab, browserTab? }` as JSON
  (`application/x-harness-ticket-tab`) in the DataTransfer, along with a compact key-and-title
  chip (plus the tab's name) as the drag image. While one is being dragged, `PaneWorkspace` shows a drop
  layer over every pane, above plugin iframes and the browser canvas (which would otherwise
  swallow the drag). The layer is `no-drag` so the titlebar's window-drag regions don't take the
  drop. `zoneAt` picks the half of the pane under the pointer: the pane's diagonals cut it into
  four triangles, ties go to left/right, and the centre goes to the right. The preview is the
  dropped pane's box in the layout that would result (`dropPreview`), and drop runs `dropInStore`
  (`applyDrop`: `dropContent` for a ticket or tab, `movePane` for a pane, across the window's
  pop-outs). A ticket or torn-off tab that's already open moves with its pane and keeps its tab,
  and a pane over itself isn't a target. **Out of the window:** `dragProps`' shared `dragend`
  asks `dragOutPoint` (`state/dragOut.ts`): a drag nobody took (`dropEffect` "none") let go
  outside the window's outer bounds pops what it carries into a window under the pointer. A grip
  pops its pane out (`popOut`); a card or child row moves its ticket's open pane, else opens a new
  ticket leaf; a tab, chip or the composer moves its torn-off pane, else opens a new one
  (`popOutContent`, deduped like `dropContent`; content already in a window brings that window
  forward). Escape ends a drag with the pointer inside the window, so it never pops out; a drag
  let go over another app does, since no other app takes our types. Docking against the board leaves
  it 60%, the same split a click makes, while any other pane is split in half. A pane moved
  beside a sibling in its own split, along that split's axis (the right of three panes dropped
  between the other two), just changes places, and every pane keeps its size (`reorderSibling`).
  Dropping it where it already is isn't a target. Drags that don't
  carry our types (files, text) are ignored. The layer goes away on drop, on dragend (Escape
  cancels a native drag with a dragend), or on the first buttonless mouse move if the source
  left the DOM mid-drag. The keyboard route is a card's or row's context menu (Open to the
  Right/Below/Left/Above). It splits the row's own pane, else the focused pane, else the board
  (`splitTarget`), and it skips a pane already showing that ticket. The board's cards take a
  keyboard cursor (see Keyboard below), and Enter opens the one it's on. ⇧⌘Enter opens it in a
  new pane instead (`openTicketInNewSplit`): it splits the pane Enter would have replaced 50/50,
  so [board, A] becomes [board, A, B], and with no ticket pane beside the board it acts like Enter. A ticket pane's More menu has a Move pane section with a row for each other
  pane (the board, then each open ticket). Each row has ← → ↑ ↓ buttons that call `movePane`,
  so you can re-dock a pane from the keyboard, since the grip itself is pointer-only.
- **Dividers.** Each boundary between split children is a `role=separator`: drag it (previewed
  straight onto the DOM, committed once on release), arrow keys (Shift for bigger steps),
  Home/End, double-click to make the panes equal. A drag or key moves every sibling on each side
  of the divider together (`resizeSplit`): each side scales in proportion, a pane that reaches its
  minimum stays there while the rest of its side keeps shrinking. Holding ⌥ (checked on every
  move, and on ⌥ down/up mid-drag) resizes only the two panes touching the divider. Equalize
  Panes (⌘=, `equalizePanes`) evens out every split's children, except that the child holding the
  board keeps its share and the others split the rest. ⌘= was Electron's Zoom In; Zoom In/Out
  are gone from the View menu, and Actual Size stays so an old zoom can be undone. While dragging, a full-window overlay
  (`useDragOverlay`, shared with the sidebar's handle) keeps iframes and the browser canvas from
  taking the pointer. Minimums: the board 320 px wide, a ticket or torn-off tab 360 px, a terminal 320 px, a file 360 px, any
  pane (a torn-off composer included) 200 px tall.
  They also hold at layout time. `layoutPanes` gets the workspace's measured size and clamps
  each split's stored sizes (`clampSizes`), so a narrow window or a layout saved somewhere wider
  never shows a pane below its minimum while there's room. The stored sizes stay as they were
  until a divider moves, and a drag starts from the sizes on screen.
- **Focus, close, zoom.** Clicking into a pane, or tabbing into it, focuses it (a faint header
  tint). Focus that code moves with no key or pointer input in the last 300 ms (an autofocus, a
  blocked ticket's reply box) doesn't retarget the focused pane. ✕ (or ⌘W) closes a ticket,
  file or terminal pane and its neighbours take its room. The board can't be closed, so ⌘W with the board
  focused closes the window. Maximize (⇧⌘↩) zooms a pane. Escape ends a zoom, or else closes the
  focused ticket or file pane (never while a text field, modal, menu, the palette or a terminal has the
  focus, and never a terminal pane: Escape belongs to the shell). Deleting a ticket closes its
  pane, and a renamed key follows the rename.
- **Pop-out windows.** Every pane but the board (and a New session, which isn't stored, so a
  window couldn't read it) has a pop-out button beside Maximize (⇧⌘O for the focused pane), and a
  drag out of the window does the same (see Drag to split), which moves the pane into a window of
  its own; a drag opens it under the pointer (`popoutBounds`' optional point, held by its title
  bar). The pane becomes its
  own scope in the pane store, `popout:<id>`, whose tree is just that leaf with no board
  (`popOut`; `popoutPanes` takes out the board the other operations put back). Everything that
  acts on a pane's scope works there unchanged: tabs, a child link replacing the pane, a
  terminal's title. The move is one store write, so a terminal's session never leaves every scope
  and its shell keeps running; the pop-out's `TerminalPane` re-attaches and replays the
  scrollback. The window opens at `#/popout/<id>/<fromScope>`, over the spot the pane had
  (`main/popouts.ts` `popoutBounds`), and renders `PopoutWindow` instead of the shell: the one pane,
  with "Put back on the board" in place of Maximize, and no grip or Move pane rows. Putting it back
  (`popIn`) docks it beside the focused pane of the board it came from (All projects if that
  project is gone), or focuses the pane already showing that ticket, and brings the main window
  forward on that board. Closing the pane closes the window. Closing the window closes the pane:
  the main process tells the main window (`popout:closed`), which drops the scope, so a terminal's
  shell dies with it. At startup the main window drops pop-outs whose windows aren't open (the app
  quit with them open). While a pop-out has focus, menu commands about its pane (⌘W, the palette, a
  ticket's tabs) go to it, and board-level ones (⌘1, ⌘N, ⌘T, Settings) go to the main window,
  which the Dock icon also brings back.
- **Keyboard.** Every shortcut is a command in one registry (`state/keys.ts`): an id, a label, a
  group, a scope and its chords. The rest follows from that list.
  - *Two tiers.* ⌘ chords work everywhere, text fields and the browser canvas included. Every
    other key (hjkl, Enter, g/G, `/`, `?`, `i`, 1–9, ⌃hjkl, Escape) only moves you around. Those
    keys fire only outside text fields, the canvas, terminals and overlays (a modal, a menu, the
    palette), and they never change a ticket. Actions (Start work, Approve, Approve and take no
    action, Request changes, Re-run review, Cancel run, Mark done, Re-open, Copy key,
    Delete) have no keys at all. `keys.test.ts` fails if one gets a bare key. They're reached from their buttons and from
    the ⌘K palette.
  - *Areas.* An element that owns commands carries `data-keys-scope` (`board`, `ticket`, `list`,
    `sidebar`, or several) and `data-keys-owner` (a unique id). Components register handlers for
    their owner with `useCommands` (`components/commands.tsx`). A falsy handler means the command
    doesn't apply right now (an action that doesn't fit the ticket's status), which also keeps it
    out of the palette. One window `keydown` listener in the shell walks from the focused element
    outward through its areas and runs the first matching command with a handler, ending at the
    global owner. With nothing focused, it starts from the focused pane's area. A list inside a
    ticket pane (a conductor's Tickets tab) therefore takes j/k before the pane's own scroll keys.
    Components' own key handling runs first and wins with preventDefault or stopPropagation (a
    text field's Escape, a menu's arrows, the palette's list).
  - *The menu bar.* `main.ts` builds its items from the registry (`commandItem`). The label and
    accelerator come from the command, and choosing the item sends the id back to the renderer,
    which runs it where the focus is (`runCommand`). The renderer handles the same chords itself,
    and a ⌘ key the page prevents never reaches the menu. A short de-dupe covers the rest. The
    menu is what makes ⌘ chords work from a plugin iframe (out of process, so its keys never reach
    the renderer) and from a terminal (which keeps ⌘ keys from the page). No key forwarding goes
    through the plugin SDK. Shifted punctuation is written as its character (`Cmd+}` for ⇧⌘]),
    because macOS matches key equivalents by the character typed. The browser canvas keeps the
    app's ⌘ chords from its page (`isAppChord`).
  - *Focus follows the keyboard.* Real DOM focus, with a roving tabindex, marks where the keyboard
    is. A keyboard command that changes the focused pane (⌥⌘arrows or ⌃hjkl through
    `paneInDirection`, Enter on a card, ⌘W, Escape) goes through `focusPaneBy`
    (`components/paneFocus.ts`), and the workspace then moves DOM focus into that pane. It goes to
    what last had focus there, else the pane's `[data-pane-autofocus]` element (the board's cursor
    card, a ticket's current tab), else the pane itself. A terminal focuses its own screen. Left
    from a pane on the workspace's left edge goes to the sidebar, and l or → from the sidebar comes
    back.
  - *Board.* The cursor is a ticket key in `BoardPane`'s state, moved with `moveCursor` over the
    columns as rendered (`state/boardNav.ts`). Empty columns are skipped, and the row index is
    kept and clamped. A card that moves column or gets filtered out hands the cursor to the card
    nearest its old spot (`resolveCursor`). The cursor reaches cards as a boolean prop, so a move
    re-renders two cards. ⇧⌘Enter (`board.openSplit`) shares its chord with Maximize: the board's
    scope is innermost, so on the board it wins, and the dispatcher marks every command on a chord
    it handled for the menu de-dupe, so Maximize doesn't also run.
  - *Ticket pane.* The tabs are a `role=tablist` over `visibleTabsWithChanges` (built-in tabs with
    Changes ahead of Details, then plugin tabs), with ⇧⌘[ / ⇧⌘] (`nextTab`, wrapping), 1–9 and ←/→ on a focused tab. j/k, Space and g/G
    scroll the current tab's own scroller. `i` focuses the composer, and Escape there hands focus
    back to the current tab.
  - *Lists and overlays.* The sidebar, the Inbox and a conductor's Tickets tab are roving lists
    (`useRovingList`: j/k/↑/↓, g/G/Home/End, one tab stop). Menus focus their first item, move with
    ↑/↓ and give focus back to their button. Modals trap Tab and restore focus when they close.
  - *Palette and overlay.* ⌘K (`views/CommandPalette.tsx`) lists the commands that apply where the
    focus was (`availableCommands`: the focused area's actions first, then its other commands, then
    the global ones), places to go, and tickets. A handler can carry the label it has right now
    (`{ label, run }`), so a ticket's actions read as its buttons do: ticket.approve is "Approve and
    merge" or "Approve and open PR", and the split button's other choices are `ticket.land.merge`,
    `.pr` and `.custom` (`landCommands` in `state/approveMenu.ts` drops the one the primary already
    names). The registry label, and a spec's `keywords` ("Reopen ticket" for Re-open…), still match.
    Where the focus was is read generously: a pane that has the focus itself (a click on its
    title or text) counts as its command area inside it, and a board card borrows the Actions (only
    those, never its keys) of its ticket's open pane (`data-pane-ticket`), since a click on a card
    opens the ticket but leaves the focus on the card. Loaded tickets match at once, and
    `searchTickets` adds the rest after 150 ms. `rankCommands` (`state/palette.ts`) ranks
    subsequence matches, with a label prefix first, then word starts, then runs, then scattered
    letters, and recent picks break ties. `>` limits the list to commands and `#` to tickets. `?`
    and ⌘/ open the shortcuts overlay, which is rendered from the registry.
  - *File browser.* `@` (or ⌘P, Open File…) turns the palette into a file browser. It searches one
    root, picked when the palette opens (`paletteFileRoot`): the focused ticket pane's ticket, else
    the focused file pane's root, else the board's project. The All projects board with neither
    focused has no root, and says so. It searches with `ticketFiles`/`projectFiles` and
    `{ ignored: true, kind: "file" }` after 150 ms, keeps the server's order, marks matches
    with `matchLabel`, and tags the matches the server says are ignored. `parseFileQuery` splits `path:12`, `path:12-20` or `path#L12-L20` off the
    query, and Enter opens the file at those lines through the store's `openFile`, beside the
    pane the palette was opened over. An empty query lists that root's recently opened files
    (`harness.palette.recentFiles`, kept apart from the commands' recents). Without a prefix, a
    query that reads as a path (`looksLikePath`) adds up to five files after the commands and
    tickets. `scripts/palette-files-check.ts` drives it against the real service.
  - *Rings.* `html[data-input]` is `keyboard` after a keyboard command or Tab, and `pointer` after
    any pointer press (`state/inputModality.ts`). In keyboard mode, the pane the keyboard acts on
    (or the sidebar) gets an inset accent ring and the board's parked cursor a dashed outline.
    Elements get `:focus-visible` rings from `--focus`. A click never shows any of them.
- **Routing.** `#/board/<project>` is the board's filter, `#/board/group/<name>` a project
  group's board and `#/board/all` All projects. `#/board/<project>/ticket/<KEY>[/<tab>]`
  still works as a link (Inbox, New session, the test and screenshot scripts): arriving at it
  opens the ticket the way a card click does. The route the app launches with opens its ticket
  in a mount effect, never during render. Until the panes catch up, the mirror below leaves the
  hash alone. After that the hash mirrors the focused ticket
  pane with `history.replaceState` (`mirrorRoute`), and with no ticket focused it's just the
  board. Opening an already focused ticket is a no-op, so the two never fight. All of this is per
  scope: `#/board/<project>/ticket/<KEY>` opens the ticket in that project's panes, and the mirror
  reads the route's scope. Leaving for Inbox or Settings, or for another project, and coming back
  restores that board's panes.
- **Project groups.** The sidebar lists the groups (`projectGroups`) under All projects,
  alphabetically, each with the count pill of its projects' tickets (`sidebarCounts` `byGroup`);
  the project list below stays flat. The command palette offers `Board: <group>` beside the
  project boards. Project settings' Group field (`components/GroupSelect.tsx`, rows from
  `groupRows` in `shared/src/state/groups.ts`) lists the groups and, for a typed name no group has
  in any case, a `New group "<name>"` row, so Enter completes to an existing group or starts the
  typed one. On a group's board a New session defaults to the last used project when it's in the
  group, else the group's first project by name (`composerCandidates`), and a terminal opens at
  home. `app/scripts/groups-check.ts` drives all of it in the built app.
- **Window chrome.** Only the top-left pane's header (the zoomed one while zoomed) makes room for
  the traffic lights and the sidebar toggle when the sidebar is collapsed. Headers along the top
  edge drag the window, apart from their controls. The board header sheds extras through a
  container query when its pane is narrow. A ticket pane's titlebar does the same. It hides the
  model badge below 460 px and the status pill below 380 px, then the key truncates and the row
  clips, so its buttons never run into the next pane. The titlebar is the container, not the pane:
  a container is the containing block for fixed descendants, which would trap modals inside the
  pane.
- **Menus.** `MenuButton` (`components/bits.tsx`) renders its menu in a portal with fixed
  positioning, so a pane's `overflow: hidden` can't clip it. `placeMenu` (`menuPlacement.ts`)
  keeps it inside the window. It shifts the menu left or right at the sides and flips it above
  the trigger near the bottom. When the menu doesn't fit either way, it goes on the roomier side
  and scrolls. Menus are styled with `menuClassName` rather than by descendant selectors.
- **New session panes.** ⌘N, the sidebar's New session, the palette, a project's "New session
  here" and `#/compose` open a **compose** pane (`{ kind: "compose", id }` in `state/panes.ts`,
  never persisted) on the right of the focused pane, one more each time. It holds a local blank
  draft (`blankDraftTicket`); the first change that makes it non-empty creates the draft ticket and
  swaps the leaf to that ticket in place, keeping its id and size. From then on it's a ticket
  pane: `TicketDetail` renders the draft editor while `ticket.draft` is set, and the ticket's tabs
  once it's submitted (on any device). The editing state lives outside React in a `DraftSession`
  per pane leaf (`state/draftSession.ts`), so it survives that swap and a move to another project
  (which re-keys the pane with `renameTicketKey`); edits typed while the first POST is out are
  rebased onto its response. Closing a compose or draft pane (✕, ⌘W, Escape, More → Close) goes
  through `requestClosePane` (`components/draftClose.ts`): an empty one closes (a saved empty draft is deleted), anything else asks
  Save draft (the default), Discard draft or Cancel. The editor has the project picker with
  Task / Conductor beside it, the prompt, the Options disclosure (always collapsed at first, with
  `newSessionOptionsSummary` as its label, opened by itself when `optionsNeedAttention`), and
  Plan first (⇧⌘↩) and Start session (⌘↩).
- **Terminal panes.** New ▾ → New terminal in the sidebar (a split button whose main part is
  still New session ⌘N), File ▸ New Terminal (⌘T) and a project's context menu call the store's
  `openTerminal(projectId?)`. It picks the board (`terminalScope`: the board on screen, a
  project's own board from its settings, otherwise the board last shown or All projects) and the
  folder (`terminalCwd`: the project's `path`, `~` on All projects or for an unknown project).
  Then it runs `openTerminal` in that scope, which docks the terminal on the right of the focused
  pane (half of it) or of the board (40%) and focuses it, and goes to that board if it isn't on
  screen. Each call adds a pane. The content's `sessionId` is `t:<uuid>` (`newTerminalContent`)
  and names the PTY. It isn't the leaf id: leaf ids come from a per-window counter, so two
  windows can mint the same one before either sees the other's write, and loading re-ids a
  duplicate. A shell must never be handed to the wrong pane, and a UUID never collides. Parsing
  drops a terminal whose session id the main process would reject, and a session stored in two
  scopes stays in the first. `views/TerminalPane.tsx` renders it with
  [ghostty-web](https://github.com/coder/ghostty-web), Ghostty's VT core compiled to WASM behind
  an xterm.js-like API, drawn on a canvas. The package is pinned to a `next` build because the
  0.4.0 release doesn't report the mouse to programs like vim and htop. It loads on the first
  terminal, in its own chunk. Its WASM is inlined as a `data:` URL, so it works from `file://` and
  inside the asar with no asset to find, and the CSP adds `'wasm-unsafe-eval'` to `script-src`
  (`connect-src` already allowed `data:`). A FitAddon sizes the terminal to its pane and follows
  resizes. ghostty-web can't change colors after `open()`, so a theme change disposes the
  terminal and makes a new one that re-attaches (`terminalColors` turns the theme's tokens into
  the `#rrggbb` its VT core needs, flattening translucent ones). Attaching (`createAttach`,
  `state/terminal.ts`): data events are held until `ensure` resolves, then the scrollback is
  written and only output past its `end` offset (below) is, so nothing prints twice or goes
  missing whichever order the reply and the events arrive in. A re-attached pane resizes the PTY
  to itself, since `ensure` ignores cols/rows for an existing shell. The shell's title (OSC 0/2)
  goes into the content (`setTerminalTitle`) for the header, else the folder's name. Keys: ⌘
  shortcuts other than ⌘C/⌘V never reach the terminal. ghostty-web marks every key it handles
  with preventDefault, and a prevented ⌘ key never reaches the native menu, so a capture listener
  stops them before the terminal and they go unhandled, as from a text field. ⌃⌘ keys (the
  renderer's own ⌃⌘S) pass through. ghostty-web's custom key handler is the reverse of xterm's:
  returning true means "handled". ⌘C (and Edit ▸ Copy) copies the selection, and a paste goes
  through the terminal's bracketed paste. An exited shell shows its code with Restart, which is
  `kill` then `ensure` under the same session id. Lifecycle: `useTerminalLifecycle`
  (`state/store.tsx`) watches the pane store (`watchPaneStore`, including another window's writes
  re-read on `storage`) and kills every session that's in no scope any more (`closedSessions`).
  That covers closing the pane, removing a project and a close in another window, while moving a
  pane (even to another board) kills nothing. At startup it re-reads the stored panes and kills
  the pane sessions (`t:` ids) none of them show (`orphanSessions` over `list()`), which are left
  over from a renderer reload. Sessions with other ids aren't a pane's, so they're left alone. Shells
  don't outlive the app, so after a relaunch a stored terminal pane starts a new shell in its
  folder. `scripts/terminal-pane-check.ts [--packaged]` drives all of this in the real app over
  CDP, with real key events.
- **Terminals (process side).** `TerminalManager` (`main/terminals.ts`) keeps one PTY per id,
  and the id is the terminal pane's `sessionId`. Each PTY runs the user's login shell (`$SHELL -l`,
  else `/bin/zsh`) with `TERM=xterm-256color` and without `ELECTRON_*` or `NODE_OPTIONS`. The
  preload exposes it as `window.harness.terminal` over `harness:terminal:*` IPC. `ensure(id,
  { cwd, cols, rows })` is idempotent. It spawns on the first call (`~` expands, and a missing
  directory falls back to home), and later calls re-attach to the same shell and return its
  bounded scrollback (1 MiB), so a remounted pane replays what it missed. Output is coalesced
  for a few ms, then broadcast as `terminal:data` to every window, and the exit code goes out as
  `terminal:exit`. Each data event carries the offset its output ends at (UTF-16 code units of
  everything the shell has printed, which keeps counting after the scrollback trims), and
  `ensure` returns the offset its scrollback ends at (`end`). Data events and the `ensure` reply
  are separate IPC messages that can arrive in either order, so the offsets are how a
  re-attaching pane knows which output its scrollback already has. `ensure` doesn't touch unsent
  output, which still goes to other windows showing that shell. An exited session stays until `kill`, so the pane can show the exit. `list()`
  lets the renderer kill sessions no pane shows any more. `kill` sends SIGHUP, then SIGKILL after
  3 s, and every shell is killed on quit. IPC arguments are validated (id pattern, dimensions
  1–1000, writes up to 1 MiB) because the main process trusts nothing from a renderer. node-pty
  is an N-API addon, so its prebuilt `pty.node` loads in Electron without a rebuild. The bundle
  keeps it external, and `package.ts` copies it unpacked beside `app.asar`, where `sign-mac.ts`
  signs it. Its `spawn-helper` ships without the executable bit, which `package.ts` fixes (and
  `pty.ts` fixes for dev). `scripts/terminal-check.ts [--packaged]` drives the bridge in a real
  app over CDP.

## iPhone and iPad app (`ios/`)

The iPhone and iPad app is SwiftUI (version 2.0, which replaced the 1.x React Native app). It's
another client of the same REST + WebSocket API, with no service changes. ios/ARCHITECTURE.md has
the conventions, and ios/README.md the build and test commands.

- **Two halves.** `ios/Harness` is the app target: SwiftUI views, navigation, and platform glue
  (Keychain, camera, haptics, WKWebView). `ios/HarnessKit` is a Swift package with everything that
  doesn't draw: the Codable protocol types, `HarnessClient` (REST) and `HarnessSocket` (WebSocket),
  the board reducer and selectors, and every helper a screen branches on (completion and approve
  menus, tabs, paging, drafts, mentions, markdown, file links, settings rules). It imports
  Foundation only, so `swift test` runs on the Mac host in seconds.
- **Fixture parity with `shared/`.** Logic ported from `shared/` can't drift from TypeScript, so
  board rules (child dimming, Hide child tickets, rollups, key-rename preview, model and permission
  options) match the desktop. Each case file in `shared/fixtures/cases/` runs the real TS functions
  over a list of inputs, and `bun shared/scripts/export-fixtures.ts` writes the outputs as JSON
  into HarnessKit's tests. `swift test` checks the Swift ports against them, and `bun run test`
  fails when the committed JSON is stale. `cases/protocol.ts` holds a sample of every entity and
  event, which the Swift types must decode and re-encode unchanged, so a field added to
  `shared/src/protocol.ts` has to reach Swift too. Reducer scenarios replay real TS actions and
  compare selector probes.
- **Frozen fixtures.** Logic only the phone has (pairing links, the connection probe, saved
  servers, prefs, browser touch input, the plugin web view transport, board columns, the model
  sheet and others) lived in the React Native app's TypeScript. Its outputs are frozen in the
  committed JSON, which is now the spec: the exporter never regenerates them (`FROZEN` in
  `export-fixtures.ts`, or `frozen(module, key)` inside a mixed case file), and `swift test` owns
  them.
- **iPad.** One universal build (device family `1,2`) that allows all four orientations, which
  iPad multitasking (Split View, Stage Manager) needs, so the window can be any size. The screens
  are the phone's, laid out at the window's width. The iPad runs several windows (one AppModel
  and store, a Router per window): at regular width a ticket opens in a window of its own. Any
  ticket tab, any single browser tab and the composer tear off into a pinned window of their own:
  dragged out of the window (the drag carries the window's NSUserActivity, so iPadOS opens it) or
  from the thing's context menu (Open in New Window). A pinned window shows only that one tab,
  fully working, under the ticket's title line. The ticket's other windows show **Return to this
  window** in its place, which closes the pinned window; closing it any other way also brings the
  tab back. Board cards drag out into a full ticket window; the board has no drop target, so a
  drag never moves a card between columns (that's the card's Move to … menu). Two browser views
  of one session stream side by side because each is its own viewer (`viewerId`, "Browser
  tabs"). iPhone and compact width have none of this. `sim-check --ipad` shoots the
  walk-through's screens on iPad simulators. See ios/ARCHITECTURE.md § Windows.
- **Connection.** `harness://pair?url=…&token=…` (the desktop QR code) opens the app through its
  URL scheme, or the in-app scanner reads it; the app probes `GET /health`, then an authenticated
  request, before saving. Tokens live in the Keychain, one per saved Mac, readable after first
  unlock. Updating from 1.x keeps saved Macs, tokens and prefs: when its own Keychain service has
  no item for a key, `KeychainStorage` reads the 1.x app's expo-secure-store item and copies it
  over (same bundle id, so the same access group). ATS allows plain http (Tailscale IPs), and a local-network usage string is set.
  Foregrounding rebuilds the socket and refetches; a 401 (token rotated on the Mac) shows a
  re-pair banner.
- **Board.** On iPhone, five columns as horizontal pages under a status strip with counts; on
  iPad at regular width, all five side by side with their own headers, as on the Mac (they scroll
  sideways when the window is too narrow). Touch and hold a card to move it between columns or to
  the top or bottom (VoiceOver gets the moves as custom actions). The project filter and the
  sidebar live in a Projects sheet (on iPad, a sidebar column beside the section).
- **New session.** `harness://new` starts a blank draft and `harness://new?key=<KEY>` reopens a
  saved one (a draft's `harness://ticket/<key>` link goes there too). It saves lazily like the
  desktop (see "Drafts"), and its Options row holds the same ticket settings rows as the Details
  tab. Cancel on a non-empty draft offers Save draft, Discard draft or Keep editing, and swiping
  the sheet away saves it.
- **Selects.** Every desktop `<select>` is a `SelectMenu` (`ios/Harness/Features/Pickers/SelectMenu.swift`):
  a SwiftUI `Menu` whose label shows the value with the ⌃⌄ glyph. Each option is a `Toggle` whose
  state comes from the parent's value alone (a menu draws it as a checkmark item, with an optional
  subtitle line), so the menu never shows a choice the parent refused. Actions (Refresh model
  list, Add a project…) sit in their own section.
- **Browser tab.** Screencast frames are letterboxed into the stage and swapped only once decoded.
  A tap sends move + down + up, a pan sends wheel events in page pixels, and hold-then-drag sends
  a mouse drag (HarnessKit `BrowserInput`). A hidden text field carries the keyboard (diffed into
  text inserts and Backspaces). A size row under the URL bar, shown by the Size toggle, has the
  Desktop | Mobile control, the Responsive switch and width × height fields (see "Browser tabs");
  the stage size is sent as `resize` only while this viewer owns Responsive (`sizeOwner`, also when
  the service hands it a tab), after the first `browser.state` and only on real changes. Pinching zooms the drawn frame 1–4× around the pinch and two fingers
  pan it (`BrowserZoom`, the port of `shared/src/state/browserZoom.ts`); the page never sees the
  pinch, and one-finger touches map through the zoomed frame. A + button at the end of the tab strip opens a tab (`newTab`); a strip of chips (shown even for a lone
  tab, so it can be torn off) switches (resubscribing with its `tabId`) and closes them. Each Browser view subscribes with
  a viewer id of its own (one UUID per `BrowserTabModel`) and keeps only the frames and states
  for it (`isBrowserEvent`, the port of `isBrowserEventFor`), so a torn-off browser tab and the
  ticket's Browser tab stream at once. See "Browser tabs".
- **Spec and Activity.** The app renders spec images inline, loading each `attachment:<id>` from
  `client.attachmentUrl(id)` (the query token, since the image loader and AVPlayer fetch on their
  own), and shows the Activity tab next to the Spec tab; the children of HARNESS-194 implement
  them. See "Spec revisions and attachments" and "Activity".
- **File viewer.** A link tapped in markdown goes through HarnessKit's `LinkRouting`: http(s),
  mailto and other schemes open outside the app, and a file link (`harness://file/…`, or a bare
  relative or absolute path) pushes the file viewer with `path`, `ticket` or `project`, `start`
  and `end`. A relative link resolves in the ticket or project the markdown belongs to, unless the
  link carries its own `?ticket=`/`?project=`. A triage session (the Inbox) has no folder, so its
  outcome and transcript resolve in the project of the ticket it dispatched, as on the desktop.
  When that ticket isn't loaded, they use its key instead. A session that dispatched nothing has
  no scope, and a relative link from it shows a toast. `FileViewerScreen` loads `FileView` and,
  only when `git.repo && git.dirty`, `FileDiff`, and shows File and Diff tabs (the Diff tab counts
  +added/−removed). Lines are fixed-height rows, so the viewer opens straight at the range. A long
  file is highlighted a window at a time around what's on screen, and colored lines stay colored
  as later windows land. A patch over the highlighter's 60 000-character limit isn't windowed: the
  Diff tab shows it without syntax colors, still with its line tints. The Diff tab numbers each
  line of the patch from its hunk headers (`patchRows`). Pull to refresh reloads both. The pure
  parts are HarnessKit's `FileViewer`, `FileViewerRules` and `FileViewerLoader`.
- **Syntax highlighting.** `ios/Tools/highlighter/highlight.ts` (the Shiki setup from the 1.x
  app: Shiki core, its JavaScript regex engine, 34 languages and 19 themes) is bundled into one
  script at build time (`ios/Tools/build-highlighter.ts`) and runs in JavaScriptCore
  (`HarnessHighlight`), so code colors match the desktop and the Git tab exactly. A view draws
  plain lines in its first frame and swaps colors in when the job finishes. A fixture runs a
  corpus through the real highlight.ts and checks the bundle returns the same tokens and colors.
- **Plugin tabs.** A WKWebView loads the plugin's UI from the service, and the host bridge is a
  fixture-checked port of `shared/src/state/pluginBridge.ts` over `WKScriptMessageHandler` (see
  "Plugins" → transports), with the same injected theme. Plugins get the full theme (appearance,
  themeId, syntaxTheme, tokens) with the old light/dark field.
- **Changes tab.** Built in rather than the git plugin's page in a web view: the diff, file list,
  viewed marks and Unified/Split toggle are SwiftUI, fed by a `ChangesSource`. Today that reads the
  git plugin's `/plugins/git/api/*` routes; a core Changes API would be one more conformance.
  `plugin:git:changes` links open it, and its files open in the file viewer.
- **Themes.** The phone uses the shared theme registry, generated into HarnessKit as a bundled
  resource; `Palette` holds the active theme's tokens as SwiftUI colors, and the status bar,
  navigation and toolbars follow it. Appearance plus the Light / Dark theme picks are stored in the
  Keychain prefs blob and normalized on load.
  `harness://settings?lightTheme=<id>&darkTheme=<id>&theme=<system|light|dark>` applies a setup.
- **Checks.** `ios/Tools/sim-check.ts` runs a simulator walk-through against a real daemon on a
  throwaway home, through the accessibility tree (AXe) and deep links, and saves light and dark
  screenshots of every screen.
- **Builds.** `release/publish-install.sh` archives the Release app with `ios/Tools/build.ts`,
  exports a development IPA (and uploads a TestFlight build), packages and Developer ID signs the
  Mac app, uploads both to the GitHub release of the annotated `app-YYYYMMDD.HHMM` tag on HEAD (it
  refuses untagged, dirty or unpushed commits; the tag's digits are the build number and its
  CHANGELOG.md section is the notes; see CLAUDE.md → Releases), and deploys the install page in
  `release/Install/` plus `manifest.plist` to Vercel. The OTA manifest points at
  `releases/latest/download/Harness.ipa` on GitHub. Every configuration uses the bundle id
  `com.markhuot.harness`; the user-facing version is `MARKETING_VERSION` in `ios/project.yml`.
