// What a window reports as on screen to the service.

/**
 * What this window reports. Chromium keeps `visibilityState` "visible" while the display sleeps, so
 * an away person reports nothing on screen however the window looks.
 */
export function reportedPresence(
  visible: boolean,
  away: boolean,
  tickets: string[],
  terminals: string[],
): { visible: boolean; tickets: string[]; terminals: string[] } {
  return away ? { visible: false, tickets: [], terminals: [] } : { visible, tickets, terminals };
}
