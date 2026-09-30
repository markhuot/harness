import { describe, expect, test } from "bun:test";
import { parseFileLink } from "@harness/shared";
import { fileContentFor, fileRootFor } from "./fileOpen";

const link = (url: string) => parseFileLink(url)!;

describe("fileRootFor", () => {
  test("the link's own ticket or project wins over where it was clicked", () => {
    expect(fileRootFor(link("harness://file/a.ts?ticket=B-2"), { ticketKey: "A-1" })).toEqual({ ticketKey: "B-2" });
    expect(fileRootFor(link("harness://file/a.ts?project=p2"), { ticketKey: "A-1", projectId: "p1" })).toEqual({ projectId: "p2" });
  });

  test("otherwise the clicked-in ticket, then its project", () => {
    expect(fileRootFor(link("src/a.ts"), { ticketKey: "A-1", projectId: "p1" })).toEqual({ ticketKey: "A-1" });
    expect(fileRootFor(link("src/a.ts"), { ticketKey: null, projectId: "p1" })).toEqual({ projectId: "p1" });
  });

  test("with no context at all there's nowhere to resolve it", () => {
    expect(fileRootFor(link("src/a.ts"))).toBeNull();
  });
});

describe("fileContentFor", () => {
  test("carries the path and line range into the pane", () => {
    expect(fileContentFor(link("harness://file/src/app.ts#L10-L20"), { ticketKey: "A-1" })).toEqual({
      kind: "file",
      root: { ticketKey: "A-1" },
      path: "src/app.ts",
      startLine: 10,
      endLine: 20,
    });
  });

  test("an absolute path passes through for the service to make relative", () => {
    expect(fileContentFor(link("/Users/me/repo/a.ts#L3"), { projectId: "p" })).toEqual({ kind: "file", root: { projectId: "p" }, path: "/Users/me/repo/a.ts", startLine: 3 });
  });

  test("null without a root", () => {
    expect(fileContentFor(link("a.ts"))).toBeNull();
  });
});
