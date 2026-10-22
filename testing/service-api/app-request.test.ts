import { afterEach, expect, test } from "bun:test";
import type { AppReply, AppRequest } from "@harness/shared";
import { MacRequestError } from "../../service/src/api/mac-requests";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

const request: AppRequest = { kind: "panes.arrange", op: { op: "get_layout" }, allowed: { tickets: [], terminals: [] } };
const reply: AppReply = { ok: true, result: { outcome: "unchanged", message: "The current layout.", scope: "all", layout: { panes: [], others: 0, zoomed: false } } };
const presence = (deviceId: string, platform: string, visible: boolean) => ({ type: "presence", deviceId, platform, visible, tickets: [] });

test("a request goes to the visible Mac only and its reply resolves it", async () => {
  const rig = await boot();
  const hidden = await rig.socket();
  const visible = await rig.socket();
  const phone = await rig.socket();
  hidden.send(presence("mac-a", "mac", false));
  visible.send(presence("mac-b", "mac", true));
  phone.send(presence("phone", "ios", true));
  // presence is processed in order per socket; a ping/pong on each makes sure it landed
  for (const ws of [hidden, visible, phone]) {
    ws.send({ type: "ping" });
    await ws.next((m) => m.type === "pong");
  }

  const pending = rig.harness.macRequests.request(request);
  const asked = await visible.next((m) => m.type === "app.request");
  expect(asked).toMatchObject({ type: "app.request", request });
  const id = (asked as { id: string }).id;
  // Another socket answering the request isn't believed.
  hidden.send({ type: "app.reply", id, reply: { ok: false, error: "forged" } });
  hidden.send({ type: "ping" });
  await hidden.next((m) => m.type === "pong");
  visible.send({ type: "app.reply", id, reply });
  expect(await pending).toEqual(reply);
  expect(hidden.messages.some((m) => m.type === "app.request")).toBe(false);
  expect(phone.messages.some((m) => m.type === "app.request")).toBe(false);
});

test("with no Mac connected it fails at once, and a Mac that closes before answering fails the request as disconnected", async () => {
  const rig = await boot();
  const phone = await rig.socket();
  phone.send(presence("phone", "ios", true));
  phone.send({ type: "ping" });
  await phone.next((m) => m.type === "pong");
  await expect(rig.harness.macRequests.request(request)).rejects.toMatchObject({ reason: "no_mac" });

  const mac = await rig.socket();
  mac.send(presence("mac", "mac", true));
  mac.send({ type: "ping" });
  await mac.next((m) => m.type === "pong");
  const pending = rig.harness.macRequests.request(request);
  await mac.next((m) => m.type === "app.request");
  mac.close();
  const err = await pending.catch((e) => e);
  expect(err).toBeInstanceOf(MacRequestError);
  expect(err.reason).toBe("disconnected");
});

test("a Mac that never answers times out", async () => {
  const rig = await boot();
  const mac = await rig.socket();
  mac.send(presence("mac", "mac", true));
  mac.send({ type: "ping" });
  await mac.next((m) => m.type === "pong");
  await expect(rig.harness.macRequests.request(request, 30)).rejects.toMatchObject({ reason: "timeout" });
});
