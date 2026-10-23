import { expect, test } from "bun:test";
import { addProject, addTicket, makeStore } from "../../builders/store";

function setup() {
  const store = makeStore();
  const project = addProject(store);
  return { store, a: addTicket(store, project), b: addTicket(store, project), c: addTicket(store, project) };
}

test("subscribing again to the same ticket replaces the mode and events instead of adding a row", () => {
  const { store, a, b } = setup();
  store.subscriptions.upsert(a.id, b.id, "once", ["status"]);
  const second = store.subscriptions.upsert(a.id, b.id, "forever", ["note", "spec"]);
  expect(second).toMatchObject({ mode: "forever", events: ["note", "spec"] });
  expect(store.subscriptions.listBySubscriber(a.id)).toHaveLength(1);
});

test("listByTarget finds every subscriber of a ticket, and delete reports whether a row was there", () => {
  const { store, a, b, c } = setup();
  store.subscriptions.upsert(a.id, c.id, "once", ["status"]);
  store.subscriptions.upsert(b.id, c.id, "forever", ["status"]);
  expect(store.subscriptions.listByTarget(c.id).map((s) => s.subscriberId)).toEqual([a.id, b.id]);
  expect(store.subscriptions.delete(a.id, c.id)).toBe(true);
  expect(store.subscriptions.delete(a.id, c.id)).toBe(false);
  store.subscriptions.deleteBySubscriber(b.id);
  expect(store.subscriptions.listByTarget(c.id)).toEqual([]);
});

test("deleting a ticket removes the subscriptions it holds and the ones to it", () => {
  const { store, a, b, c } = setup();
  store.subscriptions.upsert(a.id, b.id, "forever", ["status"]);
  store.subscriptions.upsert(c.id, a.id, "forever", ["status"]);
  store.db.query("DELETE FROM tickets WHERE id = $id").run({ id: a.id });
  expect(store.subscriptions.listByTarget(b.id)).toEqual([]);
  expect(store.subscriptions.listBySubscriber(c.id)).toEqual([]);
});
