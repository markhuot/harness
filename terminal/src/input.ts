// ghostty-web makes the stage element itself `contenteditable` and focuses it, so that element is
// what the soft keyboard types into. Left alone, WebKit draws a native caret at its top left (in the
// tint colour on iOS, blinking on the Mac) next to ghostty's own canvas cursor, and iOS
// capitalizes and autocorrects what is typed, because ghostty only turns those off on its hidden
// textarea.

/** The slice of an HTMLElement that `hardenInput` touches. */
export interface InputElement {
  setAttribute(name: string, value: string): void;
  style: { caretColor: string };
}

const ATTRIBUTES: Record<string, string> = {
  autocapitalize: "none",
  autocorrect: "off",
  autocomplete: "off",
  spellcheck: "false",
};

/** Hide the native caret and turn off capitalization, correction and suggestions. */
export function hardenInput(el: InputElement | null | undefined): void {
  if (!el) return;
  for (const [name, value] of Object.entries(ATTRIBUTES)) el.setAttribute(name, value);
  el.style.caretColor = "transparent";
}
