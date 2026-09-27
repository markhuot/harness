import type { Settings } from "@harness/shared";
import { AnthropicApiDriver } from "./anthropic-api";
import { ClaudeCodeDriver } from "./claude-code";
import { DummyDriver } from "./dummy";
import type { Driver } from "./types";

export { AnthropicApiDriver } from "./anthropic-api";
export { ClaudeCodeDriver } from "./claude-code";
export { DummyDriver } from "./dummy";

export function createDrivers(deps: { settings: () => Settings }): Driver[] {
  return [
    new ClaudeCodeDriver({ settings: deps.settings }),
    new AnthropicApiDriver({ settings: deps.settings }),
    new DummyDriver(),
  ];
}
