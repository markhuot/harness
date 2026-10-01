// Prompt templates (shared/src/templates.ts) for HarnessKit's Templates.swift. Thrown errors are
// recorded as `{ error: message }`, so Swift has to produce the exact same message.
import { parseTemplate, renderTemplate, templateError, type TemplateVars, templateVariables } from "../../src/templates";
import { cases } from "../case";

function attempt<T>(fn: () => T): { ok: T } | { error: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const parseTemplateCases = cases((src: string) => attempt(() => parseTemplate(src)), {
  // templates.test.ts (malformed)
  "unclosed if on line 2": "a\n{{#if x}}b",
  "stray /if": "{{/if}}",
  "stray else": "{{else}}",
  "stray else if": "{{else if y}}",
  "second else": "{{#if x}}a{{else}}b{{else}}c{{/if}}",
  "else if after else": "{{#if x}}a{{else}}b{{else if y}}c{{/if}}",
  "extra /if": "{{#if x}}{{/if}}{{/if}}",
  "unclosed braces": "hi {{name",
  "each is not a tag": "{{#each items}}",
  "two words": "{{two words}}",
  "empty tag": "{{}}",
  "bad variable name": "{{#if 1x}}{{/if}}",
  "if without a name": "{{#if}}{{/if}}",
  "nested else-if chain still needs the outer /if": "{{#if a}}{{#if b}}x{{else if c}}y{{/if}}",
  "nested else-if chain closed": "{{#if a}}{{#if b}}x{{else if c}}y{{/if}}{{/if}}",
  // well-formed
  empty: "",
  "text only": "Hello\nworld",
  "single braces": "`browser_open` { url } {x}",
  "variable with padding": "Hi {{ name }},\n  {{n}} left ",
  "full chain": "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]",
  nested: "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}",
  "tab and newline inside tags": "{{#if\ta}}x{{else\n if\tb}}y{{/if}}",
  "NBSP padding is trimmed": "{{ x }}",
  "underscore names": "{{_}}{{a_1}}{{_B}}",
  "triple braces": "{{{x}}}",
  "close before open": "}} {{x}}",
  "adjacent tags": "{{a}}{{b}}",
  "emoji text kept": "😀{{x}}é",
  "CRLF counts as one line each": "a\r\nb\r\n{{#if x}}",
  // malformed, more
  "unclosed on line 3 after text": "x\ny\nz {{a",
  "error on line 3 counts newlines in tags": "{{#if a}}\n{{\n}}\n{{/if}}",
  "else after else if chain": "{{#if a}}{{else if b}}{{else}}{{else}}{{/if}}",
  "else if non-name": "{{#if a}}{{else if 2}}{{/if}}",
  "if with two names": "{{#if a b}}{{/if}}",
  "elseif without space": "{{#if a}}{{elseif b}}{{/if}}",
  "hyphen name": "{{a-b}}",
  "unicode name": "{{ñ}}",
  "unicode if name": "{{#if ñ}}{{/if}}",
  "NEL is not trimmed": "{{\u0085x}}",
  "/if with spaces": "{{ /if }}",
  "#if with trailing space inside": "{{#if a }}x{{/if}}",
  "else with spaces": "{{#if a}}{{ else }}{{/if}}",
  "unclosed inner and outer reports the outer": "{{#if a}}\n{{#if b}}",
  "chain inside chain": "{{#if a}}{{else if b}}{{#if c}}{{else if d}}{{/if}}{{/if}}",
  "nested open after closed": "{{#if a}}{{/if}}\n{{#if b}}",
});

export const templateVariablesCases = cases((src: string) => templateVariables(parseTemplate(src)), {
  "each once, in first-use order": "{{a}}{{#if b}}{{a}}{{else if c}}{{d}}{{/if}}",
  none: "plain",
  "else branch only": "{{#if x}}{{else}}{{y}}{{x}}{{/if}}",
  "nested order": "{{#if a}}{{#if b}}{{c}}{{/if}}{{/if}}{{b}}",
});

type ErrorInput = { src: string; allowed: string[] };

export const templateErrorCases = cases(({ src, allowed }: ErrorInput) => templateError(src, allowed), {
  // templates.test.ts
  valid: { src: "{{#if a}}{{b}}{{/if}}", allowed: ["a", "b", "c"] },
  "unknown variables listed with the known ones": { src: "{{ticket}} {{#if brnch}}x{{/if}} {{tickt}}", allowed: ["ticket", "branch"] },
  "no variables": { src: "{{x}}", allowed: [] },
  "syntax before variables": { src: "{{nope}}{{/if}}", allowed: [] },
  // more
  "one unknown with one known": { src: "{{y}}", allowed: ["x"] },
  "unknown condition only": { src: "{{#if z}}{{/if}}", allowed: ["a"] },
  "repeated unknown named once": { src: "{{q}}{{q}}", allowed: ["a"] },
  "empty template": { src: "", allowed: [] },
  "unclosed": { src: "{{#if a}}", allowed: ["a"] },
} satisfies Record<string, ErrorInput>);

type RenderInput = { template: string; vars: TemplateVars };

export const renderTemplateCases = cases(({ template, vars }: RenderInput) => attempt(() => renderTemplate(template, vars)), {
  // templates.test.ts
  "substitutes and copies text exactly": { template: "Hi {{name}},\n  {{ n }} left ", vars: { name: "Ada", n: 3 } },
  "if string": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: "a" } },
  "if true": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: true } },
  "if 2": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: 2 } },
  "if empty string": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: "" } },
  "if false": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: false } },
  "if 0": { template: "{{#if x}}yes{{else}}no{{/if}}", vars: { x: 0 } },
  "falsy without else": { template: "a{{#if x}}b{{/if}}c", vars: { x: false } },
  "chain A": { template: "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]", vars: { a: true, b: true, c: true } },
  "chain B": { template: "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]", vars: { a: false, b: true, c: true } },
  "chain C": { template: "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]", vars: { a: false, b: false, c: true } },
  "chain D": { template: "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]", vars: { a: false, b: false, c: false } },
  "chain without else": { template: "[{{#if a}}A{{else if b}}B{{/if}}]", vars: { a: false, b: false } },
  "nested ab": { template: "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}", vars: { a: true, b: true } },
  "nested a": { template: "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}", vars: { a: true, b: false } },
  "nested b": { template: "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}", vars: { a: false, b: true } },
  "nested none": { template: "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}", vars: { a: false, b: false } },
  "missing variable": { template: "{{x}}", vars: {} },
  "missing condition": { template: "{{#if x}}a{{/if}}", vars: {} },
  "unreached missing variable": { template: "{{#if a}}{{y}}{{/if}}", vars: { a: false } },
  "values are not re-parsed": { template: "{{v}}", vars: { v: "{{#if x}}" } },
  "single braces": { template: "`browser_open` { url } {x}", vars: {} },
  // more
  "parse error is thrown": { template: "{{#if a}}", vars: { a: true } },
  "numbers print like JS": { template: "{{a}} {{b}} {{c}} {{d}} {{e}}", vars: { a: 1.5, b: -0, c: 1e21, d: 1e-7, e: 100 } },
  "booleans print": { template: "{{t}}/{{f}}", vars: { t: true, f: false } },
  "negative is truthy": { template: "{{#if n}}y{{else}}n{{/if}}", vars: { n: -1 } },
  "whitespace string is truthy": { template: "{{#if s}}y{{else}}n{{/if}}", vars: { s: " " } },
  "string 0 is truthy": { template: "{{#if s}}y{{else}}n{{/if}}", vars: { s: "0" } },
  "string false is truthy": { template: "{{#if s}}y{{else}}n{{/if}}", vars: { s: "false" } },
  "unicode values": { template: "{{a}}|{{b}}", vars: { a: "😀", b: "é" } },
  "CRLF text kept": { template: "a\r\n{{x}}\r\n", vars: { x: "b" } },
  "toString is not a variable": { template: "{{toString}}", vars: {} },
  "__proto__ is not a variable": { template: "{{__proto__}}", vars: {} },
} satisfies Record<string, RenderInput>);
