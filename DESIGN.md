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
| `shared/src/state/*` | Client state shared by the desktop and iOS apps (`@harness/shared/state`): reducer + selectors, conductor, model, project-key, tab, markdown and label helpers, icon paths, the plugin host bridge. No React, DOM or native APIs |
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
| `service/src/plugins/host.ts` | Plugin discovery, loading, `/plugins/<id>/api` + `/ui` serving, tab `when` evaluation |
| `plugins/sdk/` | Plugin API: `server.ts` (types, `definePlugin`) and `harness-plugin.ts` (iframe bridge, `connect()`) |
| `plugins/git/` | Built-in git plugin: the ticket **Changes** tab |

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

Old keys keep working. Each rename records `OLD-n → ticket id` in `ticket_key_aliases`
(migration 5), so bookmarks (`#/…/ticket/OLD-2`), conductors calling `get_ticket` /
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
| Work/complete/conductor run ends after a Claude Code classifier denial | status `blocked` with a classifier `pendingApproval` (see "Permissions"), even if the agent submitted |
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
for its children (`review_ticket`) and completes them (`complete_ticket`). So in the app a
child "needs you" only when it is blocked or waiting on a tool approval; a child in Review
with the human review pending is the conductor's to act on (it stays dimmed on the board and
isn't counted in the rollup). Top-level tickets in Review still wait on the human. When all children
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
tools (`read_file`, `list_files`, `bash`); triage gets none. Every native call first asks
`HarnessOps.checkPermission` (the PermissionGate, see "Permissions"); a deny becomes the tool's
error result.

`toolsForRun(kind, driver)` in `service/src/tools/index.ts` is the single source of truth.

## Drivers

