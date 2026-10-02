// Config tools: what the Settings and Project Settings screens do (watchers, projects,
// settings), plus deleting projects and tickets. Reads are open to every ticket run
// and triage; every mutation is a gated tool (defineGatedTool): a human approves each call.

import { commandLine, COMPLETION_ACTIONS, PERMISSION_MODES, PROJECT_COLORS, type PublicSettings, type Watcher } from "@harness/shared";
import type { WatcherFields } from "./types";
import { defineGatedTool, defineTool, json, schema } from "./util";

// ---------------------------------------------------------------------------
// Shared schema pieces and descriptions
// ---------------------------------------------------------------------------

// What a watcher is, for an agent setting one up from the user's description. The output format
// is up to the command: whatever it prints goes to the Inbox with the watcher's prompt, and the
// triage agent decides what to do with it (DESIGN.md "Watchers and triage").
const WATCHER_GUIDE = [
  `A watcher runs a command and sends whatever text it prints to the Inbox, together with the watcher's prompt. A triage agent reads each piece of output with that prompt and decides what to do: dispatch it to an agent in a project, send it to an existing ticket, or decline it. The output can be in any format (JSON, a table, plain lines). The harness service runs the command on this machine as the user, outside any ticket sandbox.`,
  `command: the user's shell command line, exactly as they'd type it in a terminal. It runs through their login shell, so their PATH, pipes, quoting and loops work. Leave args out: args are only for older watchers whose command is an executable run directly, without a shell.`,
  `prompt: the user's instructions to the triage agent for this output, in their words, e.g. "If this event is assigned to me and has actionable next steps, dispatch it to an agent in PLAYR; otherwise decline it." The prompt is where routing lives: it names the project (by key) that matching output goes to, and triage declines output whose project it can't tell. When the user names a project, put its key in the prompt; when several projects are involved, say in the prompt which output goes where.`,
  `mode: "loop" for a command that runs for a long time or loops by itself; it's restarted when it exits, and each burst of output becomes one Inbox item. "interval" for a command that prints once and exits; it runs every interval_sec seconds (at least 10), and each run's output becomes one Inbox item. Output identical to an earlier item from the same watcher is skipped, so a loop that re-prints unchanged data doesn't fill the Inbox.`,
  `A non-zero exit is shown as the watcher's error (last_error, from the end of stderr). env: extra environment variables merged over the service's (e.g. an API token the user gives you). cwd: its working directory (~ allowed), if it needs one. driver: the driver for this watcher's triage sessions (list_drivers); omit for the settings default. models: {driver id: model id} for its triage sessions, e.g. {"claude-code": "opus"} for a watcher whose output needs more reasoning; omit to use the settings' watcher models.`,
  `Examples. A looping watcher that polls a REST API for new events: {"name": "events", "command": "while true; do curl -s -H \"Authorization: Bearer $EVENTS_TOKEN\" 'https://api.example.com/events?since=1m'; sleep 60; done", "env": {"EVENTS_TOKEN": "<token>"}, "mode": "loop", "prompt": "If this event is assigned to me and has actionable next steps, dispatch it to an agent in PLAYR."}. An interval watcher around a tool the user has installed: {"name": "jira", "command": "watch-jira --project=PLAYR --assigned=@me --once", "mode": "interval", "interval_sec": 600, "prompt": "Dispatch new tickets to an agent in PLAYR."}.`,
  `After it's created, check list_watchers for last_run_at and last_error once it has had a chance to run; process.state says whether its process is running now, waiting for its next run (next_run_at), or stopped.`,
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
  name: { type: "string", minLength: 1, description: "Display name; also the source name triage shows, e.g. \"jira-sprint\"." },
  command: { type: "string", minLength: 1, description: "A shell command line whose stdout text goes to the Inbox, e.g. \"watch-jira --project=PLAYR --once\"." },
  args: { type: "array", items: { type: "string" }, description: "Legacy only: with args, command is an executable run directly with them and no shell. Leave it out; update_watcher with args [] turns a legacy watcher into a shell command line." },
  prompt: { type: "string", description: "The user's instructions to the triage agent for this watcher's output, including the project (by key) to dispatch matching work to." },
  cwd: { type: "string", description: "Working directory; empty for the service's." },
  env: { type: "object", description: "Environment variables (string values)." },
  mode: { type: "string", enum: ["loop", "interval"], description: "\"loop\" for long-running or self-looping commands (restarted when they exit), \"interval\" for commands that print once and exit. Default \"loop\"." },
  interval_sec: { type: "integer", minimum: 10, description: "Seconds between runs in interval mode. Default 60." },
  enabled: { type: "boolean", description: "Whether the service runs it. Default true." },
  driver: { type: "string", description: "Driver id for this watcher's triage sessions (see list_drivers); empty for the settings default (watcherDriver, then defaultDriver)." },
  models: { ...modelMapProp, description: "Driver id → model id for this watcher's triage sessions (see list_drivers), e.g. {\"claude-code\": \"opus\"}. Merged per driver; a null value clears one. Drivers without an entry use the settings' watcherModels, then defaultModels." },
};

