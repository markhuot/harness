/**
 * The world's clock. Every timestamp in the world is `NOW` minus a span, so the data never ages
 * and the Mac and iPhone renders agree on "3 minutes ago" on every run, on every machine.
 */
export const NOW = Date.UTC(2026, 2, 14, 15, 0, 0);

/** The IANA zone both clients format dates in. UTC keeps a developer's own zone out of the picture. */
export const TIME_ZONE = "UTC";

/** The locale both clients format numbers and dates in. */
export const LOCALE = "en_US";

const MINUTE = 60_000;

export const minutesAgo = (n: number): number => NOW - n * MINUTE;
export const hoursAgo = (n: number): number => NOW - n * 60 * MINUTE;
export const daysAgo = (n: number): number => NOW - n * 24 * 60 * MINUTE;
