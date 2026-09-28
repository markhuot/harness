// Config tools: what the Settings and Project Settings screens do (watchers, mappings,
// projects, settings), plus deleting projects and tickets. Reads are open to every ticket run
// and triage; every mutation is a gated tool (defineGatedTool): a human approves each call.

import { commandLine, PERMISSION_MODES, type Watcher } from "@harness/shared";
import type { WatcherFields } from "./types";
import { defineGatedTool, defineTool, json, schema } from "./util";

// ---------------------------------------------------------------------------
// Shared schema pieces and descriptions
// ---------------------------------------------------------------------------

// TODO(github-watcher): a built-in `harness watch github` command is being built on a sibling
// ticket. Once it merges, replace this with its exact command and args (and add it to the
// DESIGN.md "Config tools" section); until then agents get a gh-CLI one-liner that works today.
const GITHUB_WATCHER_HINT =
  'GitHub issues: until a built-in GitHub watcher exists, use the gh CLI in interval mode (gh must be installed and logged in): command "/bin/zsh", args ["-lc", "gh issue list --repo OWNER/NAME --state open --json number,title,url,updatedAt --jq \'.[] | {key: \\"PREFIX-\\\\(.number)\\", title, url, updated: .updatedAt} | tojson\'"], mode "interval", interval_sec 300, then create_mapping with pattern "PREFIX" for the target project. PREFIX is an upper-case key you choose, e.g. the repository name.';

const WATCHER_CONTRACT = [
  "A watcher is a command the harness service runs on this machine (outside any ticket sandbox) to discover work.",
  "It is spawned without a shell: command is an executable path and args its arguments. For pipes, quoting or your PATH, use command \"/bin/zsh\" with args [\"-lc\", \"<shell command>\"].",
  "Output: one JSON object per line on stdout (NDJSON); other lines are ignored. Fields: key (required; also read from id or identifier) is the external ticket key, e.g. \"FOO-123\"; title (or summary / name); url (or link / html_url); version (or updated / updatedAt / updated_at). Every other field is passed to the triage agent as-is.",
  "Each new (watcher, key, version) starts a triage session that files the item as a local ticket with that same key in a project; re-emitting a key with a new version sends the update to the existing ticket, the same version is ignored.",
  "Routing: triage suggests the project from the mappings. Create a mapping whose pattern is the key prefix the watcher emits (pattern \"FOO\" matches FOO-123) with create_mapping, or items may be declined.",
  "mode \"loop\" re-runs the command about a second after it exits: for commands that block until there is work (long-polling). mode \"interval\" runs it every interval_sec seconds (at least 10): for commands that print the current items and exit.",
  "Exit codes: 0 = ran (work may have been emitted), 4 = nothing to report, anything else = failure: the tail of stderr becomes the watcher's last_error and a loop watcher backs off (2s doubling to 5 minutes).",
  "env holds extra environment variables merged over the service's own; cwd is the working directory (~ allowed; default: the service's).",
].join(" ");

const watcherRefProp = { type: "string", minLength: 1, description: "The watcher's id (from list_watchers) or its exact name." };
const projectKeyProp = { type: "string", minLength: 1, description: "Project key prefix, as returned by list_projects (e.g. \"NYTIMES\")." };
const permissionModeProp = {
  type: "string",
  enum: [...PERMISSION_MODES, "inherit"],
  description: "\"auto\" (a classifier judges each action), \"ask\" (a human approves anything beyond edits in the workdir), \"read_only\", or \"inherit\" to use the settings default.",
};
const modelMapProp = {
  type: "object",
  description: "Driver id → model id (see list_drivers), e.g. {\"claude-code\": \"sonnet\"}. Merged per driver; a null value clears that driver's entry.",
};

const watcherProps = {
  name: { type: "string", minLength: 1, description: "Display name; also the source name triage shows, e.g. \"github\"." },
  command: { type: "string", minLength: 1, description: "Executable to run, e.g. \"/bin/zsh\" or an absolute path to a script." },
  args: { type: "array", items: { type: "string" }, description: "Arguments, one per array entry (no shell splitting)." },
  cwd: { type: "string", description: "Working directory; empty for the service's." },
  env: { type: "object", description: "Environment variables (string values)." },
  mode: { type: "string", enum: ["loop", "interval"], description: "\"loop\" for blocking commands, \"interval\" for commands that print and exit. Default \"loop\"." },
  interval_sec: { type: "integer", minimum: 10, description: "Seconds between runs in interval mode. Default 60." },
  enabled: { type: "boolean", description: "Whether the service runs it. Default true." },
  driver: { type: "string", description: "Driver id for this watcher's triage sessions (see list_drivers); empty for the settings default." },
};

