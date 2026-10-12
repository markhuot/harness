export { createEditor, createDiffEditor } from "./editor";
export type { EditorHandle, EditorOptions, DiffEditorHandle, DiffEditorOptions, LineRange } from "./editor";
export { languageName, resolveLanguage, PLAIN } from "./language";
export type { EditorTheme, ThemeInput, TokenMap } from "./theme";
export { mount } from "./bridge";
export type { BridgeEvent, BridgeCommand, Mounted } from "./bridge";