type WatcherToolInput = {
  name?: string;
  command?: string;
  prompt?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  mode?: "loop" | "interval";
  interval_sec?: number;
  enabled?: boolean;
  driver?: string;
  models?: Record<string, string | null>;
};

function watcherFields(input: WatcherToolInput): WatcherFields {
  const out: WatcherFields = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.command !== undefined) out.command = input.command;
  // Passed straight through; the orchestrator validates and stores it.
  if (input.prompt !== undefined) out.prompt = input.prompt;
  if (input.args !== undefined) out.args = input.args;
  if (input.cwd !== undefined) out.cwd = input.cwd || null;
  if (input.env !== undefined) out.env = input.env;
  if (input.mode !== undefined) out.mode = input.mode;
  if (input.interval_sec !== undefined) out.intervalSec = input.interval_sec;
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (input.driver !== undefined) out.driver = input.driver || null;
  if (input.models !== undefined) out.models = input.models;
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
    ...(w.prompt ? { prompt: w.prompt } : {}),
    cwd: w.cwd,
    env: Object.fromEntries(Object.keys(w.env ?? {}).map((k) => [k, "(set)"])),
    mode: w.mode,
    interval_sec: w.intervalSec,
    enabled: w.enabled,
    driver: w.driver,
    models: w.models ?? {},
    last_run_at: w.lastRunAt ? new Date(w.lastRunAt).toISOString() : null,
    last_error: w.lastError,
    ...(w.live
      ? {
          process: {
            state: w.live.state,
            since: new Date(w.live.since).toISOString(),
            next_run_at: w.live.nextRunAt ? new Date(w.live.nextRunAt).toISOString() : null,
            consecutive_failures: w.live.failures,
          },
        }
      : {}),
  };
}

/** A driver or model the watcher's triage runs on, when the call picks one. */
function triageSuffix(i: Pick<WatcherToolInput, "driver" | "models">): string {
  const parts = [i.driver ? `driver: ${i.driver}` : null, i.models && Object.keys(i.models).length ? `models: ${JSON.stringify(i.models)}` : null];
  return parts.filter(Boolean).map((p) => `; ${p}`).join("");
}

/** The triage prompt is part of what the human approves: it decides what happens to the output. */
function promptSuffix(prompt: string | undefined): string {
  return prompt?.trim() ? `; prompt: "${prompt.trim()}"` : "";
}

/**
 * env keys and a non-default cwd for a watcher's card headline: both change what the command
 * does (ZDOTDIR alone changes what the login shell runs). Key names only, never values, which
 * can be credentials. `update` separates keys set from keys removed (an empty-string value) and
 * says when cwd is cleared back to the service's.
 */