type WatcherToolInput = {
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  mode?: "loop" | "interval";
  interval_sec?: number;
  enabled?: boolean;
  driver?: string;
};

function watcherFields(input: WatcherToolInput): WatcherFields {
  const out: WatcherFields = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.command !== undefined) out.command = input.command;
  if (input.args !== undefined) out.args = input.args;
  if (input.cwd !== undefined) out.cwd = input.cwd || null;
  if (input.env !== undefined) out.env = input.env;
  if (input.mode !== undefined) out.mode = input.mode;
  if (input.interval_sec !== undefined) out.intervalSec = input.interval_sec;
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (input.driver !== undefined) out.driver = input.driver || null;
  return out;
}

/** Env values can be credentials: a model sees which variables are set, not their values. */
function watcherView(w: Watcher) {
  return {
    id: w.id,
    name: w.name,
    command: w.command,
    args: w.args,
    command_line: commandLine(w.command, w.args),
    cwd: w.cwd,
    env: Object.fromEntries(Object.keys(w.env ?? {}).map((k) => [k, "(set)"])),
    mode: w.mode,
    interval_sec: w.intervalSec,
    enabled: w.enabled,
    driver: w.driver,
    last_run_at: w.lastRunAt ? new Date(w.lastRunAt).toISOString() : null,
    last_error: w.lastError,
  };
}

function schedule(mode: string | undefined, intervalSec: number | undefined): string {
  return mode === "interval" ? `every ${intervalSec ?? 60}s` : "loop";
}

/** "a=1, b=true" from the keys of a patch the agent sent (for card summaries). */
function fieldList(input: Record<string, unknown>, skip: string[]): string {
  const parts = Object.entries(input)
    .filter(([k, v]) => !skip.includes(k) && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? parts.join(", ") : "no changes";
}

const WATCHER_REASON = "A watcher's command runs on this Mac as you, outside any ticket sandbox, every time the watcher fires.";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listWatchers = defineTool<Record<string, never>>({
  name: "list_watchers",
  description:
    "List the configured watchers: commands the harness runs to discover incoming work, with their mode, schedule, last run and last error. Environment variable values are hidden.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const watchers = await ctx.ops.listWatchers(ctx);
    if (watchers.length === 0) return "No watchers are configured.";
    return json(watchers.map(watcherView));
  },
});

export const listMappings = defineTool<Record<string, never>>({
  name: "list_mappings",
  description:
    "List the mappings that route incoming work items to projects. pattern is a key prefix (\"FOO\" matches FOO-123; the longest prefix wins) or a /regex/ tried against the whole key after all prefixes.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const mappings = await ctx.ops.listMappings(ctx);
    if (mappings.length === 0) return "No mappings are configured.";
    return json(mappings.map((m) => ({ id: m.id, pattern: m.pattern, project_key: m.projectKey, notes: m.notes })));
  },
});

export const getSettings = defineTool<Record<string, never>>({
  name: "get_settings",
  description:
    "Get the harness settings: default driver, concurrent run limit, default permission mode, classifier, default and review models per driver, and the network listen mode. The Anthropic API key is never shown; anthropicApiKeySet says whether one is stored.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    return json(await ctx.ops.getSettings(ctx));
  },
});

export const listDrivers = defineTool<Record<string, never>>({
  name: "list_drivers",
  description: "List the agent drivers (e.g. claude-code, anthropic-api) with their availability and the models each can run.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const drivers = await ctx.ops.listDrivers(ctx);
    return json(
      drivers.map((d) => ({
        id: d.id,
        name: d.name,
        available: d.available,
        authenticated: d.authenticated,
        detail: d.detail,
        models: d.models.models.map((m) => ({ id: m.id, name: m.name, ...(m.default ? { default: true } : {}) })),
        ...(d.models.error ? { models_error: d.models.error } : {}),
      })),
    );
  },
});

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

type CreateWatcherInput = WatcherToolInput & { name: string; command: string };
type NewWatcher = WatcherFields & { name: string; command: string };

export const createWatcher = defineGatedTool<CreateWatcherInput>({
  name: "create_watcher",
  description: `Create a watcher. A human must approve the call: the ticket blocks until they answer, and you are resumed when they do; then repeat exactly the same call to create it. ${WATCHER_CONTRACT} ${GITHUB_WATCHER_HINT}`,
  inputSchema: schema(watcherProps, ["name", "command"]),
  describe: (i) => ({
    summary: `Create watcher "${i.name}" (${schedule(i.mode, i.interval_sec)}): ${commandLine(i.command, i.args)}`,
    reason: WATCHER_REASON,
  }),
  check: (i, ctx) => ctx.ops.createWatcher(ctx, watcherFields(i) as NewWatcher, true),
  async run(i, ctx) {
    const w = (await ctx.ops.createWatcher(ctx, watcherFields(i) as NewWatcher))!;
    return `Created watcher "${w.name}" (${w.id}); it ${w.enabled ? "is running" : "is disabled"}. Check its last_error with list_watchers after its first run.\n${json(watcherView(w))}`;
  },
});

