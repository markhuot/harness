import { expect, test } from "bun:test";
import { coerceToSchema, defineGatedTool, defineTool, errorResult, schema, textResult, ticketView, truncateMiddle, validateInput, ToolInputError, type PropSchema } from "../../../service/src/tools/util";
import type { ToolContext } from "../../../service/src/tools/types";
import { makeTicket } from "../../builders/ticket";

const bad = (fn: () => unknown, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolInputError);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a ToolInputError");
};

const s = (props: Record<string, unknown>, required: string[] = []) => schema(props, required) as never;

test("required properties must be present and not null; other properties may be left out", () => {
  const sch = s({ a: { type: "string" }, b: { type: "integer" } }, ["a"]);
  expect(validateInput("t", sch, { a: "x" })).toEqual({ a: "x" });
  bad(() => validateInput("t", sch, {}), /"a" is required/);
  bad(() => validateInput("t", sch, { a: null }), /"a" is required/);
  expect(validateInput("t", s({}), undefined)).toEqual({});
  bad(() => validateInput("t", s({}), []), /expected an object/);
  bad(() => validateInput("t", s({}), "x"), /expected an object/);
});

test("each declared type is checked, an integer rejects true/false with a hint, and a number must be finite", () => {
  const sch = s({ str: { type: "string" }, bool: { type: "boolean" }, int: { type: "integer", description: "how many" }, num: { type: "number" }, arr: { type: "array" }, obj: { type: "object" } });
  expect(() => validateInput("t", sch, { str: "", bool: false, int: 3, num: 1.5, arr: [], obj: {} })).not.toThrow();
  bad(() => validateInput("t", sch, { str: 1 }), /"str" must be a string/);
  bad(() => validateInput("t", sch, { bool: "true" }), /"bool" must be a boolean/);
  bad(() => validateInput("t", sch, { int: 1.5 }), /"int" must be an integer/);
  bad(() => validateInput("t", sch, { int: true }), /a number, not true\/false\): how many/);
  bad(() => validateInput("t", sch, { num: NaN }), /"num" must be a number/);
  bad(() => validateInput("t", sch, { arr: {} }), /"arr" must be a array/);
  bad(() => validateInput("t", sch, { obj: [] }), /"obj" must be a object/);
});

test("enum, range and length limits are enforced; minLength counts the trimmed text", () => {
  bad(() => validateInput("t", s({ k: { type: "string", enum: ["a", "b"] } }), { k: "c" }), /one of "a", "b"/);
  bad(() => validateInput("t", s({ n: { type: "integer", minimum: 1 } }), { n: 0 }), />= 1/);
  bad(() => validateInput("t", s({ n: { type: "integer", maximum: 5 } }), { n: 6 }), /<= 5/);
  bad(() => validateInput("t", s({ t: { type: "string", minLength: 1 } }), { t: "   " }), /must not be empty/);
  bad(() => validateInput("t", s({ t: { type: "string", maxLength: 3 } }), { t: "abcd" }), /at most 3 characters/);
  bad(() => validateInput("t", s({ l: { type: "array", minItems: 1 } }), { l: [] }), /at least 1 item\b/);
  bad(() => validateInput("t", s({ l: { type: "array", minItems: 2 } }), { l: [1] }), /at least 2 items/);
  bad(() => validateInput("t", s({ l: { type: "array", maxItems: 1 } }), { l: [1, 2] }), /at most 1 items/);
  bad(() => validateInput("t", s({ l: { type: "array", items: { type: "string" } } }), { l: ["a", 2] }), /"l\[1\]" must be a string/);
});

test("nested objects are checked only when asked to, which also forbids unknown nested keys", () => {
  const sch = s({ o: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["y"], additionalProperties: false } });
  expect(() => validateInput("t", sch, { o: { x: "no" } })).not.toThrow();
  bad(() => validateInput("t", sch, { o: { x: "no", y: 1 } }, true), /"o.x" must be an integer/);
  bad(() => validateInput("t", sch, { o: { y: 1, z: 1 } }, true), /"o.z" is not a known property \(expected x, y\)/);
  bad(() => validateInput("t", sch, { o: {} }, true), /"o.y" is required/);
});

