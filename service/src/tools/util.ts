// Shared helpers for tool definitions: input validation, result builders, formatting.

import type { Ticket } from "@harness/shared";
import type { ApprovalMeta, JsonSchema, ToolContext, ToolDefinition, ToolResult } from "./types";

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return textResult(text, true);
}

export class ToolInputError extends Error {}

type PropSchema = {
  type?: string;
  enum?: unknown[];
  items?: PropSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
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

function checkProp(toolName: string, key: string, value: unknown, schema: PropSchema): void {
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
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => checkProp(toolName, `${key}[${i}]`, item, schema.items!));
  }
}

/**
 * Minimal JSON-schema validation for the subset our tool schemas use
 * (flat objects of string/boolean/number/integer/array-of-primitive properties).
 * Unknown extra properties are ignored so small model slips don't fail a call.
 */
export function validateInput(toolName: string, schema: JsonSchema, input: unknown): Record<string, unknown> {
  const value = input === undefined || input === null ? {} : input;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Invalid input for ${toolName}: expected an object.`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) throw new ToolInputError(`Invalid input for ${toolName}: "${key}" is required.`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    checkProp(toolName, key, v, propSchema as PropSchema);
  }
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

/** Compact, model-friendly view of a ticket. */
export function ticketView(t: Ticket) {
  return {
    key: t.key,
    title: t.title,
    kind: t.kind,
    status: t.status,
    agentReview: t.agentReview,
    humanReview: t.humanReview,
    dependsOn: t.dependsOn,
    autoStart: t.autoStart,
    busy: t.busy,
    blockedReason: t.blockedReason,
    branch: t.branch,
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
