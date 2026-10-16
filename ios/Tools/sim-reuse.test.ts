import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashApp, deviceAppUrl, planDeviceInstall } from "./sim-reuse";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sim-reuse-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("hashApp follows content and layout, not timestamps", () => {
  const a = tmp();
  mkdirSync(join(a, "Frameworks"));
  writeFileSync(join(a, "Harness"), "binary");
  writeFileSync(join(a, "Frameworks", "x"), "x");
  const h = hashApp(a);
  writeFileSync(join(a, "Harness"), "binary"); // rewritten, same bytes
  expect(hashApp(a)).toBe(h);
  writeFileSync(join(a, "Harness"), "binarY");
  expect(hashApp(a)).not.toBe(h);
  writeFileSync(join(a, "Harness"), "binary");
  expect(hashApp(a)).toBe(h);
  writeFileSync(join(a, "Frameworks", "y"), "");
  expect(hashApp(a)).not.toBe(h); // an added (empty) file
  // The same bytes under another name is another app.
  const b = tmp();
  mkdirSync(join(b, "Frameworks"));
  writeFileSync(join(b, "Harness2"), "binary");
  writeFileSync(join(b, "Frameworks", "x"), "x");
  expect(hashApp(b)).not.toBe(h);
});

test("a device install is skipped only for the recorded build that is still on the device", () => {
  const base = { installed: { hash: "h1", url: "file:///A/Harness.app" }, builtHash: "h1", deviceUrl: "file:///A/Harness.app" };
  expect(planDeviceInstall(base)).toEqual({ install: false });
  expect(planDeviceInstall({ ...base, builtHash: "h2" }).install).toBe(true);
  expect(planDeviceInstall({ ...base, installed: null }).install).toBe(true);
  // Deleted from the phone since: the record alone doesn't count.
  expect(planDeviceInstall({ ...base, deviceUrl: null }).install).toBe(true);
  // Installed over by another worktree or Xcode: the device's location moved.
  expect(planDeviceInstall({ ...base, deviceUrl: "file:///B/Harness.app" }).install).toBe(true);
});

test("deviceAppUrl matches the bundle id exactly and tolerates bad output", () => {
  const json = JSON.stringify({ result: { apps: [
    { bundleIdentifier: "com.markhuot.harness.widgets", url: "file:///W/" },
    { bundleIdentifier: "com.markhuot.harness", url: "file:///A/Harness.app/" },
  ] } });
  expect(deviceAppUrl(json, "com.markhuot.harness")).toBe("file:///A/Harness.app/");
  expect(deviceAppUrl(json, "com.markhuot")).toBeNull();
  expect(deviceAppUrl("not json", "com.markhuot.harness")).toBeNull();
  expect(deviceAppUrl("{}", "com.markhuot.harness")).toBeNull();
});
