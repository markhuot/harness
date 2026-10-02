import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient, type HarnessEvent } from "@harness/shared";
import { createHarness, type Harness } from "./app";
import { CodeWatch, executableFingerprint, REPO_ROOT, sourceFingerprint } from "./code-watch";
import { FakeDriver, stubBrowser, tempHome } from "./testing/fakes";

describe("executableFingerprint", () => {
  test("changes when the executable is replaced, and holds while it's missing", () => {
    const dir = tempHome("harness-exe-");
    const exe = join(dir, "harness-service");
    writeFileSync(exe, "build one");
    const fp = executableFingerprint(exe);
    const first = fp();
    expect(fp()).toBe(first);
    rmSync(exe); // a new Harness.app on its way in
    expect(fp()).toBe(first);
    writeFileSync(exe, "build two, longer");
    expect(fp()).not.toBe(first);
  });
});

function tree() {
  const root = tempHome("harness-src-");
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", "{}");
  write("service/src/app.ts", "export const a = 1;");
  write("shared/src/protocol.ts", "export type A = 1;");
  write("plugins/git/server.ts", "export {};");
  return { root, write };
}

describe("sourceFingerprint", () => {
  test("changes with the service, shared, plugin and dependency files it loads", () => {
    const { root, write } = tree();
    const seen = new Set([sourceFingerprint(root)]);
    for (const [path, text] of [
      ["service/src/app.ts", "export const a = 2;"],
      ["shared/src/protocol.ts", "export type A = 2;"],
      ["plugins/git/server.ts", "export const x = 1;"],
      ["bun.lock", "lock"],
      ["service/src/api/new-route.ts", "export {};"],
    ]) {
      write(path!, text!);
      const fp = sourceFingerprint(root);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    }
    rmSync(join(root, "service/src/api/new-route.ts"));
    expect(seen.has(sourceFingerprint(root))).toBe(true);
  });

  test("tests, build output, node_modules, dotfiles and the rest of the repo don't count", () => {
    const { root, write } = tree();
    const before = sourceFingerprint(root);
    write("service/src/app.test.ts", "test");
    write("plugins/git/dist/main.js", "bundle");
    write("plugins/git/node_modules/x/index.js", "dep");
    write("service/src/.DS_Store", "junk");
    write("app/src/renderer/App.tsx", "ui");
    write("CHANGELOG.md", "notes");
    write("service/src/notes.md", "docs");
    expect(sourceFingerprint(root)).toBe(before);
  });

  test("a renamed file is a change even with the same content", () => {
    const { root, write } = tree();
    const before = sourceFingerprint(root);
    rmSync(join(root, "service/src/app.ts"));
    write("service/src/main.ts", "export const a = 1;");
    expect(sourceFingerprint(root)).not.toBe(before);
  });

  test("hashes this repo's real service source", () => {
    expect(sourceFingerprint(REPO_ROOT)).toMatch(/^[0-9a-f]{16}$/);
    expect(sourceFingerprint(REPO_ROOT)).toBe(sourceFingerprint(REPO_ROOT));
  });
});

function watch(opts: { idle?: boolean; restart?: boolean } = {}) {
  let fp = "v1";
  let idle = opts.idle ?? true;
  const changes: boolean[] = [];
  let restarts = 0;
  const w = new CodeWatch({
    fingerprint: () => fp,
    isIdle: () => idle,
    onChange: (s) => changes.push(s.stale),
    restart: opts.restart === false ? undefined : () => restarts++,
  });
  return {
    w,
    changes,
    set: (v: string) => (fp = v),
    setIdle: (v: boolean) => (idle = v),
    get restarts() {
      return restarts;
    },
  };
}