function watcherEnvSuffix(i: Pick<WatcherToolInput, "env" | "cwd">, update: boolean): string {
  const parts: string[] = [];
  const env = i.env && typeof i.env === "object" ? i.env : {};
  const keys = Object.keys(env).sort();
  if (update) {
    const set = keys.filter((k) => env[k] !== "");
    const removed = keys.filter((k) => env[k] === "");
    const envParts = [set.length ? `set ${set.join(", ")}` : null, removed.length ? `removes ${removed.join(", ")}` : null].filter(Boolean);
    if (envParts.length) parts.push(`env: ${envParts.join("; ")}`);
  } else if (keys.length) {
    parts.push(`env: ${keys.join(", ")}`);
  }
  if (i.cwd) parts.push(`cwd: ${i.cwd}`);
  else if (update && i.cwd === "") parts.push("cwd: service default");
  return parts.map((p) => `; ${p}`).join("");
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

/** Settings as the config tools show them: prompt overrides as the ids the user customized, since their text is long. */
function settingsView(settings: PublicSettings): unknown {
  const { prompts, ...rest } = settings;
  const customizedPrompts = Object.entries(prompts ?? {})
    .filter(([, text]) => text)
    .map(([id]) => id);
  return { ...rest, customizedPrompts };
}

export const getSettings = defineTool<{ include_prompts?: boolean }>({
  name: "get_settings",
  description:
    "Get the harness settings: default driver, concurrent run limit, default permission mode, classifier, default and review models per driver, the driver and models for watchers that don't pick their own, the network listen mode, the default base branch (baseBranch), and which built-in prompts the user has customized (customizedPrompts, by prompt id). The Anthropic API key is never shown; anthropicApiKeySet says whether one is stored.",
  inputSchema: schema({
    include_prompts: {
      type: "boolean",
      description: "Also list every overridable prompt (prompts): its id, where it's used, its variables, the built-in template and the user's override. Long; ask for it only to read or change a prompt.",
    },
  }),
  async run(input, ctx) {
    const view = settingsView(await ctx.ops.getSettings(ctx)) as Record<string, unknown>;
    if (input.include_prompts === true) view.prompts = await ctx.ops.listPrompts(ctx);
    return json(view);
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
  description: `Create a watcher. A human must approve the call: the ticket blocks until they answer, and you are resumed when they do; then repeat exactly the same call to create it. ${WATCHER_GUIDE}`,
  inputSchema: schema(watcherProps, ["name", "command"]),
  describe: (i) => ({
    summary: `Create watcher "${i.name}" (${schedule(i.mode, i.interval_sec)}): ${commandLine(i.command, i.args)}${promptSuffix(i.prompt)}${watcherEnvSuffix(i, false)}${triageSuffix(i)}`,
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
    "Change a watcher's fields; fields you omit keep their value. env is merged into the existing variables (an empty-string value removes one). A human must approve the call: you are resumed when they answer; then repeat exactly the same call. What each field means is in create_watcher's description.",
  inputSchema: schema({ watcher: watcherRefProp, ...watcherProps, name: { ...watcherProps.name, description: "New display name." } }, ["watcher"]),
  describe: (i) => {
    const { watcher, ...rest } = i;
    // env and cwd get their own segments (key names only), never fieldList's values.
    const fields = fieldList(rest, ["command", "args", "prompt", "env", "cwd"]);
    const parts = [
      fields === "no changes" ? null : fields,
      i.command !== undefined || i.args !== undefined ? `command: ${commandLine(i.command ?? "(unchanged)", i.args ?? [])}` : null,
      i.prompt !== undefined ? `prompt: "${i.prompt.trim()}"` : null,
      watcherEnvSuffix(i, true).slice(2) || null,
    ].filter(Boolean);
    return { summary: `Update watcher "${watcher}": ${parts.join("; ") || "no changes"}`, reason: WATCHER_REASON };
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
    return `Started watcher "${w.name}". Its output goes to the Inbox and is triaged in the background.`;
  },
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectProps = {
  name: { type: "string", minLength: 1, description: "Display name (default: the directory name)." },
  default_driver: { type: "string", description: "Driver for new tickets (see list_drivers); empty for the settings default." },
  use_worktrees: { type: "boolean", description: "Give each ticket its own git worktree and branch (git repos only). Default true." },
  skip_agent_review: {
    type: "boolean",
    description: "New tickets skip their agent review unless they're created otherwise (a default; existing tickets keep their own). Default false.",
  },
  skip_human_review: {
    type: "boolean",
    description: "New tickets skip their human review, landing once the agent review approves them, unless they're created otherwise (a default; existing tickets keep their own). Default false.",
  },
  completion_action: {
    type: "string",
    enum: [...COMPLETION_ACTIONS],
    description:
      "What approving a ticket does by default: \"merge\" its branch into the base branch, \"pr\" (push and open a GitHub pull request; needs a remote gh is logged into), \"cleanup\" (only remove the worktree and branch, for work that lands by itself, e.g. pushed to an existing pull request), or \"custom\" (the approver's instructions). Default merge.",
  },
  permission_mode: permissionModeProp,
  default_models: modelMapProp,
  color: {
    type: "string",
    description: `Key badge color: ${PROJECT_COLORS.map((c) => c.id).join(", ")}, or a custom "#rrggbb". Empty for the theme's accent.`,
  },
  base_branch: {
    type: "string",
    description: "Branch this project's tickets land on when they complete, and new ticket branches start from, e.g. \"develop\". Empty for the settings default.",
  },
};

type ProjectToolInput = {
  name?: string;
  default_driver?: string;
  use_worktrees?: boolean;
  skip_agent_review?: boolean;
  skip_human_review?: boolean;
  completion_action?: string;
  permission_mode?: string;
  default_models?: Record<string, string | null>;
  color?: string;
  base_branch?: string;
};

function projectBody(i: ProjectToolInput & { path?: string; key?: string }) {
  const body: Record<string, unknown> = {};
  if (i.path !== undefined) body.path = i.path;
  if (i.name !== undefined) body.name = i.name;
  if (i.key !== undefined) body.key = i.key;
  if (i.default_driver !== undefined) body.defaultDriver = i.default_driver || null;
  if (i.use_worktrees !== undefined) body.useWorktrees = i.use_worktrees;
  if (i.skip_agent_review !== undefined) body.skipAgentReview = i.skip_agent_review;
  if (i.skip_human_review !== undefined) body.skipHumanReview = i.skip_human_review;
  if (i.completion_action !== undefined) body.completionAction = i.completion_action;
  if (i.permission_mode !== undefined) body.permissionMode = i.permission_mode === "inherit" ? null : i.permission_mode;
  if (i.default_models !== undefined) body.defaultModels = i.default_models;
  if (i.color !== undefined) body.color = i.color || null;
  if (i.base_branch !== undefined) body.baseBranch = i.base_branch.trim() || null;
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
    "Delete a project with all of its tickets and their transcripts. The project directory on disk is left alone. You can't delete the project your own ticket is in. A human must approve the call: you are resumed when they answer; then repeat exactly the same call.",
  inputSchema: schema({ project_key: projectKeyProp }, ["project_key"]),
  describe: (i) => ({
    summary: `Delete project ${i.project_key} and all of its tickets`,
    reason: "Deletes the project's tickets and transcripts. This can't be undone.",
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
  watcher_driver?: string | null;
  watcher_models?: Record<string, string | null>;
  listen?: { mode: string; host?: string };
  base_branch?: string;
  prompts?: Record<string, string | null>;
};

function settingsPatch(i: SettingsInput): Record<string, unknown> {
  const map: Record<string, keyof SettingsInput> = {
    defaultDriver: "default_driver",
    maxConcurrentRuns: "max_concurrent_runs",
    permissionMode: "permission_mode",
    classifier: "classifier",
    defaultModels: "default_models",
    reviewModels: "review_models",
    watcherDriver: "watcher_driver",
    watcherModels: "watcher_models",
    listen: "listen",
    baseBranch: "base_branch",
    prompts: "prompts",
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
    watcher_driver: { type: "string", description: "Driver for triage sessions of watchers that don't pick one (see list_drivers); an empty string follows default_driver." },
    watcher_models: { ...modelMapProp, description: "Driver id → model id for triage sessions of watchers that don't pick one. Merged per driver; null clears one (falls back to default_models)." },
    listen: {
      type: "object",
      description: `Which networks can reach the service: {"mode": "localhost"} (this Mac only), "tailscale", "any" (every interface), or {"mode": "custom", "host": "<ip or hostname>"}.`,
    },
    base_branch: {
      type: "string",
      minLength: 1,
      description: "Default base branch for projects and tickets that don't set one: what completed tickets merge into and new ticket branches start from. Default \"main\".",
    },
    prompts: {
      type: "object",
      description:
        "Prompt id → template text, replacing that built-in prompt for every run; null or \"\" goes back to the built-in (which keeps improving with updates). Merged per id. Templates use {{variable}} and {{#if variable}} … {{else if other}} … {{else}} … {{/if}}; unknown ids and variables are refused. get_settings with include_prompts lists the prompt ids with their variables, built-in text and current override.",
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
    return `Settings updated.\n${json(settingsView(await ctx.ops.updateSettings(ctx, settingsPatch(i))))}`;
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

export const configReadTools = [listWatchers, getSettings, listDrivers];
export const configWriteTools = [
  createWatcher,
  updateWatcher,
  deleteWatcher,
  runWatcher,
  createProject,
  updateProject,
  deleteProject,
  updateSettings,
  deleteTicket,
];

/** Names of the tools whose every call a human approves (defineGatedTool). */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set(configWriteTools.map((t) => t.name));
