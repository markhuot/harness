/** Exports of shared/src/protocol.ts that are not wire data, each with why it has no fixture. */
export const TYPE_EXEMPTIONS: Record<string, string> = {
  ApiOk: "Generic over the response body: the body types it wraps are fixtured on their own",
};

export const VALUE_EXEMPTIONS: Record<string, string> = {
  DEFAULT_PORT: "A number the apps default to, not a field",
  DEFAULT_CONTEXT_GAUGE_LIMIT: "A limit the apps enforce, not a field",
  MIN_CONTEXT_GAUGE_LIMIT: "A limit the apps enforce, not a field",
  MAX_CONTEXT_GAUGE_LIMIT: "A limit the apps enforce, not a field",
  MAX_PROMPT_ATTACHMENTS: "A limit the apps enforce, not a field",
  DEFAULT_BROWSER_IDLE_TAB_MINUTES: "A limit the apps enforce, not a field",
  MAX_BROWSER_IDLE_TAB_MINUTES: "A limit the apps enforce, not a field",
  DEFAULT_EVENT_RETENTION_DAYS: "A limit the apps enforce, not a field",
  MAX_EVENT_RETENTION_DAYS: "A limit the apps enforce, not a field",
  MAX_RUNNING_TERMINALS: "A limit the apps enforce, not a field",
  MIN_TERMINAL_COLS: "A limit the apps enforce, not a field",
  MIN_TERMINAL_ROWS: "A limit the apps enforce, not a field",
  MAX_TERMINAL_COLS: "A limit the apps enforce, not a field",
  MAX_TERMINAL_ROWS: "A limit the apps enforce, not a field",
  BROWSER_DESKTOP: "A viewport size preset, not a field",
  BROWSER_MOBILE: "A viewport size preset, not a field",
  BROWSER_MIN_SIDE: "A limit the apps enforce, not a field",
  BROWSER_MAX_SIDE: "A limit the apps enforce, not a field",
  BROWSER_MOBILE_UA: "A user agent string the service sends to Chrome, not a field",
  MAX_ANNOTATION_MARKS: "A limit the apps enforce, not a field",
  MAX_ANNOTATION_MESSAGE: "A limit the apps enforce, not a field",
  MAX_ANNOTATION_TEXT: "A limit the apps enforce, not a field",
  MAX_ANNOTATION_PATH: "A limit the apps enforce, not a field",
  RENAMED_PROMPT_IDS: "A migration table (old id → new id), not a message",
  reviewPassed: "A function over a field, not data",
  contextTokens: "A function over a field, not data",
  isConductor: "A function over a field, not data",
};
