// Embedded pages' heights (DESIGN.md "Embedded pages"). A page attachment embedded in a spec posts
// its content height (the sizing script the service adds to every page it serves); the app sizes
// the embed to it. Pure, shared by the Mac app; HarnessKit's EmbedSize is the iOS port.

/** The embed's height before the page reports one, and for a page that never does (its CSP blocks the script). */
export const EMBED_DEFAULT_HEIGHT = 360;
/** The tallest an embed grows; past it the page scrolls inside, so a broken or hostile page can't make the spec endless. */
export const EMBED_MAX_HEIGHT = 5000;
/** Equal growth steps in a row that mean the page is tracking its own frame (a `100vh` layout plus a margin). */
const TRACKING_STEPS = 4;
/**
 * A page tracking its frame answers each resize within a frame or two; one that adds same-height
 * rows (a log, a streaming list) does so on its own schedule. Only a step reported this soon after
 * the embed's last resize counts toward TRACKING_STEPS.
 */
export const EMBED_TRACKING_MS = 250;

export interface EmbedSize {
  height: number;
  /** Growth of the last step, and how many quick steps in a row grew by exactly that */
  step: number;
  streak: number;
  /** When the embed last grew (ms), for telling a page that tracks its frame from one that grows on its own */
  at: number | null;
  /** Stopped following the page: it grows with its own frame, so it keeps its height and scrolls inside */
  locked: boolean;
}

export const initialEmbedSize = (): EmbedSize => ({ height: EMBED_DEFAULT_HEIGHT, step: 0, streak: 0, at: null, locked: false });

/**
 * The embed's size after the page reports `reported` (CSS px or points) at `now` (ms). Anything but a
 * positive finite number is ignored. Heights are whole and held to EMBED_MAX_HEIGHT. A page that
 * grows by the same amount TRACKING_STEPS times in a row, each within EMBED_TRACKING_MS of the
 * embed's last resize, is growing with its frame, which would never end: the embed stops following
 * it and keeps the height it has. Steps that come later start a new streak.
 */
export function embedSizeAfter(s: EmbedSize, reported: unknown, now: number): EmbedSize {
  if (s.locked || typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return s;
  const next = Math.min(Math.ceil(reported), EMBED_MAX_HEIGHT);
  if (next <= s.height) return { height: next, step: 0, streak: 0, at: s.at, locked: false };
  const step = next - s.height;
  const quick = s.at !== null && now - s.at < EMBED_TRACKING_MS;
  const streak = quick && step === s.step ? s.streak + 1 : 1;
  if (streak >= TRACKING_STEPS) return { ...s, locked: true };
  return { height: next, step, streak, at: now, locked: false };
}