describe("CodeWatch", () => {
  test("unchanged code: fresh, no event, no restart", () => {
    const t = watch();
    t.w.check();
    t.w.check();
    expect(t.w.status()).toEqual({ build: "v1", stale: false });
    expect(t.changes).toEqual([]);
    expect(t.restarts).toBe(0);
  });

  test("new code goes stale at once but restarts only after it has settled for a check", () => {
    const t = watch();
    t.set("v2");
    t.w.check();
    expect(t.w.status()).toEqual({ build: "v1", stale: true });
    expect(t.changes).toEqual([true]);
    expect(t.restarts).toBe(0);
    // Still being written (a checkout in progress): wait again.
    t.set("v3");
    t.w.check();
    expect(t.restarts).toBe(0);
    t.w.check();
    expect(t.restarts).toBe(1);
    // One restart: it's on its way out.
    t.w.check();
    expect(t.restarts).toBe(1);
    expect(t.changes).toEqual([true]);
  });

  test("busy: stays stale without restarting, then restarts on the first idle check", () => {
    const t = watch({ idle: false });
    t.set("v2");
    t.w.check();
    t.w.check();
    t.w.check();
    expect(t.restarts).toBe(0);
    expect(t.w.stale).toBe(true);
    t.setIdle(true);
    t.w.check();
    expect(t.restarts).toBe(1);
  });

  test("code changed back to what's loaded: fresh again, and no restart", () => {
    const t = watch({ idle: false });
    t.set("v2");
    t.w.check();
    t.set("v1");
    t.setIdle(true);
    t.w.check();
    t.w.check();
    expect(t.w.stale).toBe(false);
    expect(t.changes).toEqual([true, false]);
    expect(t.restarts).toBe(0);
  });

  test("without a supervisor it only reports stale", () => {
    const t = watch({ restart: false });
    t.set("v2");
    t.w.check();
    t.w.check();
    expect(t.w.stale).toBe(true);
    expect(t.restarts).toBe(0);
  });
});

describe("service self-update over the API", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  async function boot(opts: { restart?: boolean } = {}) {
    const home = tempHome("harness-codewatch-");
    const fake = new FakeDriver("fake");
    let fp = "boot";
    let restarts = 0;
    harness = await createHarness({
      home,
      port: 0,
      drivers: [fake],
      browser: stubBrowser(),
      watchers: null,
      log: () => {},
      // A long interval: the test drives check() itself.
      codeWatch: { fingerprint: () => fp, intervalMs: 60_000 },
      restart: opts.restart === false ? undefined : () => restarts++,
    });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    const dir = join(home, "work", "proj");
    mkdirSync(dir, { recursive: true });
    return { h: harness, client, fake, dir, setFingerprint: (v: string) => (fp = v), restarts: () => restarts };
  }

  test("/health reports the build; a change goes stale over the socket; an agent run holds the restart", async () => {
    const { h, client, fake, dir, setFingerprint, restarts } = await boot();
    expect(await client.health()).toMatchObject({ build: "boot", stale: false });

    const events: HarnessEvent[] = [];
    let up!: () => void;
    const ready = new Promise<void>((r) => (up = r));
    const socket = client.connect({ onEvent: (e) => events.push(e), onStatus: (c) => c && up() });
    await ready;

    const p = await client.createProject({ path: dir, useWorktrees: false });
    await client.createTicket({ projectId: p.id, spec: "work /hold", driver: "fake", start: true });
    const deadline = Date.now() + 5000;
    while (fake.holding === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(h.orchestrator.isIdle()).toBe(false);

    setFingerprint("merged");
    h.codeWatch!.check();
    h.codeWatch!.check();
    expect(await client.health()).toMatchObject({ build: "boot", stale: true });
    expect(restarts()).toBe(0);
    const until = Date.now() + 2000;
    while (!events.some((e) => e.kind === "service.status") && Date.now() < until) await Bun.sleep(5);
    expect(events.filter((e) => e.kind === "service.status")).toEqual([{ kind: "service.status", status: { build: "boot", stale: true } }]);

    fake.release();
    await h.orchestrator.idle();
    expect(h.orchestrator.isIdle()).toBe(true);
    h.codeWatch!.check();
    expect(restarts()).toBe(1);
    socket.close();
  });

  test("POST /service/restart restarts on request; without a supervisor it's a 409", async () => {
    const { client, restarts } = await boot();
    expect(await client.restartService()).toEqual({ ok: true });
    await Bun.sleep(100);
    expect(restarts()).toBe(1);
    await harness!.stop();

    const bare = await boot({ restart: false });
    await expect(bare.client.restartService()).rejects.toMatchObject({ status: 409 });
    await Bun.sleep(100);
    expect(bare.restarts()).toBe(0);
  });

  test("a service that doesn't track its source reports build null, never stale", async () => {
    const home = tempHome("harness-codewatch-");
    harness = await createHarness({ home, port: 0, drivers: [new FakeDriver()], browser: stubBrowser(), watchers: null, log: () => {} });
    const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
    expect(await client.health()).toMatchObject({ build: null, stale: false });
    expect(harness.codeWatch).toBeNull();
  });
});
