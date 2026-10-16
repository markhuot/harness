import { expect, test } from "bun:test";
import { hardenInput } from "./input";

const fake = () => {
  const attrs: Record<string, string> = {};
  return { attrs, setAttribute: (n: string, v: string) => void (attrs[n] = v), style: { caretColor: "" } };
};

test("the input turns off capitalization and correction and hides the native caret", () => {
  const el = fake();
  hardenInput(el);
  expect(el.attrs).toEqual({ autocapitalize: "none", autocorrect: "off", autocomplete: "off", spellcheck: "false" });
  expect(el.style.caretColor).toBe("transparent");
});

test("an element ghostty did not create is skipped", () => {
  expect(() => hardenInput(undefined)).not.toThrow();
});
