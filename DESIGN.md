# Harness — design

An AI coding harness: a background **service** runs agent sessions against local project
directories; a desktop **app** (and later iOS) shows a live kanban board, transcripts,
summaries and an agent-driven browser. Every session is a Jira-style ticket (`NYTIMES-3`).

```
┌──────────────┐  REST + WS (127.0.0.1:7717, bearer token)  ┌─────────────────────────────┐
│ Electron app │ ─────────────────────────────────────────▶ │ harness service (Bun, launchd)│
│ (React UI)   │ ◀──── events: tickets, transcript, frames ─ │  SQLite · orchestrator · runs │
└──────────────┘                                            │  drivers · tools · MCP · CDP  │
   future iOS app ── SSH tunnel / LAN ──────────────────────▶ │  headless Chrome (one tab per │
                                                             │  session, screencast relayed) │
                                                             └─────────────────────────────┘
```

Closing the app never stops agents: runs live in the service, which launchd keeps alive.

## Layout and ownership

| Path | What | 
| --- | --- |
| `shared/src/protocol.ts` | Entities, events, WS messages, request bodies — **the wire contract** |
| `shared/src/client.ts` | Typed REST/WS client (routes below are defined by it) |
| `service/src/config.ts` | Paths (`HARNESS_HOME`, default `~/.harness`), port (`HARNESS_PORT`, default 7717), token |
| `service/src/db.ts`, `service/src/store/*` | SQLite schema + repositories |
| `service/src/events.ts` | In-process event bus (`HarnessEvent`) |
| `service/src/orchestrator/*` | State machine, run queue, scheduler, conductor, triage, watchers, prompts, worktrees |
| `service/src/drivers/*` | `Driver` implementations: `dummy`, `claude-code`, `anthropic-api` |
| `service/src/tools/*` | Tool definitions + `toolsForRun()` |
| `service/src/browser/*` | CDP client + `BrowserService` implementation |
| `service/src/api/*` | HTTP routes, WebSocket, MCP endpoint |
| `service/src/daemon.ts` | Service entrypoint |
| `service/src/cli.ts` | `harness service install|start|stop|status|ensure|uninstall`, `harness new ...` |
| `app/` | Electron main + React renderer |

## Project keys

A project key (`HEL`) prefixes its native ticket keys (`HEL-4`). Keys match
`^[A-Z][A-Z0-9]{0,15}$` after upper-casing, and `TRIAGE` is reserved for triage sessions. An
explicit key on `POST /projects` must be free (409 otherwise); a key derived from the folder
name de-duplicates to `KEY2`, `KEY3`, ...

`PATCH /projects/:id { key }` renames the project's **native** tickets `OLD-n` → `NEW-n` in one
transaction, keeping the numbers: ticket keys, their session keys, and every `dependsOn` that
points at them (in any project). `nextSeq` continues. Tickets mirrored from an external system
(`externalRef` set, e.g. `FOO-123`) keep their keys. The rename is refused with 409 when
another project uses the key or any `NEW-n` already exists as a ticket or session key, and
nothing changes. Clients get `project.upserted`, `ticket.upserted` (renamed tickets and
dependency holders) and `session.upserted` events, and each renamed ticket's transcript gets a
`Renamed OLD-n → NEW-n` status line. Existing branches (`harness/old-n`) and worktree
directories (`worktrees/OLD-n`) keep their names: they're stored on the ticket, so work in
progress isn't disturbed. Transcript and summary text isn't rewritten.

## Runtime paths

- `$HARNESS_HOME` (default `~/.harness`): `harness.db`, `token` (random, 0600), `logs/`,
  `worktrees/<KEY>/`, `chrome-profile/`, `service.json` (`{ port, pid, startedAt }`).
- Tests always set `HARNESS_HOME` to a temp dir and use port 0 / an ephemeral port.
- launchd label `com.markhuot.harness`, plist `~/Library/LaunchAgents/com.markhuot.harness.plist`,
  runs `bun <repo>/service/src/daemon.ts`, `KeepAlive` true, logs to `$HARNESS_HOME/logs/service.log`.

## Ticket lifecycle

Columns: **planning → in_progress → blocked → review → done**.
Humans own planning and blocked, agents own in_progress, review is shared.

