// Helpers for fixture case files (shared/fixtures/cases/*.ts). A case pairs an input with the
// output the real TypeScript function returns for it, so the Swift port (ios/HarnessKit) can be
// checked against exactly what TS does. See ios/ARCHITECTURE.md § "Fixture pipeline".
//
// Some outputs have no TypeScript implementation any more: the logic lived only in the retired React
// Native app, and the Swift port is now its sole implementation. Those are "frozen": `frozen()` reads
// the value back from the committed JSON, so the exporter rewrites it unchanged and the JSON is the
// spec Swift is held to. Outputs computed from shared/ code stay computed, so drift is still caught.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where shared/fixtures/cases/<module>.ts is written as <module>.json. */
export const CASE_FIXTURES_DIR = resolve(import.meta.dir, "../../ios/HarnessKit/Tests/HarnessKitTests/Fixtures");

/** A frozen export: `key` of the committed <module>.json, exactly as it was last generated. */
export function frozen<T = unknown>(module: string, key: string): T {
  const data = JSON.parse(readFileSync(join(CASE_FIXTURES_DIR, `${module}.json`), "utf8")) as Record<string, unknown>;
  if (!Object.hasOwn(data, key)) throw new Error(`frozen fixture ${module}.json has no "${key}"`);
  return data[key] as T;
}

export interface Case<I, O> {
  name: string;
  input: I;
  output: O;
}

type Inputs<I> = readonly (readonly [name: string, input: I])[] | Record<string, I>;

function entries<I>(inputs: Inputs<I>): (readonly [string, I])[] {
  return Array.isArray(inputs) ? [...(inputs as readonly (readonly [string, I])[])] : Object.entries(inputs as Record<string, I>);
}

/** Run `fn` over named inputs. An undefined output is written as null (JSON has no undefined). */
export function cases<I, O>(fn: (input: I) => O, inputs: Inputs<I>): Case<I, O | null>[] {
  return entries(inputs).map(([name, input]) => {
    const output = fn(input);
    return { name, input, output: output === undefined ? null : output };
  });
}

/** `cases` for async functions (the exporter awaits exported promises). */
export async function asyncCases<I, O>(fn: (input: I) => Promise<O>, inputs: Inputs<I>): Promise<Case<I, O | null>[]> {
  const out: Case<I, O | null>[] = [];
  for (const [name, input] of entries(inputs)) {
    const output = await fn(input);
    out.push({ name, input, output: output === undefined ? null : output });
  }
  return out;
}
