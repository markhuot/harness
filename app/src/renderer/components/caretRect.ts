// Where the caret's line is in a textarea, so an autocomplete opens right under (or over) the line
// being typed on instead of against the whole field (components/MentionTextarea.tsx). The DOM
// doesn't say where a caret is, so caretOffset lays the text out in a hidden copy of the textarea
// (same box, font and wrapping) and measures a marker at the caret. caretAnchor turns that into a
// window rect, kept inside the field's visible part; it's pure so the edge cases are unit tested.

/** Styles that decide where text wraps and how tall its lines are. */
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontFeatureSettings",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
] as const;

/** The caret's line within the textarea's content, from its border box's top-left (before scrolling). */
export interface CaretOffset {
  top: number;
  height: number;
}

export function caretOffset(el: HTMLTextAreaElement, index: number): CaretOffset {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of MIRRORED) mirror.style[p] = style[p];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: style.wordBreak,
    // The textarea's scrollbar takes width from its text.
    overflowY: el.scrollHeight > el.clientHeight ? "scroll" : "hidden",
    height: "auto",
  });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  // The rest of the word, so the marker wraps where the typed word does.
  marker.textContent = el.value.slice(index).match(/^\S*/)![0] || "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    // offsetTop is the marker's glyph box from the padding edge; the line it's on starts a little
    // above it (half the leading), so count whole lines from the padding.
    const padTop = parseFloat(style.paddingTop);
    const line = Math.max(0, Math.floor((marker.offsetTop - padTop + marker.offsetHeight / 2) / lineHeight));
    return { top: parseFloat(style.borderTopWidth) + padTop + line * lineHeight, height: lineHeight };
  } finally {
    mirror.remove();
  }
}

/**
 * The window rect of the caret's line: the field's width (the menu lines up with the field), the
 * line's height, `scrollTop` taken off. A line scrolled out of view is kept at the field's visible
 * edge, so the menu never floats away from the field.
 */
export function caretAnchor(field: { left: number; right: number; top: number; bottom: number }, caret: CaretOffset, scrollTop: number) {
  const height = Math.min(caret.height, field.bottom - field.top);
  const top = Math.max(field.top, Math.min(field.top + caret.top - scrollTop, field.bottom - height));
  return { left: field.left, right: field.right, top, bottom: top + height };
}
