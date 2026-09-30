import type { Settings } from "@harness/shared";
import { AnthropicApiDriver } from "./anthropic-api";
import { ClaudeCodeDriver } from "./claude-code";
import { DummyDriver } from "./dummy";
import type { Driver } from "./types";

export { AnthropicApiDriver } from "./anthropic-api";
export { ClaudeCodeDriver } from "./claude-code";
export { DummyDriver } from "./dummy";

/** The env var that adds the dummy driver to a real service; test scripts set it, installs don't. */
export const DUMMY_DRIVER_ENV = "HARNESS_DUMMY_DRIVER";

export function dummyDriverEnabled(env: Record<string, string | undefined>): boolean {
  return env[DUMMY_DRIVER_ENV] === "1";
}

export function createDrivers(deps: { settings: () => Settings; env?: Record<string, string | undefined> }): Driver[] {
  const drivers: Driver[] = [new ClaudeCodeDriver({ settings: deps.settings }), new AnthropicApiDriver({ settings: deps.settings })];
  if (dummyDriverEnabled(deps.env ?? process.env)) drivers.push(new DummyDriver());
  return drivers;
}
