// Shared helpers for tool definitions: input validation, result builders, formatting.

import type { Ticket } from "@harness/shared";
import type { ApprovalMeta, BoardRemoteMatches, JsonSchema, ToolContext, ToolDefinition, ToolResult } from "./types";

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return textResult(text, true);
}

export class ToolInputError extends Error {}

export type PropSchema = {
  type?: string;
  enum?: unknown[];
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

function typeOk(value: unknown, schema: PropSchema): boolean {
  switch (schema.type) {
    case undefined:
      return true;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function checkProp(toolName: string, key: string, value: unknown, schema: PropSchema, deep: boolean): void {
  if (!typeOk(value, schema)) {
    throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must be ${schema.type === "integer" ? "an integer" : `a ${schema.type}`}.`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}.`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must be >= ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must be <= ${schema.maximum}.`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.trim().length < schema.minLength) {
    throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must not be empty.`);
  }
  if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must be at most ${schema.maxLength} characters.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must have at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ToolInputError(`Invalid input for ${toolName}: "${key}" must have at most ${schema.maxItems} items.`);
    if (schema.items) value.forEach((item, i) => checkProp(toolName, `${key}[${i}]`, item, schema.items!, deep));
  }
  if (deep && schema.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
    checkObject(toolName, value as Record<string, unknown>, schema, `${key}.`, deep);
  }
}

function checkObject(toolName: string, obj: Record<string, unknown>, schema: PropSchema, prefix: string, deep: boolean): void {
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) throw new ToolInputError(`Invalid input for ${toolName}: "${prefix}${key}" is required.`);
  }
  const properties = schema.properties ?? {};
  if (deep && schema.additionalProperties === false) {
    const extra = Object.keys(obj).find((k) => !(k in properties) && obj[k] !== undefined);
    if (extra) throw new ToolInputError(`Invalid input for ${toolName}: "${prefix}${extra}" is not a known property (expected ${Object.keys(properties).join(", ") || "none"}).`);
  }
  for (const [key, propSchema] of Object.entries(properties)) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    checkProp(toolName, `${prefix}${key}`, v, propSchema, deep);
  }
}

/**
 * A deferred stub advertises `{ type: "object" }` with no property types, so a client that types
 * arguments from the advertised schema (HARNESS-329: Claude Code) has no basis to send `true` as
 * a boolean, `3` as a number, `["a","b"]` as an array, or `{"idle":true}` as a nested object: it
 * sends the string `"true"`, `"3"`, `'["a","b"]'`, or `'{"idle":true}'`, and strict validation
 * against the real schema then rejects it. This coerces those string encodings back to the
 * declared type before validation, for every property (object properties too; `required` is
 * unaffected since it's about presence, not shape). A string that doesn't parse as the declared
 * type is left alone, so validation still reports it clearly.
 */
export function coerceToSchema(input: unknown, schema: PropSchema): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const properties = schema.properties ?? {};
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in out && out[key] !== undefined && out[key] !== null) out[key] = coerceValue(out[key], propSchema);
  }
  return out;
}

function coerceValue(value: unknown, schema: PropSchema): unknown {
  if (schema.type === "object" && schema.properties) {
    if (typeof value === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return value;
      return coerceToSchema(parsed, schema);
    }
    return coerceToSchema(value, schema);
  }
  if (typeof value !== "string") {
    if (Array.isArray(value) && schema.type === "array" && schema.items) return value.map((v) => coerceValue(v, schema.items!));
    return value;
  }
  switch (schema.type) {
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "integer": {
      const n = Number(value);
      return value.trim() !== "" && Number.isInteger(n) ? n : value;
    }
    case "number": {
      const n = Number(value);
      return value.trim() !== "" && Number.isFinite(n) ? n : value;
    }
    case "array": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
      if (!Array.isArray(parsed)) return value;
      return schema.items ? parsed.map((v) => coerceValue(v, schema.items!)) : parsed;
    }
    default:
      return value;
  }
}

/**
 * JSON-schema validation for the subset our tool schemas use: type, required, properties, enum,
 * items, minimum/maximum, minLength/maxLength, minItems/maxItems. Unknown extra properties are
 * ignored so small model slips don't fail a call. `deep` (a stubbed tool's call) also checks nested objects'
 * properties and required keys and enforces additionalProperties: false; without it, nested
 * objects are left to the tool, which can explain its own conditions (browser wait_for).
 */
