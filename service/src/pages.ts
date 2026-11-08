// Page attachments (DESIGN.md "Embedded pages"): an HTML file, or a folder with an index.html and
// its assets, that a spec links on its own line (`[Flame graph](reports/profile.html)`) and the apps
// embed as a sandboxed web view. At update_spec / edit_spec the link's target is copied into
// $HARNESS_HOME/attachments/<id>/ (the worktree goes away after the merge, and iOS can't reach it)
// with a manifest of its files, and the link becomes attachment:<id>. GET /embeds/:id/* serves the
// files the manifest lists, and adds the sizing script to every HTML page it serves.

import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Attachment } from "@harness/shared";
import { inside } from "./safe-path";
import { newId } from "./store/util";

export const PAGE_MIME = "text/html";

/** What a stored page holds: the file the embed opens, and every file with its content type. */
export interface PageManifest {
  entry: string;
  files: Record<string, string>;
}

/** A page validated and listed, ready to copy in. */
export interface PreparedPage {
  id: string;
  name: string;
  /** The folder its files are copied from */
  root: string;
  manifest: PageManifest;
  size: number;
}

const MANIFEST = "manifest.json";
const SITE = "site";

/** A link target that is a local path: no scheme (http:, attachment:, harness:…), no query or anchor. */
function localTarget(target: string): boolean {
  return !!target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//") && !/[?#]/.test(target);
}

const HTML_NAME = /\.html?$/i;

/** A file's content type by its name ("application/octet-stream" when unknown). */
function contentType(name: string): string {
  const t = Bun.file(name).type.split(";")[0]!.trim();
  return t || "application/octet-stream";
}

/**
 * The files of a folder bundle, by path relative to `root` with `/` separators. Dotfiles and
 * dot-folders (`.git`, `.env`) and symlinks are skipped, so a bundle can't pull in secrets or files
 * from outside itself.
 */
function listBundle(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out[relative(root, abs).split(sep).join("/")] = contentType(name);
    }
  };
  walk(root);
  return out;
}

/**
 * The page a link target names, or null when it isn't one: a local `.html` file, or a folder holding
 * an `index.html`. A folder written with a trailing slash must hold one. Throws (naming the target)
 * for a page that's missing or outside `cwd`, the agent's checkout.
 */
export function preparePage(target: string, cwd: string): PreparedPage | null {
  if (!localTarget(target)) return null;
  const path = isAbsolute(target) ? target : resolve(cwd, target);
  const html = HTML_NAME.test(target);
  const slash = target.endsWith("/");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    if (html || slash) throw new Error(`Page not found: ${target} (looked at ${path})`);
    return null;
  }
  const st = statSync(real);
  if (st.isDirectory() && !html) {
    const hasIndex = (() => {
      try {
        return lstatSync(join(real, "index.html")).isFile();
      } catch {
        return false;
      }
    })();
    if (!hasIndex) {
      if (slash) throw new Error(`${target} has no index.html: a folder embeds as a page only when it has one`);
      return null; // an ordinary link to a folder
    }
  } else if (!st.isFile() || !html) {
    return null;
  }
  if (!inside(real, realpathSync(cwd))) throw new Error(`${target} is outside this ticket's checkout (${cwd}); only pages inside it can be embedded`);
  if (st.isFile()) {
    const name = basename(real);
    return { id: newId(), name, root: resolve(real, ".."), manifest: { entry: name, files: { [name]: contentType(name) } }, size: st.size };
  }
  const files = listBundle(real);
  const size = Object.keys(files).reduce((sum, f) => sum + statSync(join(real, f)).size, 0);
  return { id: newId(), name: basename(real), root: real, manifest: { entry: "index.html", files }, size };
}

/** Copy a prepared page into `<dir>/<id>/` (its files under site/, beside manifest.json). */
export function storePage(dir: string, p: PreparedPage): Attachment {
  const home = join(dir, p.id);
  try {
    for (const rel of Object.keys(p.manifest.files)) {
      const dest = join(home, SITE, ...rel.split("/"));
      mkdirSync(resolve(dest, ".."), { recursive: true });
      copyFileSync(join(p.root, ...rel.split("/")), dest);
    }
    writeFileSync(join(home, MANIFEST), JSON.stringify(p.manifest));
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  return { id: p.id, path: home, name: p.name, source: "spec", kind: "page", mimeType: PAGE_MIME, size: p.size };
}

/** Best-effort removal of stored pages' folders; only folders directly inside `dir`, the attachments folder, are touched. */
export function removePages(dir: string, paths: string[]) {
  for (const p of paths) if (resolve(p, "..") === resolve(dir)) rmSync(p, { recursive: true, force: true });
}

/** A stored page's manifest, or null when it's missing or unreadable. */
export function readManifest(home: string): PageManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(home, MANIFEST), "utf8")) as PageManifest;
    return typeof m?.entry === "string" && m.files && typeof m.files === "object" ? m : null;
  } catch {
    return null;
  }
}

/**
 * The stored file a request path names, and its content type: "" (or "/") is the entry; anything
 * else must be listed in the manifest exactly. Null when it isn't.
 */
export function pageFile(home: string, manifest: PageManifest, rel: string): { path: string; type: string } | null {
  const name = rel.replace(/^\/+/, "") || manifest.entry;
  const type = Object.hasOwn(manifest.files, name) ? manifest.files[name] : undefined;
  if (!type) return null;
  return { path: join(home, SITE, ...name.split("/")), type };
}

/**
 * Posts the page's height to the app whenever it changes, at most once a frame: to the iOS app's
 * `harnessEmbed` message handler, or to the parent frame on the Mac. The height is the document's
 * content, not the frame's (`html`'s box, or the body's bottom edge when it's taller).
 */
export const SIZING_SCRIPT = `<script>(function(){var last=-1,q=0;function h(){var d=document.documentElement,b=document.body,n=d.getBoundingClientRect().height;if(b){var r=b.getBoundingClientRect(),m=parseFloat(getComputedStyle(b).marginBottom)||0;n=Math.max(n,r.bottom+m+(window.scrollY||0))}return Math.ceil(n)}function send(){q=0;var n=h();if(n===last)return;last=n;try{var w=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.harnessEmbed;if(w)w.postMessage(n);else if(window.parent!==window)window.parent.postMessage({harnessEmbedHeight:n},"*")}catch(e){}}function later(){if(!q)q=requestAnimationFrame(send)}function start(){var o=new ResizeObserver(later);o.observe(document.documentElement);if(document.body)o.observe(document.body);later()}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();addEventListener("load",later)})();</script>`;

/**
 * `html` with the sizing script inserted before the page's own scripts: right after `<head>`, else
 * after `<html>` (or a doctype), else at the very start.
 */
export function withSizingScript(html: string): string {
  const at = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (!at) return SIZING_SCRIPT + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + SIZING_SCRIPT + html.slice(end);
}