type UpdateWatcherInput = WatcherToolInput & { watcher: string };

export const updateWatcher = defineGatedTool<UpdateWatcherInput>({
  name: "update_watcher",
  description:
    "Change a watcher's fields; fields you omit keep their value. env is merged into the existing variables (an empty-string value removes one). A human must approve the call: you are resumed when they answer; then repeat exactly the same call. The watcher contract is in create_watcher's description.",
  inputSchema: schema({ watcher: watcherRefProp, ...watcherProps, name: { ...watcherProps.name, description: "New display name." } }, ["watcher"]),
  describe: (i) => {
    const { watcher, ...rest } = i;
    const cmd = i.command !== undefined || i.args !== undefined ? ` — command: ${commandLine(i.command ?? "(unchanged)", i.args ?? [])}` : "";
    return { summary: `Update watcher "${watcher}": ${fieldList(rest, ["command", "args"])}${cmd}`, reason: WATCHER_REASON };
  },
  check: (i, ctx) => ctx.ops.updateWatcher(ctx, i.watcher, watcherFields(i), true),
  async run(i, ctx) {
    const w = (await ctx.ops.updateWatcher(ctx, i.watcher, watcherFields(i)))!;
    return `Updated watcher "${w.name}".\n${json(watcherView(w))}`;
  },
});

export const deleteWatcher = defineGatedTool<{ watcher: string }>({
  name: "delete_watcher",
  description: "Delete a watcher (its process is stopped). A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({ watcher: watcherRefProp }, ["watcher"]),
  describe: (i) => ({ summary: `Delete watcher "${i.watcher}"`, reason: "Stops and removes a source of incoming work." }),
  check: (i, ctx) => ctx.ops.deleteWatcher(ctx, i.watcher, true),
  async run(i, ctx) {
    const w = await ctx.ops.deleteWatcher(ctx, i.watcher);
    return `Deleted watcher "${w.name}".`;
  },
});

export const runWatcher = defineGatedTool<{ watcher: string }>({
  name: "run_watcher",
  description:
    "Run a watcher now instead of waiting for its schedule (a blocking loop watcher is restarted). A human must approve the call: you are resumed when they answer; then repeat exactly the same call. Check list_watchers afterwards for last_error.",
  inputSchema: schema({ watcher: watcherRefProp }, ["watcher"]),
  describe: (i) => ({ summary: `Run watcher "${i.watcher}" now`, reason: WATCHER_REASON }),
  check: (i, ctx) => ctx.ops.runWatcher(ctx, i.watcher, true),
  async run(i, ctx) {
    const w = await ctx.ops.runWatcher(ctx, i.watcher);
    return `Started watcher "${w.name}". Items it prints are triaged in the background.`;
  },
});

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

export const createMapping = defineGatedTool<{ pattern: string; project_key: string; notes?: string }>({
  name: "create_mapping",
  description:
    "Route incoming work items to a project. pattern is a key prefix (\"FOO\" matches FOO-123 but not FOOBAR-1; the longest matching prefix wins) or a /regex/flags tried against the whole key after all prefixes. Use the prefix of the keys your watcher emits. A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema(
    {
      pattern: { type: "string", minLength: 1, description: "Key prefix (\"FOO\") or /regex/ (\"/^OPS-\\\\d+$/i\")." },
      project_key: projectKeyProp,
      notes: { type: "string", description: "Optional guidance shown to the triage agent for items matching this pattern." },
    },
    ["pattern", "project_key"],
  ),
  describe: (i) => ({ summary: `Route ${i.pattern} items to project ${i.project_key}`, reason: "Changes which project incoming work is filed into." }),
  check: (i, ctx) => ctx.ops.createMapping(ctx, { pattern: i.pattern, projectKey: i.project_key, notes: i.notes }, true),
  async run(i, ctx) {
    const m = (await ctx.ops.createMapping(ctx, { pattern: i.pattern, projectKey: i.project_key, notes: i.notes }))!;
    return `Created mapping ${m.id}: ${m.pattern} → ${i.project_key.toUpperCase()}.`;
  },
});