export function validateInput(toolName: string, schema: JsonSchema, input: unknown, deep = false): Record<string, unknown> {
  const value = input === undefined || input === null ? {} : input;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Invalid input for ${toolName}: expected an object.`);
  }
  const obj = value as Record<string, unknown>;
  checkObject(toolName, obj, schema as PropSchema, "", deep);
  return obj;
}

/**
 * Define a tool whose input is validated against its schema before `run` is called.
 * Validation failures become isError results (so the model can correct itself);
 * errors thrown by `run` propagate and are converted by executeTool / the MCP layer.
 */
export function defineTool<I>(def: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  group?: "harness" | "native";
  run(input: I, ctx: ToolContext): Promise<ToolResult | string>;
}): ToolDefinition<I> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    group: def.group ?? "harness",
    async execute(input: I, ctx: ToolContext): Promise<ToolResult> {
      let valid: I;
      try {
        valid = validateInput(def.name, def.inputSchema, input) as I;
      } catch (err) {
        if (err instanceof ToolInputError) return errorResult(err.message);
        throw err;
      }
      const out = await def.run(valid, ctx);
      return typeof out === "string" ? textResult(out) : out;
    },
  };
}

/**
 * A tool that changes something outside the ticket's sandbox (watcher commands the service
 * runs, settings that loosen permissions or network exposure, deletes). Every call goes to a
 * human, whatever the ticket's permission mode: `check` validates first (a bad call fails
 * without bothering anyone), then HarnessOps.requestApproval puts an approval card on the
 * ticket and blocks it; the agent is resumed when the human answers, and the identical retry
 * consumes the one-time grant and runs `run`. Read-only tickets are denied outright. Only
 * "allow once" can approve these calls (onceOnly), so a human never unlocks a whole class of
 * them by accident.
 */
export function defineGatedTool<I>(def: {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Card text: what the call does in one line, and why a human is asked */
  describe(input: I): { summary: string; reason: string };
  /** Validate without side effects; throw Error(message) to reject the call */
  check?(input: I, ctx: ToolContext): Promise<unknown>;
  run(input: I, ctx: ToolContext): Promise<ToolResult | string>;
}): ToolDefinition<I> {
  // Advertised like every harness tool (readOnlyHint): the gate is here, not in the client's
  // permission system, so it holds whatever mode the CLI runs in.
  return defineTool<I>({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    async run(input, ctx) {
      if (def.check) await def.check(input, ctx);
      const { summary, reason } = def.describe(input);
      const meta: ApprovalMeta = { summary, reason, source: "policy", onceOnly: true };
      const decision = await ctx.ops.requestApproval(ctx, def.name, input, meta);
      if (decision.behavior === "deny") return errorResult(decision.message);
      return def.run(input, ctx);
    },
  });
}

export function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return required.length ? { type: "object", properties, required } : { type: "object", properties };
}

/** Per-phase driver + model choices (DESIGN.md "Model selection"), merged per phase. */
export function phaseModelsProp(description: string) {
  const choice = {
    type: "object",
    properties: {
      driver: { type: "string", minLength: 1, description: "Driver id (see list_drivers)." },
      model: { type: "string", description: "Model id for that driver; null or \"\" for the driver's default model." },
    },
    required: ["driver"],
  };
  return {
    type: "object",
    properties: { plan: choice, work: choice, review: choice, complete: choice },
    description: `${description} Phases: plan (the planning run), work (work, chat and conductor runs), review (the agent reviewer), complete (the run that lands the work). Each is {"driver", "model"}; null clears it so it inherits. Phases you omit keep their choice.`,
  };
}

/**
 * HarnessOps.getTicket for a key that no local ticket has but tickets carry as their remote ID.
 * get_ticket turns it into a { ticket: null, requested, relatedTickets } result, not an error.
 */
export class RemoteIdError extends Error {
  constructor(
    message: string,
    public matches: BoardRemoteMatches,
  ) {
    super(message);
  }
}

/** Compact, model-friendly view of a ticket. */
export function ticketView(t: Ticket) {
  return {
    key: t.key,
    // The remote ID it's linked to (shown in place of key on the board); key is what tools take.
    externalKey: t.externalRef?.key ?? null,
    externalUrl: t.externalRef?.url ?? null,
    title: t.title,
    kind: t.kind,
    status: t.status,
    agentReview: t.agentReview,
    humanReview: t.humanReview,
    skipAgentReview: !!t.skipAgentReview,
    skipHumanReview: !!t.skipHumanReview,
    dependsOn: t.dependsOn,
    autoStart: t.autoStart,
    busy: t.busy,
    blockedReason: t.blockedReason,
    branch: t.branch,
    requestedBranch: t.requestedBranch ?? null,
    baseBranch: t.baseBranch ?? null,
    completionAction: t.completionAction ?? null,
    pullRequestUrl: t.pullRequestUrl ?? null,
  };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Keep the head and tail of long output, noting how much was dropped. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${dropped} characters truncated ...]\n\n${text.slice(text.length - tail)}`;
}
