import { describe, expect, test } from "bun:test";
import { parseTemplate, renderTemplate, templateError, templateVariables } from "./templates";

describe("renderTemplate", () => {
  test("substitutes variables and copies text around tags exactly", () => {
    expect(renderTemplate("Hi {{name}},\n  {{ n }} left ", { name: "Ada", n: 3 })).toBe("Hi Ada,\n  3 left ");
  });

  test("if/else picks by truthiness: empty string, false and 0 are falsy", () => {
    const t = "{{#if x}}yes{{else}}no{{/if}}";
    expect(renderTemplate(t, { x: "a" })).toBe("yes");
    expect(renderTemplate(t, { x: true })).toBe("yes");
    expect(renderTemplate(t, { x: 2 })).toBe("yes");
    expect(renderTemplate(t, { x: "" })).toBe("no");
    expect(renderTemplate(t, { x: false })).toBe("no");
    expect(renderTemplate(t, { x: 0 })).toBe("no");
    expect(renderTemplate("a{{#if x}}b{{/if}}c", { x: false })).toBe("ac");
  });

  test("else if chains stop at the first truthy branch and share one {{/if}}", () => {
    const t = "[{{#if a}}A{{else if b}}B{{else if c}}C{{else}}D{{/if}}]";
    expect(renderTemplate(t, { a: true, b: true, c: true })).toBe("[A]");
    expect(renderTemplate(t, { a: false, b: true, c: true })).toBe("[B]");
    expect(renderTemplate(t, { a: false, b: false, c: true })).toBe("[C]");
    expect(renderTemplate(t, { a: false, b: false, c: false })).toBe("[D]");
    // without a final else, nothing
    expect(renderTemplate("[{{#if a}}A{{else if b}}B{{/if}}]", { a: false, b: false })).toBe("[]");
  });

  test("blocks nest", () => {
    const t = "{{#if a}}{{#if b}}ab{{else}}a{{/if}}!{{else}}{{#if b}}b{{/if}}-{{/if}}";
    expect(renderTemplate(t, { a: true, b: true })).toBe("ab!");
    expect(renderTemplate(t, { a: true, b: false })).toBe("a!");
    expect(renderTemplate(t, { a: false, b: true })).toBe("b-");
    expect(renderTemplate(t, { a: false, b: false })).toBe("-");
  });

  test("a missing variable is an error wherever the render reaches it", () => {
    expect(() => renderTemplate("{{x}}", {})).toThrow("Missing template variable {{x}}");
    expect(() => renderTemplate("{{#if x}}a{{/if}}", {})).toThrow("{{x}}");
    // only what the render walks is read
    expect(renderTemplate("{{#if a}}{{y}}{{/if}}", { a: false })).toBe("");
  });

  test("values are inserted as text, not re-parsed as templates", () => {
    expect(renderTemplate("{{v}}", { v: "{{#if x}}" })).toBe("{{#if x}}");
  });

  test("single braces are plain text", () => {
    expect(renderTemplate("`browser_open` { url } {x}", {})).toBe("`browser_open` { url } {x}");
  });
});

describe("parseTemplate rejects malformed templates with the line", () => {
  const cases: [string, string][] = [
    ["a\n{{#if x}}b", 'Line 2: {{#if x}} is never closed with {{/if}}'],
    ["{{/if}}", "{{/if}} without an open {{#if}}"],
    ["{{else}}", "{{else}} without an open {{#if}}"],
    ["{{else if y}}", "without an open {{#if}}"],
    ["{{#if x}}a{{else}}b{{else}}c{{/if}}", "a second {{else}}"],
    ["{{#if x}}a{{else}}b{{else if y}}c{{/if}}", "after {{else}}"],
    ["{{#if x}}{{/if}}{{/if}}", "{{/if}} without an open {{#if}}"],
    ["hi {{name", '"{{" is never closed'],
    ["{{#each items}}", "isn't a template tag"],
    ["{{two words}}", "isn't a template tag"],
    ["{{}}", "isn't a template tag"],
    ["{{#if 1x}}{{/if}}", "isn't a variable name"],
    ["{{#if}}{{/if}}", "isn't a template tag"],
  ];
  for (const [src, message] of cases) {
    test(JSON.stringify(src), () => {
      expect(() => parseTemplate(src)).toThrow(message);
    });
  }

  test("an else-if chain inside a nested block still needs the outer {{/if}}", () => {
    expect(() => parseTemplate("{{#if a}}{{#if b}}x{{else if c}}y{{/if}}")).toThrow("{{#if a}} is never closed");
    expect(() => parseTemplate("{{#if a}}{{#if b}}x{{else if c}}y{{/if}}{{/if}}")).not.toThrow();
  });
});

describe("templateError", () => {
  test("null for a valid template using only allowed variables", () => {
    expect(templateError("{{#if a}}{{b}}{{/if}}", ["a", "b", "c"])).toBeNull();
  });

  test("names unknown variables, including ones only used as conditions, and lists the known ones", () => {
    expect(templateError("{{ticket}} {{#if brnch}}x{{/if}} {{tickt}}", ["ticket", "branch"])).toBe(
      "Unknown variables {{brnch}}, {{tickt}}: the variables are {{ticket}}, {{branch}}",
    );
    expect(templateError("{{x}}", [])).toBe("Unknown variable {{x}}: it has no variables");
  });

  test("reports syntax errors before variables", () => {
    expect(templateError("{{nope}}{{/if}}", [])).toContain("without an open {{#if}}");
  });

  test("templateVariables lists each variable once", () => {
    expect(templateVariables(parseTemplate("{{a}}{{#if b}}{{a}}{{else if c}}{{d}}{{/if}}"))).toEqual(["a", "b", "c", "d"]);
  });
});