export const deleteMapping = defineGatedTool<{ id: string }>({
  name: "delete_mapping",
  description: "Delete a mapping by id (see list_mappings). A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({ id: { type: "string", minLength: 1, description: "Mapping id from list_mappings." } }, ["id"]),
  describe: (i) => ({ summary: `Delete mapping ${i.id}`, reason: "Changes which project incoming work is filed into." }),
  check: (i, ctx) => ctx.ops.deleteMapping(ctx, i.id, true),
  async run(i, ctx) {
    const m = await ctx.ops.deleteMapping(ctx, i.id);
    return `Deleted mapping ${m.pattern}.`;
  },
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectProps = {
  name: { type: "string", minLength: 1, description: "Display name (default: the directory name)." },
  default_driver: { type: "string", description: "Driver for new tickets (see list_drivers); empty for the settings default." },
  use_worktrees: { type: "boolean", description: "Give each ticket its own git worktree and branch (git repos only). Default true." },
  require_human_review: { type: "boolean", description: "Tickets wait for a human review after the agent review. Default true." },
  auto_complete: { type: "boolean", description: "Complete (merge) tickets as soon as both reviews approve. Default false." },
  permission_mode: permissionModeProp,
  default_models: modelMapProp,
};

type ProjectToolInput = {
  name?: string;
  default_driver?: string;
  use_worktrees?: boolean;
  require_human_review?: boolean;
  auto_complete?: boolean;
  permission_mode?: string;
  default_models?: Record<string, string | null>;
};

function projectBody(i: ProjectToolInput & { path?: string; key?: string }) {
  const body: Record<string, unknown> = {};
  if (i.path !== undefined) body.path = i.path;
  if (i.name !== undefined) body.name = i.name;
  if (i.key !== undefined) body.key = i.key;
  if (i.default_driver !== undefined) body.defaultDriver = i.default_driver || null;
  if (i.use_worktrees !== undefined) body.useWorktrees = i.use_worktrees;
  if (i.require_human_review !== undefined) body.requireHumanReview = i.require_human_review;
  if (i.auto_complete !== undefined) body.autoComplete = i.auto_complete;
  if (i.permission_mode !== undefined) body.permissionMode = i.permission_mode === "inherit" ? null : i.permission_mode;
  if (i.default_models !== undefined) body.defaultModels = i.default_models;
  return body;
}

const PROJECT_REASON = "Project settings decide where agents work and how much they may do without asking.";

export const createProject = defineGatedTool<ProjectToolInput & { path: string; key?: string }>({
  name: "create_project",
  description:
    "Add a project: a local directory agents work in. key is the upper-case ticket key prefix (derived from the name when omitted). A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema(
    {
      path: { type: "string", minLength: 1, description: "Existing directory (absolute or ~/...)." },
      key: { type: "string", description: "Ticket key prefix, e.g. \"ACME\" (letters and digits, starting with a letter)." },
      ...projectProps,
    },
    ["path"],
  ),
  describe: (i) => ({ summary: `Add project ${i.key ? `${i.key} ` : ""}at ${i.path}${fieldSuffix(i, ["path", "key"])}`, reason: PROJECT_REASON }),
  check: (i, ctx) => ctx.ops.createProject(ctx, projectBody(i) as { path: string }, true),
  async run(i, ctx) {
    const p = (await ctx.ops.createProject(ctx, projectBody(i) as { path: string }))!;
    return `Created project ${p.key}.\n${json(p)}`;
  },
});

export const updateProject = defineGatedTool<ProjectToolInput & { project_key: string; key?: string; path?: string }>({
  name: "update_project",
  description:
    "Change a project's settings; fields you omit keep their value. key renames the project's key prefix (its native tickets are renamed OLD-n → NEW-n). A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema(
    {
      project_key: projectKeyProp,
      key: { type: "string", minLength: 1, description: "New key prefix." },
      path: { type: "string", minLength: 1, description: "New directory (must exist)." },
      ...projectProps,
    },
    ["project_key"],
  ),
  describe: (i) => ({ summary: `Change project ${i.project_key}: ${fieldList(i, ["project_key"])}`, reason: PROJECT_REASON }),
  check: (i, ctx) => ctx.ops.updateProject(ctx, i.project_key, projectBody(i), true),
  async run(i, ctx) {
    const p = (await ctx.ops.updateProject(ctx, i.project_key, projectBody(i)))!;
    return `Updated project ${p.key}.\n${json(p)}`;
  },
});