- **dummy** — deterministic, no network. Used by tests and for fast manual testing (see below).
- **claude-code** — wraps the `claude` CLI (`claude -p --output-format stream-json --verbose
  --include-partial-messages`), which carries your **team-plan OAuth** login
  (`claude auth login --claudeai`; status via `claude auth status --json`). Harness tools are
  injected with `--mcp-config` pointing at `POST /mcp/:runToken`. Conversation continuity via
  `--resume <session_id>` (stored as driver state). `--permission-mode` comes from the ticket's
  harness permission mode (see "Permissions"); plan runs use `--permission-mode plan`. Every
  prompt the mode doesn't auto-allow goes to `--permission-prompt-tool
  mcp__harness__permission_prompt` → `requestApproval` → a human. The harness server entry sets
  `alwaysLoad: true` so its tools skip ToolSearch deferral.
- **anthropic-api** — direct Messages API with an API key (settings or `ANTHROPIC_API_KEY`),
  streaming, native tool loop over the harness + native tools. Message history is driver state.

### Permissions

A ticket's **permission mode** is `ticket.permissionMode ?? project.permissionMode ??
settings.permissionMode` (`resolvePermissionMode` in `shared/src/permissions.ts`; default
`auto`). Null at a level means "inherit". Plan (and triage) runs are always read-only.

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

**Classifier denials → approval cards.** The orchestrator collects a work/complete/conductor
run's `permission_denied` events, dropping any whose exact call (`grantKey`) later succeeded in
the same run. When the run succeeds and a denial is left, the last one becomes a
`pendingApproval` (`source: "classifier"`, `reason` = the classifier's reason, tool + input of
the denied tool_use):
- the agent called `block` (the system prompt tells work runs to; complete/conductor runs are
  told to stop): the approval is attached to that block, its question stays `blockedReason`;
- the agent submitted anyway (measured: sonnet reports the denial and calls
  `submit_for_review`): review → blocked with the card, no review run;
- otherwise in_progress (or review, for a complete run) → blocked, as `requestApproval` does.
- The tool is already in `ticket.allowedTools` (auto mode ignores bare `Bash`, below): no
  card; the call gets a one-time grant and the run is resumed ("…the human allows Bash on this
  ticket. Retry it now"), at most `MAX_AUTO_RETRIES` (3) times in a row before asking a human
  (a human answer or message resets the count).
Not in read_only, not for review/plan/triage runs. allow_once / allow_tool / deny answer it like
any card; allow_tool on a classifier card also adds a one-time grant for the denied call, so
the retry passes as an exact rule.

**Human grants → the CLI.** Work/complete/conductor runs get `RunRequest.grants` = `{ tools:
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

Measured against claude 2.1.283 (`--permission-mode dontAsk` to isolate rule matching, then
auto): `Bash(<cmd>)` with spaces, quotes, `&&`, `;`, `||`, backticks, escaped parens and
backslashes matches exactly; an exact rule overrides auto mode's classifier. No match for
pipelines (checked per segment), globs (`*` makes the rule a wildcard; `\*` didn't match
either), redirections (`>`, `2>/dev/null`) or `$(…)`; multi-line commands and a trailing
backslash aren't risked. Auto mode also strips allow rules it treats as arbitrary code
execution before its classifier runs: bare `Bash` and `Bash(npx:*)` had no effect (they work in
ask mode). One-time grants match on tool + canonical input; a Bash call's `description` is
ignored (the model rewrites it on a retry). A matching one-time grant is consumed before
`allowedTools` is checked, so it never lingers.

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
5. `ask` → `requestApproval` (source `policy`). `auto` → the classifier: `allow` → run;
   `soft_deny` → `requestApproval` with the classifier's reason (source `classifier`);
   `hard_deny` → deny with the reason. Timeout (60s), error or `classifier: "off"` →
   `requestApproval`, never allow.

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
run kind, ticket title + brief and the last 16 transcript lines. Measured: 4–9 s per call
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

### Dummy driver script

Streams its text word by word (`HARNESS_DUMMY_DELAY_MS`, default 15ms; tests use 0).
Directives are read from the run prompt:

| Kind | Behaviour |
| --- | --- |
| plan | text `Here's a plan for: <first line>` + numbered steps; calls `update_plan` |
| work | text `Hello from the dummy driver! You said: "<prompt>"`; then: `/block <q>` → `block`; `/fail <msg>` → error; `/browse <url>` → `browser_open` + `browser_content`; `/bash <cmd>` → `bash` if present (through the PermissionGate, so the permission flow runs offline; tests inject a fake classifier); `/approve <tool> [json input]` → `permission_prompt` (→ `requestApproval`, the same path claude-code uses; the dummy driver has `usesPermissionPromptTool`), then on allow text `Approved <tool>` + `submit_for_review`, on deny the run just ends; otherwise `post_summary` + `submit_for_review` |
| review | calls `review_decision` approve, or request_changes when the prompt contains `[dummy:reject]` |
| complete | text + `post_summary("Completed.")` |
| conductor | first run: creates one child per `- ` bullet in the prompt (default two, second depends on first); later runs: approve (`review_ticket`) children whose agent review approved and human review pending, `complete_ticket` approved ones, `submit_for_review` when all done |
| triage | reads `Suggested project: KEY` from the prompt; `[unscoped]` in the item → `decline_work`; `[big]` → `dispatch_ticket` with `conductor: true`; no suggestion → decline; else `dispatch_ticket(start: true)` |

## HTTP API

All routes require `Authorization: Bearer <token>` (WS: `?token=`), except `GET /health` and
the static plugin UIs under `/plugins/:id/ui/`.
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
GET    /drivers                  POST /drivers/:id/login   GET /drivers/:id/models?refresh=1
GET    /settings                 PATCH /settings
GET    /browser/:sessionId       POST /browser/:sessionId/navigate { url }
GET    /plugins                  GET /tickets/:key/tabs    → PluginInfo[] / PluginTab[]
*      /plugins/:id/api/*        (plugin routes, bearer auth)
GET    /plugins/:id/ui/*         (plugin static UI, no auth)
POST   /mcp/:runToken            (MCP streamable-HTTP, JSON responses; run-scoped token)
GET    /ws?token=                (WebSocket; ServerMessage / ClientMessage)
```

Every mutation emits a `HarnessEvent`; the WS forwards all events to every client, except
`browser.frame`/`browser.state`, which go only to clients subscribed to that session.

## Plugins

A plugin adds ticket tabs (a web UI in an iframe) and, optionally, server routes. Plugin UIs
are plain web pages served by the service, so any host (the Electron app today, iOS later) can
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
onTicketEvent?(event, ctx), dispose?() })`. Routes are mounted at `/plugins/<id>/api/*` behind the
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
| `worktree` | `ticket.branch` is set and `ticket.workdir` exists (a harness worktree) |

The app lists plugin tabs after Summaries, Transcript, Browser and Details. Their route is
`#/board/<project>/ticket/<KEY>/plugin:<pluginId>:<tabId>`; a plugin tab that no longer applies
falls back to Summaries.

**UI hosting.** The tab body is `<iframe src="<baseUrl>/plugins/<id>/ui/index.html?tab=<tabId>"
sandbox="allow-scripts allow-same-origin allow-forms allow-downloads">`. The iframe's origin is the
service origin, so the plugin's API calls are same-origin and only need the bearer token (the
renderer's CSP allows `frame-src` for local service origins). Static UI files are served without
auth (they carry no data), with path-traversal and symlink-escape protection.

**Bridge** (`PluginHostMessage` / `PluginFrameMessage` in `protocol.ts`):

| Direction | Message | When |
| --- | --- | --- |
| iframe → host | `{ type: "harness:ready" }` | the SDK's `connect()` starts; the host answers with init |
| host → iframe | `{ type: "harness:init", baseUrl, token, ticketKey, tabId, theme }` | iframe load and every ready |
| host → iframe | `{ type: "harness:theme", theme }` | `<html data-theme>` changes (MutationObserver) |
| host → iframe | `{ type: "harness:ticket", ticket }` | every `ticket.upserted` for that ticket |
| iframe → host | `{ type: "harness:openExternal", url }` | http(s)/mailto only |
| iframe → host | `{ type: "harness:navigate", ticketKey }` | open another ticket |

Origin rules: the host posts with `targetOrigin` = the service origin (the token never reaches a
frame that navigated elsewhere) and accepts messages only when `event.source` is its own iframe and
`event.origin` is the service origin. The SDK accepts messages only from `window.parent`, first
from an allowed host origin (`file://`/`null` for Electron, local http(s) origins, or ones passed as
`allowedOrigins`), and after init only from the origin that sent init. `theme` is always the
resolved `"light" | "dark"`; the SDK mirrors it onto the iframe's `<html data-theme>` and
`color-scheme`.

**Builds.** Plugin bundles are not committed (`dist` is gitignored). `bun run plugins:build` at the
root builds every builtin plugin, `app/scripts/build.ts` runs it, and the service runs a plugin's
`build` script at start when its bundle is missing or stale. UI requests wait for an in-flight build.

### Git plugin (`plugins/git`)

Tab **Changes** (`when: "workdir"`). Routes:

- `GET /plugins/git/api/changes?ticket=KEY[&maxBytes=N]` → `{ mode, base, baseSha, head, branch, files, patch,
  truncated, additions, deletions }`, `files: [{ path, oldPath?, status, additions, deletions, binary }]`
  with `status` ∈ `added | modified | deleted | renamed | untracked`.
  - **branch mode** (ticket has a branch): the diff runs from `merge-base(base, HEAD)` to the worktree
    **as it is on disk**, so committed, staged, unstaged and untracked (not ignored) changes all show.
    `base` is the branch checked out at the project path, falling back to `main`/`master`.
  - **workdir mode** (no branch): uncommitted + untracked changes against `HEAD` (or the empty tree in
    a repo without commits).
  - The user's index is never touched. The plugin copies it (keeping its mtime so git's racy-clean
    detection still works) to a temp `GIT_INDEX_FILE`, runs `git add -A` there, and diffs `--cached`
    with rename detection and config-independent flags.
  - `patch` is capped at 4 MiB by default (`maxBytes`, up to 64 MiB) and cut at a file boundary with
    `truncated: true`. The file list is always complete.
- `GET /plugins/git/api/log?ticket=KEY` → `{ mode, base, commits: [{ sha, shortSha, subject, author, email, date }] }`,
  the branch's commits since the merge-base (empty in workdir mode).
- `GET /plugins/git/api/file?ticket=KEY&side=old|new&path=P[&ref=<sha>]` → `{ contents }`, one side of a file, used to
  expand unchanged context. Paths are repo-relative; `..`, absolute paths and `.git` are rejected.

The UI uses Pierre's [@pierre/trees](https://trees.software) for the changed-file tree (git status
colors plus `+a −d` decorations) and [@pierre/diffs](https://diffs.com) `CodeView` for the stacked,
virtualized diffs with sticky headers and syntax highlighting. It offers unified/split view,
expandable context, a commits dropdown, empty/error/truncated states, and follows the host theme.
It refreshes on `harness:ticket` (debounced), polls every 4 s while the ticket is busy (file edits
don't emit ticket events), and has a refresh button. Below 720 px the tree becomes a drawer.

## Testing

`bun test` in each package. No test touches the network or a real model; the claude-code
driver is tested against a fake `claude` executable that replays stream-json. Browser tests
use the local Chrome and skip when it is missing. End-to-end tests boot the service on an
ephemeral port with a temp `HARNESS_HOME` and drive it through `HarnessClient`.
