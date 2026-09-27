import { expect, test } from "bun:test";
import { removeServer, renameServer, upsertServer } from "./servers";

let n = 0;
const id = () => `s${++n}`;

test("pairing the same Mac again reuses its entry; a new URL adds one", () => {
  const a = upsertServer([], "http://100.64.0.2:7717", 1, id);
  expect(a.added).toBe(true);
  expect(a.server).toMatchObject({ name: "100.64.0.2:7717", baseUrl: "http://100.64.0.2:7717" });
  const again = upsertServer(a.list, "http://100.64.0.2:7717", 2, id);
  expect(again.added).toBe(false);
  expect(again.list).toHaveLength(1);
  expect(again.server.id).toBe(a.server.id);
  const b = upsertServer(again.list, "http://mac.local:7717", 3, id);
  expect(b.list.map((s) => s.baseUrl)).toEqual(["http://100.64.0.2:7717", "http://mac.local:7717"]);
});

test("removing the active server falls back to the next one (or none)", () => {
  const list = [
    { id: "a", name: "a", baseUrl: "http://a", addedAt: 1 },
    { id: "b", name: "b", baseUrl: "http://b", addedAt: 2 },
  ];
  expect(removeServer(list, "a", "a")).toEqual({ list: [list[1]!], active: "b" });
  expect(removeServer(list, "a", "b").active).toBe("b");
  expect(removeServer([list[0]!], "a", "a")).toEqual({ list: [], active: null });
});

test("renaming to blank restores the host name", () => {
  const list = [{ id: "a", name: "Studio Mac", baseUrl: "http://10.0.0.2:7717", addedAt: 1 }];
  expect(renameServer(list, "a", "  ")[0]!.name).toBe("10.0.0.2:7717");
  expect(renameServer(list, "a", " Laptop ")[0]!.name).toBe("Laptop");
});