test("strings a client sent for typed values are turned back into those types, and left alone when they don't parse", () => {
  const sch: PropSchema = {
    type: "object",
    properties: { b: { type: "boolean" }, i: { type: "integer" }, n: { type: "number" }, a: { type: "array", items: { type: "integer" } }, o: { type: "object", properties: { idle: { type: "boolean" } } }, s: { type: "string" } },
  };
  expect(coerceToSchema({ b: "true", i: "3", n: "1.5", a: '["1",2]', o: '{"idle":"false"}', s: "7" }, sch)).toEqual({ b: true, i: 3, n: 1.5, a: [1, 2], o: { idle: false }, s: "7" });
  expect(coerceToSchema({ b: "maybe", i: "3.5", n: "", a: "[oops", o: "[1]" }, sch)).toEqual({ b: "maybe", i: "3.5", n: "", a: "[oops", o: "[1]" });
  expect(coerceToSchema({ a: ["1", "2"] }, sch)).toEqual({ a: [1, 2] });
  expect(coerceToSchema("not an object", sch)).toBe("not an object");
  expect(coerceToSchema([1], sch)).toEqual([1]);
});

const ctx = (decision: { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }) => {
  const asked: { tool: string; meta: unknown }[] = [];
  return { asked, ctx: { ops: { requestApproval: async (_c: unknown, tool: string, _i: unknown, meta: unknown) => (asked.push({ tool, meta }), decision) } } as unknown as ToolContext };
};

test("defineTool validates before running: a bad call is an error result the model can read, not an exception", async () => {
  let ran = 0;
  const tool = defineTool<{ n: number }>({ name: "t", description: "d", inputSchema: s({ n: { type: "integer" } }, ["n"]), async run({ n }) { ran++; return `got ${n}`; } });
  expect(await tool.execute({ n: "x" as never }, {} as ToolContext)).toEqual(errorResult('Invalid input for t: "n" must be an integer.'));
  expect(ran).toBe(0);
  expect(await tool.execute({ n: 2 }, {} as ToolContext)).toEqual(textResult("got 2"));
  expect(tool.group).toBe("harness");
});

test("a gated tool checks its input first, then asks a human for exactly this call, and only runs when allowed", async () => {
  let ran = 0;
  const tool = defineGatedTool<{ x: string }>({
    name: "danger",
    description: "d",
    inputSchema: s({ x: { type: "string" } }, ["x"]),
    describe: ({ x }) => ({ summary: `do ${x}`, reason: "it changes things" }),
    check: async ({ x }) => {
      if (x === "invalid") throw new Error("x is invalid");
    },
    async run() {
      ran++;
      return "done";
    },
  });
  const allow = ctx({ behavior: "allow", updatedInput: {} });
  expect(await tool.execute({ x: "go" }, allow.ctx)).toEqual(textResult("done"));
  expect(allow.asked).toEqual([{ tool: "danger", meta: { summary: "do go", reason: "it changes things", source: "policy", onceOnly: true } }]);
  const deny = ctx({ behavior: "deny", message: "no thanks" });
  expect(await tool.execute({ x: "go" }, deny.ctx)).toEqual(errorResult("no thanks"));
  expect(ran).toBe(1);
  // A call the check rejects never reaches a human.
  const never = ctx({ behavior: "allow", updatedInput: {} });
  await expect(tool.execute({ x: "invalid" }, never.ctx)).rejects.toThrow("x is invalid");
  expect(never.asked).toEqual([]);
});

test("truncateMiddle keeps the head and tail and says how much was cut", () => {
  expect(truncateMiddle("short", 10)).toBe("short");
  const long = "a".repeat(50) + "b".repeat(50);
  const out = truncateMiddle(long, 20);
  expect(out).toContain("[... 80 characters truncated ...]");
  expect(out.startsWith("a".repeat(8))).toBe(true);
  expect(out.endsWith("b".repeat(12))).toBe(true);
});

test("ticketView is the compact shape the board tools return, with null for what isn't set", () => {
  const view = ticketView(makeTicket({ status: "review", key: "A-1", title: "T", dependsOn: ["A-0"], externalRef: { source: "jira", key: "J-9", url: "https://j/9", raw: {} } }));
  expect(view).toMatchObject({ key: "A-1", externalKey: "J-9", externalUrl: "https://j/9", status: "review", dependsOn: ["A-0"], blockedReason: null, completionAction: null });
  expect(ticketView(makeTicket({ status: "planning" }))).toMatchObject({ externalKey: null, externalUrl: null });
});