| Trigger | Effect |
| --- | --- |
| Create with `start: true` | status `in_progress`; enqueue **work** run, prompt = the brief |
| Create with `start: false` | status `planning`; enqueue **plan** run (agent drafts a plan, may call `update_plan`) |
| Human message in planning | enqueue plan run with the message |
| `POST /start` (or drag to in_progress) | status `in_progress`; prepare workdir (worktree if enabled); enqueue work run: "The plan is approved. Begin work." + plan |
| Human message in in_progress | enqueue work run with the message (queued behind any active run) |
| Agent calls `block(question)` | status `blocked`, `blockedReason` set, summary posted |
| Human message while blocked | status `in_progress`, reason cleared, enqueue work run with the message |
| Agent calls `submit_for_review(summary)` | status `review`, `agentReview=pending`, `humanReview=pending` (or `approved` when the project doesn't require human review), summary posted; after the run ends enqueue **review** run |
| Work run ends and ticket still in_progress | auto-submit for review; summary = last assistant text (system author) |
| Work run fails | status `blocked`, `blockedReason` = error |
| Agent `review_decision(approve)` | `agentReview=approved` |
| Agent / human `request_changes` | status `in_progress`, both reviews reset to pending, enqueue work run with the notes |
| Human `POST /review {approve}` | `humanReview=approved` |
| Both approved | ticket is **ready** (still in review). UI shows "Complete". |
| `POST /complete` | enqueue **complete** run ("finalize: merge the worktree branch / clean up" + instructions); on success → `done`. `skipAgent` → `done` immediately |
| Drag to done | `done` without an agent run |
| `POST /cancel` | abort active run (run status `cancelled`), ticket status unchanged |
| Ticket → done | scheduler starts dependents that have `autoStart` and all deps done; parent conductor notified |

Review runs start from a **fresh** driver conversation (independent reviewer) and never
write driver state back to the session. All other ticket runs resume the session's state.

Runs are serialized per session and limited globally by `settings.maxConcurrentRuns` (default 4).
`ticket.busy` / `session.busy` is true while a run is queued or running.

### Conductor

A ticket of `kind: "conductor"`. Created with `start: true` it runs **conductor** runs whose
tools create and steer child tickets (`parentId` = conductor). Children created by a
conductor default to `autoStart: true`: they start as soon as all `dependsOn` are done
(immediately if none). Whenever a child changes status the orchestrator enqueues one
(coalesced) conductor run describing the changes. The conductor acts as the human reviewer
for its children (`review_ticket`) and completes them (`complete_ticket`). When all children
are done and the conductor run ends without submitting, the orchestrator submits the
conductor for review automatically.

### Watchers and triage

A watcher is a command that prints NDJSON work items (see `~/Sites/Jira/watch-jira.js`:
lines carry `key`, `summary`, `url`, `updated`). `mode: "loop"` re-runs the command as soon
as it exits (for blocking watchers), `mode: "interval"` runs it every `intervalSec`.
Items are normalized to `WorkItem` (`key` ← key|id, `title` ← summary|title, `version` ←
updated|version) and deduped by `(watcher, key, version)`.

Each new item starts an **ephemeral triage session** (`kind: "triage"`, key `TRIAGE-n`,
visible in the app's Inbox, not on the board). The triage prompt includes the item, the
project list and the mapping-resolved project suggestion. Triage tools:
`list_projects`, `dispatch_ticket` (creates a local ticket whose key **is the external key**,
e.g. `FOO-123`, in the mapped project; `conductor: true` for big jobs), `decline_work`.
If a local ticket with that key already exists, dispatch posts the update as a message
instead of creating a duplicate.

Mappings: `pattern` is a key prefix (`FOO` matches `FOO-123`) or `/regex/` against the key.
First match wins (longest prefix first).

## Tools

Harness tools (always exposed, via MCP for claude-code):

| Tool | Run kinds | Input |
| --- | --- | --- |
| `post_summary` | all ticket kinds | `{ summary }` |
| `update_plan` | plan | `{ plan, title? }` |
| `block` | work | `{ question }` |
| `submit_for_review` | work, conductor | `{ summary }` |
| `review_decision` | review | `{ decision: "approve"\|"request_changes", notes }` |
| `create_ticket` | conductor | `{ title, description, depends_on?: string[], auto_start?: boolean }` (depends_on takes keys returned by earlier create_ticket calls) |
| `list_tickets` | conductor | `{ scope?: "children"\|"project" }` |
| `get_ticket` | conductor | `{ key }` |
| `start_ticket` | conductor | `{ key }` |
| `message_ticket` | conductor | `{ key, text }` |
| `review_ticket` | conductor | `{ key, decision, notes }` |
| `complete_ticket` | conductor | `{ key, instructions? }` |
| `list_projects` | triage | `{}` |
| `dispatch_ticket` | triage | `{ project_key, key?, title, description, start?, conductor? }` |
| `decline_work` | triage | `{ reason }` |
| `browser_open` | plan, work, review, conductor | `{ url }` |
| `browser_content` | ″ | `{ selector?, format?: "text"\|"html", max_chars? }` |
| `browser_click` | ″ | `{ selector }` |
| `browser_type` | ″ | `{ selector, text, submit? }` |
| `browser_eval` | ″ | `{ expression }` |
| `browser_screenshot` | ″ | `{}` → image |
| `permission_prompt` | all, for drivers with `usesPermissionPromptTool` (claude-code, dummy) | `{ tool_name, input, tool_use_id }` → text JSON `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`; calls `HarnessOps.requestApproval`. Called by the CLI itself (`--permission-prompt-tool`), not the model |

Harness tools are advertised over MCP with `readOnlyHint: true`: Claude Code refuses
non-read-only MCP tools in `--permission-mode plan`.

Native tools (only for drivers with `hasBuiltinTools: false`): `bash {command, timeout_ms?}`,
`read_file {path, offset?, limit?}`, `write_file {path, content}`,
`edit_file {path, old_string, new_string, replace_all?}`, `list_files {path?, pattern?}`.
Paths resolve relative to the run cwd. Review, plan and conductor runs get read-only native
tools (`read_file`, `list_files`, `bash`); triage gets none.

`toolsForRun(kind, driver)` in `service/src/tools/index.ts` is the single source of truth.

## Drivers

- **dummy** — deterministic, no network. Used by tests and for fast manual testing (see below).
- **claude-code** — wraps the `claude` CLI (`claude -p --output-format stream-json --verbose
  --include-partial-messages`), which carries your **team-plan OAuth** login
  (`claude auth login --claudeai`; status via `claude auth status --json`). Harness tools are
  injected with `--mcp-config` pointing at `POST /mcp/:runToken`. Conversation continuity via
  `--resume <session_id>` (stored as driver state). Permission mode from settings (default
  `acceptEdits`: org policy can disable `bypassPermissions`, which then silently falls back to
  `default`); plan runs use `--permission-mode plan`. Every prompt the mode doesn't auto-allow
  goes to `--permission-prompt-tool mcp__harness__permission_prompt` → `requestApproval` → a
  human. The harness server entry sets `alwaysLoad: true` so its tools skip ToolSearch deferral.
- **anthropic-api** — direct Messages API with an API key (settings or `ANTHROPIC_API_KEY`),
  streaming, native tool loop over the harness + native tools. Message history is driver state.

### Dummy driver script

Streams its text word by word (`HARNESS_DUMMY_DELAY_MS`, default 15ms; tests use 0).
Directives are read from the run prompt:

| Kind | Behaviour |
| --- | --- |
| plan | text `Here's a plan for: <first line>` + numbered steps; calls `update_plan` |
| work | text `Hello from the dummy driver! You said: "<prompt>"`; then: `/block <q>` → `block`; `/fail <msg>` → error; `/browse <url>` → `browser_open` + `browser_content`; `/bash <cmd>` → `bash` if present; `/approve <tool> [json input]` → `permission_prompt` (→ `requestApproval`, the same path claude-code uses; the dummy driver has `usesPermissionPromptTool`), then on allow text `Approved <tool>` + `submit_for_review`, on deny the run just ends; otherwise `post_summary` + `submit_for_review` |
| review | calls `review_decision` approve, or request_changes when the prompt contains `[dummy:reject]` |
| complete | text + `post_summary("Completed.")` |
| conductor | first run: creates one child per `- ` bullet in the prompt (default two, second depends on first); later runs: approve (`review_ticket`) children whose agent review approved and human review pending, `complete_ticket` approved ones, `submit_for_review` when all done |
| triage | reads `Suggested project: KEY` from the prompt; `[unscoped]` in the item → `decline_work`; `[big]` → `dispatch_ticket` with `conductor: true`; no suggestion → decline; else `dispatch_ticket(start: true)` |

## HTTP API

All routes require `Authorization: Bearer <token>` (WS: `?token=`), except `GET /health`.
Responses are `{ data }` or `{ error }` with a 4xx/5xx status.

```
GET    /health
GET    /projects                 POST /projects            PATCH/DELETE /projects/:id
GET    /tickets?projectId=       POST /tickets
GET    /tickets/:key             PATCH/DELETE /tickets/:key      → TicketDetail / Ticket
POST   /tickets/:key/start | /messages | /review | /complete | /cancel | /agent-review
GET    /tickets/:key/summaries
GET    /sessions?kind=           GET /sessions/:id         GET /sessions/:id/transcript?after=seq
GET    /watchers                 POST /watchers            PATCH/DELETE /watchers/:id
POST   /watchers/:id/run         POST /watchers/inject { source, item }
GET    /mappings                 POST /mappings            DELETE /mappings/:id
GET    /drivers                  POST /drivers/:id/login
GET    /settings                 PATCH /settings
GET    /browser/:sessionId       POST /browser/:sessionId/navigate { url }
POST   /mcp/:runToken            (MCP streamable-HTTP, JSON responses; run-scoped token)
GET    /ws?token=                (WebSocket; ServerMessage / ClientMessage)
```

Every mutation emits a `HarnessEvent`; the WS forwards all events to every client, except
`browser.frame`/`browser.state`, which go only to clients subscribed to that session.

## Testing

`bun test` in each package. No test touches the network or a real model; the claude-code
driver is tested against a fake `claude` executable that replays stream-json. Browser tests
use the local Chrome and skip when it is missing. End-to-end tests boot the service on an
ephemeral port with a temp `HARNESS_HOME` and drive it through `HarnessClient`.