export const deleteProject = defineGatedTool<{ project_key: string }>({
  name: "delete_project",
  description:
    "Delete a project with all of its tickets, their transcripts and its mappings. The project directory on disk is left alone. You can't delete the project your own ticket is in. A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({ project_key: projectKeyProp }, ["project_key"]),
  describe: (i) => ({
    summary: `Delete project ${i.project_key} and all of its tickets`,
    reason: "Deletes the project's tickets, transcripts and mappings. This can't be undone.",
  }),
  check: (i, ctx) => ctx.ops.deleteProject(ctx, i.project_key, true),
  async run(i, ctx) {
    const p = await ctx.ops.deleteProject(ctx, i.project_key);
    return `Deleted project ${p.key} (${p.name}).`;
  },
});

function fieldSuffix(i: Record<string, unknown>, skip: string[]): string {
  const list = fieldList(i, skip);
  return list === "no changes" ? "" : ` (${list})`;
}

// ---------------------------------------------------------------------------
// Settings and tickets
// ---------------------------------------------------------------------------

type SettingsInput = {
  default_driver?: string;
  max_concurrent_runs?: number;
  permission_mode?: string;
  classifier?: string;
  default_models?: Record<string, string | null>;
  review_models?: Record<string, string | null>;
  listen?: { mode: string; host?: string };
};

function settingsPatch(i: SettingsInput): Record<string, unknown> {
  const map: Record<string, keyof SettingsInput> = {
    defaultDriver: "default_driver",
    maxConcurrentRuns: "max_concurrent_runs",
    permissionMode: "permission_mode",
    classifier: "classifier",
    defaultModels: "default_models",
    reviewModels: "review_models",
    listen: "listen",
  };
  const out: Record<string, unknown> = {};
  for (const [to, from] of Object.entries(map)) if (i[from] !== undefined) out[to] = i[from];
  return out;
}

export const updateSettings = defineGatedTool<SettingsInput>({
  name: "update_settings",
  description:
    "Change harness-wide settings; fields you omit keep their value. The Anthropic API key can't be set with a tool: ask the human to enter it in Settings. A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({
    default_driver: { type: "string", minLength: 1, description: "Driver for tickets whose project has none (see list_drivers)." },
    max_concurrent_runs: { type: "integer", minimum: 1, maximum: 64, description: "How many agent runs may run at once." },
    permission_mode: { type: "string", enum: [...PERMISSION_MODES], description: "Default permission mode for tickets whose project and ticket don't set one." },
    classifier: { type: "string", enum: ["claude-cli", "anthropic-api", "off"], description: "Who judges actions in auto mode for drivers without built-in permissions (\"off\" asks a human)." },
    default_models: modelMapProp,
    review_models: { ...modelMapProp, description: "Driver id → model id for review runs. Merged per driver; null clears one." },
    listen: {
      type: "object",
      description: `Which networks can reach the service: {"mode": "localhost"} (this Mac only), "tailscale", "any" (every interface), or {"mode": "custom", "host": "<ip or hostname>"}.`,
    },
  }),
  describe: (i) => ({
    summary: `Change settings: ${fieldList(settingsPatch(i), [])}`,
    reason: "Settings apply to every project, including the default permission mode and which networks can reach the service.",
  }),
  async check(i, ctx) {
    const patch = settingsPatch(i);
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change: pass at least one setting.");
    return ctx.ops.updateSettings(ctx, patch, true);
  },
  async run(i, ctx) {
    return `Settings updated.\n${json(await ctx.ops.updateSettings(ctx, settingsPatch(i)))}`;
  },
});

export const deleteTicket = defineGatedTool<{ key: string }>({
  name: "delete_ticket",
  description:
    "Delete a ticket with its transcript and summaries (a running agent on it is stopped; its children become top-level tickets). You can't delete your own ticket or one of its ancestors. A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({ key: { type: "string", minLength: 1, description: "Ticket key, e.g. \"NYTIMES-12\"." } }, ["key"]),
  describe: (i) => ({ summary: `Delete ticket ${i.key}`, reason: "Deletes the ticket, its transcript and its summaries. This can't be undone." }),
  check: (i, ctx) => ctx.ops.deleteTicket(ctx, i.key, true),
  async run(i, ctx) {
    const t = await ctx.ops.deleteTicket(ctx, i.key);
    return `Deleted ${t.key} (${t.title}).`;
  },
});

export const configReadTools = [listWatchers, listMappings, getSettings, listDrivers];
export const configWriteTools = [
  createWatcher,
  updateWatcher,
  deleteWatcher,
  runWatcher,
  createMapping,
  deleteMapping,
  createProject,
  updateProject,
  deleteProject,
  updateSettings,
  deleteTicket,
];

/** Names of the tools whose every call a human approves (defineGatedTool). */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set(configWriteTools.map((t) => t.name));
