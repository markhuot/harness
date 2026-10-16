import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeWatch, executableFingerprint, sourceFingerprint } from "../../service/src/code-watch";
import { tempDir } from "../builders/tmp";
import { writeFile } from "./files";

function checkout() {
  const root = tempDir();
  writeFile(root, "service/src/a.ts", "export const a = 1;");
  writeFile(root, "shared/src/b.ts", "export const b = 1;");
  writeFile(root, "plugins/p/plugin.json", "{}");
  writeFile(root, "package.json", "{}");
  return root;
}

test("the fingerprint changes when code the service runs changes, and not for tests, build output or dotfiles", () => {
  const root = checkout();
  const before = sourceFingerprint(root);
  expect(sourceFingerprint(root)).toBe(before);
  for (const [path, text] of [["service/src/a.test.ts", "x"], ["service/src/dist/out.js", "x"], ["service/src/node_modules/m.js", "x"], ["service/src/.hidden.ts", "x"], ["service/src/notes.md", "x"], ["docs/readme.ts", "x"]] as const) {
    writeFile(root, path, text);
  }
  expect(sourceFingerprint(root)).toBe(before);
  writeFile(root, "service/src/a.ts", "export const a = 2;");
  const edited = sourceFingerprint(root);
  expect(edited).not.toBe(before);
  writeFile(root, "plugins/p/ui.css", "body{}");
  expect(sourceFingerprint(root)).not.toBe(edited);
  writeFile(root, "package.json", '{"v":2}');
  expect(sourceFingerprint(root)).not.toBe(edited);
});

test("a renamed file changes the fingerprint even when its contents don't", () => {
  const root = checkout();
  const before = sourceFingerprint(root);
  writeFile(root, "service/src/c.ts", "export const a = 1;");
  expect(sourceFingerprint(root)).not.toBe(before);
});

test("the compiled service's fingerprint follows its executable and keeps the last value while the file is missing", () => {
  const dir = tempDir();
  const exe = join(dir, "harness-service");
  const fingerprint = executableFingerprint(exe);
  expect(fingerprint()).toBe("missing");
  writeFileSync(exe, "v1");
  const v1 = fingerprint();
  expect(v1).not.toBe("missing");
  expect(fingerprint()).toBe(v1);
  writeFileSync(exe, "version two");
  const v2 = fingerprint();
  expect(v2).not.toBe(v1);
  mkdirSync(join(dir, "gone"));
  expect(executableFingerprint(join(dir, "gone", "nope"))()).toBe("missing");
});

function watch(opts: { idle?: boolean; restart?: boolean } = {}) {
  let fp = "build-1";
  const changes: boolean[] = [];
  const logs: string[] = [];
  let restarts = 0;
  const w = new CodeWatch({
    fingerprint: () => fp,
    isIdle: () => opts.idle ?? true,
    onChange: (s) => changes.push(s.stale),
    ...(opts.restart === false ? {} : { restart: () => restarts++ }),
    log: (m) => logs.push(m),
  });
  return { w, set: (v: string) => (fp = v), changes, logs, restarts: () => restarts };
}

test("a source change marks the service stale once, and changing back marks it fresh again", () => {
  const r = watch({ restart: false });
  expect(r.w.status()).toEqual({ build: "build-1", stale: false });
  r.w.check();
  expect(r.changes).toEqual([]);
  r.set("build-2");
  r.w.check();
  r.w.check();
  expect(r.changes).toEqual([true]);
  expect(r.w.stale).toBe(true);
  r.set("build-1");
  r.w.check();
  expect(r.changes).toEqual([true, false]);
  expect(r.logs[0]).toContain("build-1 → build-2");
});

test("it restarts only once the new code has settled for two checks in a row and no runs are active", () => {
  const r = watch();
  r.set("build-2");
  r.w.check();
  expect(r.restarts()).toBe(0); // first sight: files may still be changing
  r.set("build-3");
  r.w.check();
  expect(r.restarts()).toBe(0); // changed again
  r.w.check();
  expect(r.restarts()).toBe(1);
  r.w.check();
  expect(r.restarts()).toBe(1); // once
});

test("a busy service isn't restarted, and one that can't be restarted only reports", () => {
  const busy = watch({ idle: false });
  busy.set("build-2");
  busy.w.check();
  busy.w.check();
  expect(busy.restarts()).toBe(0);
  expect(busy.w.stale).toBe(true);
  const unsupervised = watch({ restart: false });
  unsupervised.set("build-2");
  unsupervised.w.check();
  unsupervised.w.check();
  expect(unsupervised.logs.some((l) => l.includes("restarting"))).toBe(false);
});
