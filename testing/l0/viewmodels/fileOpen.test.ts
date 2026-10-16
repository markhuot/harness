import { describe, expect, test } from "bun:test";
import type { FileLink } from "@harness/shared";
import { fileContentFor, fileRootFor } from "../../../app/src/renderer/state/fileOpen";

const link = (o: Partial<FileLink> = {}): FileLink => ({ path: "src/a.ts", absolute: false, ...o });

describe("fileRootFor", () => {
  test("the link's own ticket beats its project and the context", () => {
    expect(fileRootFor(link({ ticketKey: "A-1", projectId: "p" }), { ticketKey: "B-2", projectId: "q" })).toEqual({ ticketKey: "A-1" });
  });
  test("the link's own project beats the context", () => {
    expect(fileRootFor(link({ projectId: "p" }), { ticketKey: "B-2" })).toEqual({ projectId: "p" });
  });
  test("the context's ticket beats its project", () => {
    expect(fileRootFor(link(), { ticketKey: "B-2", projectId: "q" })).toEqual({ ticketKey: "B-2" });
    expect(fileRootFor(link(), { projectId: "q" })).toEqual({ projectId: "q" });
  });
  test("null/empty context values don't count; nothing names a root gives null", () => {
    expect(fileRootFor(link(), { ticketKey: null, projectId: "q" })).toEqual({ projectId: "q" });
    expect(fileRootFor(link(), { ticketKey: "", projectId: null })).toBeNull();
    expect(fileRootFor(link())).toBeNull();
  });
});

describe("fileContentFor", () => {
  const ctx = { ticketKey: "A-1" };
  test("no root, no pane", () => {
    expect(fileContentFor(link())).toBeNull();
  });
  test("a plain link opens the file with no lines", () => {
    expect(fileContentFor(link(), ctx)).toEqual({ kind: "file", root: { ticketKey: "A-1" }, path: "src/a.ts" });
  });
  test("a start line is kept; a range's end only when it's past the start", () => {
    expect(fileContentFor(link({ startLine: 5 }), ctx)).toMatchObject({ startLine: 5 });
    expect(fileContentFor(link({ startLine: 5 }), ctx)).not.toHaveProperty("endLine");
    expect(fileContentFor(link({ startLine: 5, endLine: 9 }), ctx)).toMatchObject({ startLine: 5, endLine: 9 });
    expect(fileContentFor(link({ startLine: 5, endLine: 5 }), ctx)).not.toHaveProperty("endLine");
    expect(fileContentFor(link({ startLine: 5, endLine: 2 }), ctx)).not.toHaveProperty("endLine");
  });
  test("an end line with no start line is dropped, as is line 0", () => {
    expect(fileContentFor(link({ endLine: 9 }), ctx)).toEqual({ kind: "file", root: { ticketKey: "A-1" }, path: "src/a.ts" });
    expect(fileContentFor(link({ startLine: 0, endLine: 3 }), ctx)).not.toHaveProperty("startLine");
  });
  test("the link's own project wins over the context's ticket", () => {
    expect(fileContentFor(link({ projectId: "p" }), ctx)?.root).toEqual({ projectId: "p" });
  });
});
