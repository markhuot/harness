// Where a message from the ticket composer shows up: from the Spec and Activity tabs it's logged
// to Activity (MessageBody.log), from every other tab it goes to the agent and the transcript only.

import { logsMessages, type TicketTab } from "@harness/shared/state";

export function composerLog(tab: TicketTab): { log: boolean; destination: string } {
  return logsMessages(tab) ? { log: true, destination: "Shows in Activity" } : { log: false, destination: "Transcript only" };
}
