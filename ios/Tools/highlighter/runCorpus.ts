// Prints the RN app's highlight() result for every corpus input as JSON, `[{ name, input, output }]`.
// shared/fixtures/cases/highlight.ts runs this in a child bun with BUN_JSC_useRegExpJIT=false:
// JavaScriptCore's regex JIT mis-matches some of Shiki's JS-engine patterns (a trailing `// comment`
// in TypeScript comes out as an operator and an identifier), while its regex interpreter, which is
// what an iOS app's JSContext runs (apps get no JIT), matches Oniguruma. The fixtures describe the
// interpreter, i.e. what the phone shows.

import { highlight } from "../../../mobile/src/lib/highlight";
import { asyncCases } from "../../../shared/fixtures/case";
import { codeOf, HIGHLIGHT_INPUTS, type HighlightInput } from "./corpus";
import { wellFormed } from "./wellFormed";

export const runCorpus = () =>
  asyncCases(async (i: HighlightInput) => wellFormed(await highlight(codeOf(i), i.lang, i.theme, { diff: i.diff, appearance: i.appearance })), HIGHLIGHT_INPUTS);

if (import.meta.main) process.stdout.write(JSON.stringify(await runCorpus()));
