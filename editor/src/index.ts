export { createEditor, shadowOf } from "./editor";
export { createDiffEditor } from "./diff";
export type { EditorHandle, EditorOptions, EditorProbe, LineRange } from "./editor";
export type { DiffEditorHandle, DiffEditorOptions } from "./diff";
export { BUNDLED_LANGUAGES, resolveLanguage, PLAIN } from "./language";
export type { EditorTheme, ThemeInput, TokenMap } from "./theme";
export { mount } from "./bridge";
export type { BridgeEvent, BridgeCommand, Mounted } from "./bridge";
