// Rendered spec diffs (shared/src/state/specDiff.ts) for HarnessKit's port. Each input is the older
// and newer revision; the output is what specDiff returns, which the Swift port must match exactly.
import { specDiff } from "../../src/state/specDiff";
import { cases } from "../case";

type Pair = { before: string; after: string };

const pairs: Record<string, Pair> = {
  "both empty": { before: "", after: "" },
  "empty before": { before: "", after: "# Goal\n\nShip it." },
  "empty after": { before: "# Goal\n\nShip it.", after: "" },
  unchanged: { before: "# Goal\n\nDo **it**.\n\n- a\n  - b", after: "# Goal\n\nDo **it**.\n\n- a\n  - b" },
  "one-word edit": { before: "The quick fox jumps.", after: "The slow fox jumps." },
  "word appended": { before: "Write tests", after: "Write more tests now" },
  "word removed": { before: "Write the unit tests", after: "Write the tests" },
  "edit inside bold": { before: "Ship **the new build** today", after: "Ship **the old build** today" },
  "edit inside em": { before: "*very slow* run", after: "*very fast* run" },
  "edit inside code": { before: "Run `bun test` here", after: "Run `bun typecheck` here" },
  "edit inside a link": { before: "See [the long docs](https://x.test/d) now", after: "See [the short docs](https://x.test/d) now" },
  "link target changed": { before: "[docs](https://a.test) here", after: "[docs](https://b.test) here" },
  "ticket key changed": { before: "Blocked on HARNESS-1 today", after: "Blocked on HARNESS-2 today" },
  "ticket link label changed": { before: "See [FOO-1](HARNESS-3)", after: "See [FOO-2](HARNESS-3)" },
  "inline image changed": { before: "Shot ![a](attachment:a) here", after: "Shot ![b](attachment:b) here" },
  "space between changes joins them": { before: "keep alpha beta keep", after: "keep gamma delta keep" },
  "multi-line paragraph": { before: "one\ntwo three\nfour", after: "one\ntwo five\nfour" },
  "line added to a paragraph": { before: "one\ntwo", after: "one\nmid\ntwo" },
  "quote edit": { before: "> keep this note", after: "> keep that note" },
  "heading text edit": { before: "## Open questions", after: "## Closed questions" },
  "heading level change": { before: "## Status", after: "### Status" },
  "paragraph became a list": { before: "# T\n\nalpha beta", after: "# T\n\n- alpha beta" },
  "list item inserted": { before: "- a\n- c", after: "- a\n- b\n- c" },
  "list item removed": { before: "- a\n- b\n- c", after: "- a\n- c" },
  "list item edited": { before: "- write the tests\n- ship", after: "- write the unit tests\n- ship" },
  "list item replaced": { before: "- alpha beta gamma delta epsilon\n- keep", after: "- one two three four five\n- keep" },
  "nested item inserted": { before: "- a\n  - x\n- b", after: "- a\n  - x\n  - y\n- b" },
  "nested item edited two deep": { before: "- a\n  - b\n    - old leaf words", after: "- a\n  - b\n    - new leaf words" },
  "ordered list renumbered": { before: "1. a\n2. b", after: "3. a\n4. b\n5. c" },
  "bullets became numbers": { before: "- a\n- b", after: "1. a\n2. b" },
  "table row added": { before: "| k | v |\n|---|---|\n| a | 1 |", after: "| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |" },
  "table cell changed": { before: "| k | v |\n|---|---|\n| a | one two |\n| b | 2 |", after: "| k | v |\n|---|---|\n| a | one three |\n| b | 2 |" },
  "table header changed": { before: "| key | value |\n|---|---|\n| a | 1 |", after: "| key | amount |\n|---|---|\n| a | 1 |" },
  "table row replaced": { before: "| k | v |\n|---|---|\n| apple | red |", after: "| k | v |\n|---|---|\n| banana | yellow |" },
  "table column added": { before: "| a |\n|---|\n| 1 |", after: "| a | b |\n|---|---|\n| 1 | 2 |" },
  "table alignment changed": { before: "| a |\n|---|\n| 1 |", after: "| a |\n|:-:|\n| 1 |" },
  "code line changed": { before: "```ts\nconst a = 1;\nconst b = 2;\nrun();\n```", after: "```ts\nconst a = 1;\nconst b = 3;\nrun();\n```" },
  "code line added at end": { before: "```sh\nbun test\n```", after: "```sh\nbun test\nbun run typecheck\n```" },
  "code language changed": { before: "```ts\nx\n```", after: "```js\nx\n```" },
  "image replaced": { before: "![a](attachment:a)", after: "![b](attachment:b)" },
  "image alt changed": { before: "![before](attachment:a)", after: "![after](attachment:a)" },
  "rule removed": { before: "x\n\n---", after: "x" },
  "blocks moved apart": { before: "# T\n\nold words here", after: "# T\n\nbrand new intro\n\n- x\n\nold words there" },
  "guard at 0.4 pairs": { before: "a b c d e", after: "a b x y z" },
  "guard at 0.2 splits": { before: "a b c d e", after: "a x y z w" },
  "guard uneven pairs": { before: "a b", after: "a x y" },
  "guard uneven splits": { before: "a b", after: "a x y z" },
  "two edits in one gap pair in order": { before: "first para words\n\nsecond para words", after: "first para text\n\nsecond para text" },
  "whitespace only paragraph change": { before: "a  b", after: "a b" },
  "emoji and accents": { before: "# 🎉 Party\n\ncafé ok", after: "# 🎉 Party\n\ncafé fine" },
  "CRLF before, LF after": { before: "# T\r\n\r\nsame text", after: "# T\n\nsame text" },
  "spec revision": {
    before:
      "# Goal\n\nShow changes as a raw diff.\n\n# Plan\n\n- Parse both revisions\n- Render the patch\n\n# Status\n\n| Step | State |\n|---|---|\n| Parse | done |\n| Render | todo |",
    after:
      "# Goal\n\nShow changes in the **rendered** spec.\n\n# Plan\n\n- Parse both revisions\n  - align blocks with an LCS\n- Render runs with `ins` and `del`\n- Write fixtures\n\n# Status\n\n| Step | State |\n|---|---|\n| Parse | done |\n| Render | done |\n| Fixtures | todo |\n\n```sh\nbun run test\n```",
  },
};

export const specDiffCases = cases((p: Pair) => specDiff(p.before, p.after), pairs);
