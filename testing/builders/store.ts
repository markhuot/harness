import { openDb } from "../../service/src/db";
import { Store } from "../../service/src/store";
import type { Clock } from "../../service/src/clock";
import type { Project, Ticket } from "@harness/shared";
import type { NewProject } from "../../service/src/store/projects";
import { tempDir } from "./tmp";

/** A store on an in-memory database, stamping rows with `now`. Attachment folders live in a per-test temp dir. */
export function makeStore(opts: { now?: Clock } = {}): Store {
  const home = tempDir();
  const db = openDb(":memory:", { attachmentsDir: `${home}/attachments`, uploadsDir: `${home}/uploads`, now: opts.now });
  return new Store(db, opts.now);
}

/** A project row with a unique-enough path; override what the test is about. */
export function addProject(store: Store, overrides: Partial<NewProject> = {}): Project {
  return store.projects.create({ name: "Test", path: tempDir(), key: "TEST", ...overrides });
}

/** A ticket row (and its session) in `status`, written through the store the way the service writes one. */
export function addTicket(store: Store, project: Project, overrides: { key?: string; title?: string; status?: Ticket["status"] } = {}): Ticket {
  const key = overrides.key ?? store.projects.takeNextKey(project.id, () => false);
  const session = store.sessions.create({ key, kind: "ticket", ticketId: null, driver: "claude-code", cwd: project.path, title: key });
  return store.tickets.create({
    key,
    projectId: project.id,
    kind: "task",
    title: overrides.title ?? key,
    spec: "",
    status: overrides.status ?? "planning",
    sessionId: session.id,
    driver: "claude-code",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    externalRef: null,
    workdir: null,
  });
}
