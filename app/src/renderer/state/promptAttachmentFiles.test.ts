import { describe, expect, test } from "bun:test";
import { attachmentSource, isFileDrag, limitMessage, planFiles } from "./promptAttachmentFiles";

type F = { name: string; type: string; path?: string };
const pathOf = (f: F) => f.path ?? null;

describe("planFiles", () => {
  const finder: F = { name: "notes.pdf", type: "application/pdf", path: "/Users/me/notes.pdf" };
  const shot: F = { name: "image.png", type: "image/png" };
  const browserImage: F = { name: "cat.jpg", type: "image/jpeg" };
  const blob: F = { name: "data.bin", type: "" };

  test("files on disk go in by path, any type, keeping their name", () => {
    const plan = planFiles([finder], pathOf, false);
    expect(plan.byPath.map((p) => p.input)).toEqual([{ path: "/Users/me/notes.pdf", name: "notes.pdf", source: "file" }]);
    expect(plan.uploads).toEqual([]);
  });

  test("pasted image data is uploaded as a pasted image; a named image from a browser keeps its name", () => {
    const plan = planFiles([shot, browserImage], pathOf, false);
    expect(plan.uploads.map((u) => [u.name, u.mimeType])).toEqual([
      ["Pasted image.png", "image/png"],
      ["cat.jpg", "image/jpeg"],
    ]);
  });

  test("a paste leaves pathless non-images alone (so it pastes as usual); a drop uploads them", () => {
    expect(planFiles([blob], pathOf, false)).toMatchObject({ byPath: [], uploads: [], ignored: 1 });
    expect(planFiles([blob], pathOf, true).uploads.map((u) => [u.name, u.mimeType])).toEqual([["data.bin", "application/octet-stream"]]);
  });
});

describe("attachmentSource", () => {
  const urlAt = (i: number) => `svc/${i}`;
  test("the fresh preview wins over the service", () => {
    expect(attachmentSource({ path: "/a" }, "blob:1", [{ path: "/a" }], urlAt)).toEqual({ url: "blob:1", local: true });
  });
  test("the service's URL is by the index in its own list, not the editor's", () => {
    expect(attachmentSource({ path: "/b" }, undefined, [{ path: "/a" }, { path: "/b" }], urlAt)).toEqual({ url: "svc/1", local: false });
  });
  test("nothing to show before the service has it, or before the draft is saved", () => {
    expect(attachmentSource({ path: "/c" }, undefined, [{ path: "/a" }], urlAt)).toBeNull();
    expect(attachmentSource({ path: "/a" }, undefined, [{ path: "/a" }], null)).toBeNull();
    expect(attachmentSource({ path: "/a" }, undefined, null, urlAt)).toBeNull();
  });
});

describe("messages and drags", () => {
  test("the limit toast only when something was left out, singular and plural", () => {
    expect(limitMessage(0, 20)).toBeNull();
    expect(limitMessage(1, 20)).toBe("1 file wasn't attached: a session takes at most 20.");
    expect(limitMessage(3, 20)).toBe("3 files weren't attached: a session takes at most 20.");
  });
  test("only drags carrying files count, not our pane drags or text", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["application/x-harness-ticket"])).toBe(false);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});
