import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@harness/shared";
import { ClaudeCodeDriver } from "./claude-code";
import { CLAUDE_MODEL_ALIASES, parseClaudeModels, queryClaudeModels } from "./claude-code-models";
import { ModelListError } from "./types";

const FAKE = join(import.meta.dir, "__fixtures__", "fake-claude.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-ccm-"));
  dirs.push(dir);
  const record = join(dir, "record.ndjson");
  return { record, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CLAUDE_RECORD: record, ...extra } };
}

async function failure(p: Promise<unknown>): Promise<ModelListError> {
  try {
    await p;
  } catch (err) {
    return err as ModelListError;
  }
  throw new Error("expected the promise to reject");
}

// Shape captured from the real CLI (2.1.x) on a team plan with availableModels set.
const REAL_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportsEffort: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for ambitious work" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Most efficient for everyday tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks" },
];

describe("parseClaudeModels", () => {
  test("drops the synthetic default entry and marks the model it resolves to", () => {
    const models = parseClaudeModels(REAL_MODELS);
    expect(models.map((m) => m.id)).toEqual(["opus", "claude-fable-5-1", "sonnet", "haiku", "claude-opus-5"]);
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual(["opus"]);
    expect(models[0]).toEqual({ id: "opus", name: "Opus 5.5", description: "Most capable for ambitious work", default: true });
  });

  test("keeps the default entry, named from its description, when nothing else matches it", () => {
    const models = parseClaudeModels([
      { value: "default", resolvedModel: "claude-secret-1", displayName: "Default (recommended)", description: "Secret 1 · Org pick" },
      { value: "haiku", resolvedModel: "claude-haiku-9", displayName: "Haiku 9" },
    ]);
    expect(models).toEqual([
      { id: "default", name: "Secret 1", description: "Secret 1 · Org pick", default: true },
      { id: "haiku", name: "Haiku 9" },
    ]);
  });

  test("no default entry → nothing marked; entries without a value are skipped; name falls back to id", () => {
    const models = parseClaudeModels([{ value: "sonnet" }, { displayName: "broken" }, null, { value: "" }]);
    expect(models).toEqual([{ id: "sonnet", name: "sonnet" }]);
  });

  test("a missing models list is an error", () => {
    expect(() => parseClaudeModels(undefined)).toThrow(/no models/);
  });
});

describe("queryClaudeModels against the fake CLI", () => {
  test("sends initialize over stream-json, parses models and strips nesting env", async () => {
    const { record, env: e } = env();
    const driver = new ClaudeCodeDriver({
      settings: () => ({}) as Settings,
      bin: FAKE,
      env: { ...e, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_BEDROCK: "0" },
    });
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: "opus", name: "Opus 9", description: "Most capable", default: true },
      { id: "haiku", name: "Haiku 9", description: "Fastest" },
    ]);
    const [inv] = readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(inv.argv).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    expect(inv.env.CLAUDECODE).toBeUndefined();
    expect(inv.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(inv.env.CLAUDE_CODE_USE_BEDROCK).toBe("0");
  });

  test("ignores junk lines and responses to other requests", async () => {
    const { env: e } = env({ FAKE_CLAUDE_INIT: "noise" });
    const models = await queryClaudeModels({ bin: FAKE, env: e });
    expect(models.map((m) => m.id)).toEqual(["opus", "haiku"]);
  });

  test("an error control_response → ModelListError with the alias fallback", async () => {
    const { env: e } = env({ FAKE_CLAUDE_INIT: "error" });
    const err = await failure(queryClaudeModels({ bin: FAKE, env: e }));
    expect(err).toBeInstanceOf(ModelListError);
    expect(err.message).toContain("Already initialized");
    expect(err.fallback).toEqual(CLAUDE_MODEL_ALIASES);
  });

  test("CLI exits without answering → error carries the stderr tail", async () => {
    const { env: e } = env({ FAKE_CLAUDE_INIT: "exit" });
    const err = await failure(queryClaudeModels({ bin: FAKE, env: e }));
    expect(err.message).toMatch(/exited.*without answering: Error: not logged in/);
    expect(err.fallback.map((m) => m.id)).toEqual(["sonnet", "opus", "fable", "haiku"]);
  });

  test("CLI that never answers is killed after the timeout", async () => {
    const { env: e } = env({ FAKE_CLAUDE_INIT: "hang" });
    const started = Date.now();
    const err = await failure(queryClaudeModels({ bin: FAKE, env: e, timeoutMs: 700 }));
    expect(err.message).toContain("timed out after 700 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an empty models list is an error, not an empty dropdown", async () => {
    const { env: e } = env({ FAKE_CLAUDE_MODELS: "[]" });
    const err = await failure(queryClaudeModels({ bin: FAKE, env: e }));
    expect(err.message).toContain("no models");
  });

  test("missing binary → ModelListError with aliases", async () => {
    const { env: e } = env();
    const err = await failure(queryClaudeModels({ bin: join(tmpdir(), "definitely-not-claude"), env: e }));
    expect(err).toBeInstanceOf(ModelListError);
    expect(err.fallback.length).toBe(4);
  });
});
