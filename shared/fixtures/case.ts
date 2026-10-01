// Helpers for fixture case files (shared/fixtures/cases/*.ts). A case pairs an input with the
// output the real TypeScript function returns for it, so the Swift port (ios/HarnessKit) can be
// checked against exactly what TS does. See ios/ARCHITECTURE.md § "Fixture pipeline".

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
