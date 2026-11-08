import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pageFile, preparePage, readManifest, removePages, SIZING_SCRIPT, storePage, withSizingScript } from "../../service/src/pages";
import { tempDir } from "../builders/tmp";
import { writeFile } from "./files";

/** A checkout holding a report folder (index, script, nested data, a dotfile, a symlink out) and a lone HTML file. */
function checkout() {
  const cwd = tempDir("pages-");
  writeFile(cwd, "report/index.html", "<html><head><title>r</title></head><body>hi</body></html>");
  writeFile(cwd, "report/app.js", "console.log(1)");
  writeFile(cwd, "report/data/points.json", "[1,2]");
  writeFile(cwd, "report/.env", "SECRET=1");
  writeFile(cwd, "report/.git/config", "x");
  const outside = tempDir("outside-");
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(join(outside, "secret.txt"), join(cwd, "report/linked.txt"));
  writeFile(cwd, "profile.html", "<p>flame</p>");
  mkdirSync(join(cwd, "plain"));
  writeFile(cwd, "plain/notes.md", "n");
  return { cwd, outside };
}

test("a folder with index.html is a page of its files, without dotfiles or symlinks", () => {
  const { cwd } = checkout();
  const page = preparePage("report", cwd)!;
  expect(page.manifest).toEqual({
    entry: "index.html",
    files: { "app.js": "text/javascript", "data/points.json": "application/json", "index.html": "text/html" },
  });
  expect(page.name).toBe("report");
});

test("a lone .html file is a page whose entry is that file", () => {
  const { cwd } = checkout();
  expect(preparePage("profile.html", cwd)!.manifest).toEqual({ entry: "profile.html", files: { "profile.html": "text/html" } });
});

test("links that aren't local pages are left alone: other schemes, file-viewer links, anchors, other files, folders without index.html", () => {
  const { cwd } = checkout();
  for (const target of ["https://x.dev/a.html", "harness://file/profile.html", "attachment:ab", "profile.html#top", "plain/notes.md", "plain", "mailto:a@b.c"]) {
    expect([target, preparePage(target, cwd)]).toEqual([target, null]);
  }
});

test("a missing .html file, a folder written with a slash but no index.html, and a page outside the checkout are errors", () => {
  const { cwd, outside } = checkout();
  expect(() => preparePage("nope.html", cwd)).toThrow("Page not found: nope.html");
  expect(() => preparePage("plain/", cwd)).toThrow("has no index.html");
  writeFileSync(join(outside, "x.html"), "<p>");
  expect(() => preparePage(join(outside, "x.html"), cwd)).toThrow("outside this ticket's checkout");
  expect(() => preparePage(`../${outside.split("/").pop()}/x.html`, cwd)).toThrow("outside this ticket's checkout");
  // A symlink inside the checkout that points out of it is outside too.
  symlinkSync(join(outside, "x.html"), join(cwd, "escape.html"));
  expect(() => preparePage("escape.html", cwd)).toThrow("outside this ticket's checkout");
});

test("storePage copies the listed files beside a manifest; pageFile serves only what it lists", () => {
  const { cwd } = checkout();
  const dir = tempDir("attachments-");
  const a = storePage(dir, preparePage("report", cwd)!);
  expect(a).toMatchObject({ kind: "page", source: "spec", mimeType: "text/html", path: join(dir, a.id) });
  const manifest = readManifest(a.path)!;
  expect(pageFile(a.path, manifest, "")!.path).toBe(join(a.path, "site/index.html"));
  expect(readFileSync(pageFile(a.path, manifest, "data/points.json")!.path, "utf8")).toBe("[1,2]");
  for (const rel of [".env", "linked.txt", "../manifest.json", "data/../index.html", "nope.js"]) expect([rel, pageFile(a.path, manifest, rel)]).toEqual([rel, null]);
  expect(existsSync(join(a.path, "site/.env"))).toBe(false);
  removePages([a.path]);
  expect(existsSync(a.path)).toBe(false);
});

test("the sizing script goes in before the page's own scripts: after <head>, else <html>, else first", () => {
  expect(withSizingScript('<!doctype html><html lang="en"><head><script>x</script></head>')).toBe(`<!doctype html><html lang="en"><head>${SIZING_SCRIPT}<script>x</script></head>`);
  expect(withSizingScript("<html><body><script>x</script>")).toBe(`<html>${SIZING_SCRIPT}<body><script>x</script>`);
  expect(withSizingScript("<p>bare</p>")).toBe(`${SIZING_SCRIPT}<p>bare</p>`);
  expect(withSizingScript("<header>not head</header>")).toBe(`${SIZING_SCRIPT}<header>not head</header>`);
});
