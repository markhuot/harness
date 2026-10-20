import type { Database } from "bun:sqlite";
import { GroupRepo, ProjectRepo } from "./projects";
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
import { DeviceRepo } from "./devices";
import { type Clock, systemClock } from "../clock";
import { resolveSettings } from "../orchestrator/settings";

export class Store {
  readonly projects: ProjectRepo;
  readonly groups: GroupRepo;
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
  readonly devices: DeviceRepo;

  constructor(readonly db: Database, now: Clock = systemClock) {
    this.projects = new ProjectRepo(db, now);
    this.groups = new GroupRepo(db, now);
    this.settings = new SettingsRepo(db);
    // A ticket's legacy driver follows the settings' choices it inherits.
    this.tickets = new TicketRepo(db, () => resolveSettings(this.settings.all()).phaseModels ?? {}, now);
    this.sessions = new SessionRepo(db, now);
    this.runs = new RunRepo(db, now);
    this.transcript = new TranscriptRepo(db, now);
    this.activity = new ActivityRepo(db, now);
    this.attachments = new AttachmentRepo(db, now);
    this.specs = new SpecRepo(db, now);
    this.subagents = new SubagentRepo(db, now);
    this.watchers = new WatcherRepo(db, now);
    this.seen = new SeenRepo(db, now);
    this.counters = new CounterRepo(db);
    this.browserTabs = new BrowserTabRepo(db, now);
    this.devices = new DeviceRepo(db, now);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export { ProjectRepo, GroupRepo, TicketRepo, SessionRepo, RunRepo, TranscriptRepo, ActivityRepo, AttachmentRepo, SpecRepo, SubagentRepo, WatcherRepo, SeenRepo, SettingsRepo, CounterRepo, BrowserTabRepo, DeviceRepo };
export { normalizeProjectKey } from "./projects";
export { SpecConflictError } from "./spec";
