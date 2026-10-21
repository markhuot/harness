import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import type { BusEvent } from "../../service/src/events";
import { ensureHome } from "../../service/src/config";
import { openDb } from "../../service/src/db";
import type { Driver } from "../../service/src/drivers/types";
import { EventBus } from "../../service/src/events";
import { Orchestrator, type OrchestratorOptions } from "../../service/src/orchestrator/orchestrator";
import { Store } from "../../service/src/store";
import { QuietBrowser } from "../builders/harness";
import { fakeClock, type FakeClock } from "../builders/clock";
import { tempDir } from "../builders/tmp";
import { FakeDriver, toolCall, type Step } from "./fake-driver";
import { assertNoTimerLeaks, trackTimers } from "./leaks";

export interface OrchestratorRig<D extends Driver = FakeDriver> {
  orch: Orchestrator;
  store: Store;
  bus: EventBus;
  driver: D;
  clock: FakeClock;
  project: Project;
  home: string;
  events: BusEvent[];
  logs: string[];
  /** Resolves once the orchestrator has nothing queued, running or starting. Yields to the event loop; never sleeps. */
  settle(): Promise<void>;
  /** The ticket as the store has it now. */
  ticket(key: string): Ticket;
}

/**
 * An Orchestrator over an in-memory store with the scripted driver, an injected clock, a quiet
 * browser, no tools, no watchers, no reconcile interval and no `gh`: nothing outside the process.
 * The project doesn't use worktrees, so no git runs. The caller stops it with `stop()` through
 * `afterEach(stopAll)`.
 */
export function makeOrchestrator<D extends Driver = FakeDriver>(opts: Partial<OrchestratorOptions> & { driver?: D; startedAt?: number } = {}): OrchestratorRig<D> {
  trackTimers();
  const home = tempDir("h-orch-");
  const paths = ensureHome(home);
  const clock = fakeClock(opts.startedAt ?? 1_700_000_000_000);
  const store = new Store(openDb(":memory:", { attachmentsDir: paths.attachmentsDir, uploadsDir: paths.uploadsDir, now: clock }), clock);
  const bus = new EventBus();
  const driver = (opts.driver ?? new FakeDriver()) as D;
  const phase = { driver: driver.id, model: null };
  store.settings.set({ phaseModels: { plan: phase, work: phase, review: phase, adviser: phase, complete: phase } });
  const events: BusEvent[] = [];
  bus.on((e) => events.push(e));
  const logs: string[] = [];
  const orch = new Orchestrator({
    store,
    bus,
    drivers: [driver],
    browser: new QuietBrowser(),
    paths,
    tools: () => [],
    baseUrl: () => "http://127.0.0.1:1",
    watchers: null,
    log: (m) => logs.push(m),
    classifier: null,
    reconcileIntervalMs: 0,
    fetchPullRequestTitle: async () => null,
    now: clock,
    ...opts,
  });
  const dir = join(home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = orch.createProject({ path: dir, name: "Acme", key: "ACME", useWorktrees: false });
  const rig: OrchestratorRig<D> = {
    orch,
    store,
    bus,
    driver,
    clock,
    project,
    home,
    events,
    logs,
    async settle() {
      // Yielding to the event loop, not sleeping: a run can be waiting on a real subprocess (the
      // review decision reads the checkout's git HEAD), which has no bus event to wait on. The
      // limit only turns a hung run into a failure.
      const giveUp = performance.now() + 30_000;
      while (!orch.isIdle()) {
        if (performance.now() > giveUp) throw new Error("orchestrator never became idle");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    ticket: (key) => store.tickets.getByKey(key)!,
  };
  rigs.push(rig as unknown as OrchestratorRig);
  return rig;
}

const rigs: OrchestratorRig[] = [];

/** Stop every orchestrator the test made (aborting runs still going), close its database, and fail if a timer it started is still pending. Call from `afterEach`. */
export async function stopAll() {
  for (const rig of rigs.splice(0)) {
    await rig.orch.stop();
    rig.store.db.close();
  }
  assertNoTimerLeaks();
}

/** The kinds of the events seen so far, for asserting an order. */
export const kindsOf = (events: BusEvent[]) => events.map((e) => e.kind);

/**
 * Steps for one agent run that calls these tools in order, and the results it saw (text and error
 * flag). Pass the steps to `driver.script(...)` before the run starts.
 */
export function callTools(calls: [name: string, input: unknown][]): { steps: Step[]; results: { text: string; isError: boolean }[] } {
  const results: { text: string; isError: boolean }[] = [];
  const steps = calls.flatMap(([name, input]) =>
    toolCall(name, input, (r) => results.push({ text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError })),
  );
  return { steps, results };
}
