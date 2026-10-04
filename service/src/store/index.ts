import type { Database } from "bun:sqlite";
import { ProjectRepo } from "./projects";
import { TicketRepo } from "./tickets";
import { SessionRepo } from "./sessions";
import { RunRepo } from "./runs";
import { TranscriptRepo } from "./transcript";
import { ActivityRepo } from "./activity";
import { AttachmentRepo } from "./attachments";
import { SpecRepo } from "./spec";
import { SubagentRepo } from "./subagents";
import { WatcherRepo } from "./watchers";
import { CounterRepo, SeenRepo, SettingsRepo } from "./misc";
import { BrowserTabRepo } from "./browser-tabs";

export class Store {
  readonly projects: ProjectRepo;
  readonly tickets: TicketRepo;
  readonly sessions: SessionRepo;
  readonly runs: RunRepo;
  readonly transcript: TranscriptRepo;
  readonly activity: ActivityRepo;
  readonly attachments: AttachmentRepo;
  readonly specs: SpecRepo;
  readonly subagents: SubagentRepo;
  readonly watchers: WatcherRepo;
  readonly seen: SeenRepo;
  readonly settings: SettingsRepo;
  readonly counters: CounterRepo;
  readonly browserTabs: BrowserTabRepo;

  constructor(readonly db: Database) {
    this.projects = new ProjectRepo(db);
    this.tickets = new TicketRepo(db);
    this.sessions = new SessionRepo(db);
    this.runs = new RunRepo(db);
    this.transcript = new TranscriptRepo(db);
    this.activity = new ActivityRepo(db);
    this.attachments = new AttachmentRepo(db);
    this.specs = new SpecRepo(db);
    this.subagents = new SubagentRepo(db);
    this.watchers = new WatcherRepo(db);
    this.seen = new SeenRepo(db);
    this.settings = new SettingsRepo(db);
    this.counters = new CounterRepo(db);
    this.browserTabs = new BrowserTabRepo(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export { ProjectRepo, TicketRepo, SessionRepo, RunRepo, TranscriptRepo, ActivityRepo, AttachmentRepo, SpecRepo, SubagentRepo, WatcherRepo, SeenRepo, SettingsRepo, CounterRepo, BrowserTabRepo };
export { normalizeProjectKey } from "./projects";
export { SpecConflictError } from "./spec";
