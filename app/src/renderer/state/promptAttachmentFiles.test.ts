import { describe, expect, test } from "bun:test";
import { attachmentSource, isFileDrag, isLocalService, limitMessage, planFiles } from "./promptAttachmentFiles";

type F = { name: string; type: string; path?: string };
const pathOf = (f: F) => f.path ?? null;
const paste = { uploadAny: false, local: true };
const drop = { uploadAny: true, local: true };

describe("planFiles", () => {
  const finder: F = { name: "notes.pdf", type: "application/pdf", path: "/Users/me/notes.pdf" };
  const shot: F = { name: "image.png", type: "image/png" };
  const browserImage: F = { name: "cat.jpg", type: "image/jpeg" };
  const blob: F = { name: "data.bin", type: "" };

  test("files on disk go in by path, any type, keeping their name", () => {
    const plan = planFiles([finder], pathOf, paste);
    expect(plan.byPath.map((p) => p.input)).toEqual([{ path: "/Users/me/notes.pdf", name: "notes.pdf", source: "file" }]);
    expect(plan.uploads).toEqual([]);
  });

  test("pasted image data is uploaded as a pasted image; a named image from a browser keeps its name", () => {
    const plan = planFiles([shot, browserImage], pathOf, paste);
    expect(plan.uploads.map((u) => [u.name, u.mimeType])).toEqual([
      ["Pasted image.png", "image/png"],
      ["cat.jpg", "image/jpeg"],
    ]);
  });

  test("a paste leaves pathless non-images alone (so it pastes as usual); a drop uploads them", () => {
    expect(planFiles([blob], pathOf, paste)).toMatchObject({ byPath: [], uploads: [], ignored: 1 });
    expect(planFiles([blob], pathOf, drop).uploads.map((u) => [u.name, u.mimeType])).toEqual([["data.bin", "application/octet-stream"]]);
  });
});

describe("planFiles with a service on another machine", () => {
  test("files on disk are uploaded under their real name instead of passing a path that doesn't exist there", () => {
    const files: F[] = [
      { name: "notes.pdf", type: "application/pdf", path: "/Users/me/notes.pdf" },
      { name: "image.png", type: "image/png", path: "/Users/me/image.png" },
      { name: "", type: "", path: "/Users/me/Makefile" },
    ];
    const plan = planFiles(files, pathOf, { uploadAny: true, local: false });
    expect(plan.byPath).toEqual([]);
    expect(plan.uploads.map((u) => [u.name, u.mimeType])).toEqual([
      ["notes.pdf", "application/pdf"],
      ["image.png", "image/png"],
      ["Makefile", "application/octet-stream"],
    ]);
  });

  test("a Finder copy pasted for a remote service is uploaded too, not left to paste as text", () => {
    const plan = planFiles([{ name: "spec.txt", type: "text/plain", path: "/Users/me/spec.txt" }], pathOf, { uploadAny: false, local: false });
    expect(plan.uploads.map((u) => u.name)).toEqual(["spec.txt"]);
    expect(plan.ignored).toBe(0);
  });
});

describe("isLocalService", () => {
  test("loopback hosts are this Mac", () => {
    for (const url of ["http://127.0.0.1:7717", "http://localhost:7717/", "http://[::1]:7717", "http://127.1.2.3:80"]) expect(isLocalService(url)).toBe(true);
  });
  test("anything else is another machine", () => {
    for (const url of ["http://100.64.1.2:7717", "http://mac-mini.tail1234.ts.net:7717", "http://localhost.example.com", "http://127.0.0.1.evil.com", "not a url"]) expect(isLocalService(url)).toBe(false);
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
