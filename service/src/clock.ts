/** The service's source of the current time, in epoch milliseconds. Passed down as the `now` option; the default is the real clock. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
