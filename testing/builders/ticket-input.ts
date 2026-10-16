import type { Project, Ticket } from "@harness/shared";
import type { Store } from "../../service/src/store";
import type { NewTicket } from "../../service/src/store/tickets";

/**
 * A ticket (and its session) written through the store with any of the create inputs the
 * smaller `addTicket` doesn't take: dependencies, a parent, a remote link, a draft.
 */
export function addTicketWith(store: Store, project: Project, overrides: Partial<NewTicket> = {}): Ticket {
  const key = overrides.key ?? store.projects.takeNextKey(project.id, () => false);
  const session = store.sessions.create({ key, kind: "ticket", ticketId: null, driver: "claude-code", cwd: project.path, title: key });
  return store.tickets.create({
    key,
    projectId: project.id,
    kind: "task",
    title: key,
    spec: "",
    status: "planning",
    sessionId: session.id,
    driver: "claude-code",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    externalRef: null,
    workdir: null,
    ...overrides,
  });
}
