import { afterEach, expect, test } from "bun:test";
import { parsePairUrl, type PairingInfo } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

test("a service that listens only on localhost refuses to pair, and says how to fix it", async () => {
  const rig = await boot();
  const res = await rig.call("GET", "/pairing");
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/only listens on localhost/);
});

test("listening on every address pairs through the machine's LAN address, and the pair link carries that url and the token", async () => {
  const rig = await boot({ hostname: "any", localAddresses: () => ["127.0.0.1", "169.254.1.1", "192.168.7.20"] });
  const info = await rig.ok<PairingInfo>("GET", "/pairing");
  expect(info.url).toBe(`http://192.168.7.20:${rig.harness.port}`);
  expect(info.token).toBe(rig.harness.token);
  expect(parsePairUrl(info.pairUrl)).toEqual({ url: info.url, token: rig.harness.token });
});

test("listening on every address with no LAN address says so instead of handing out a dead url", async () => {
  const rig = await boot({ hostname: "any", localAddresses: () => ["127.0.0.1", "169.254.1.1"] });
  const res = await rig.call("GET", "/pairing");
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/No address off this machine/);
});

test("after the token rotates, pairing hands out the new token", async () => {
  const rig = await boot({ hostname: "any", localAddresses: () => ["10.1.2.3"] });
  const before = await rig.ok<PairingInfo>("GET", "/pairing");
  const { token } = await rig.ok<{ token: string }>("POST", "/token/rotate");
  const after = await rig.ok<PairingInfo>("GET", "/pairing");
  expect(after.token).toBe(token);
  expect(after.token).not.toBe(before.token);
  expect(parsePairUrl(after.pairUrl)?.token).toBe(token);
});
