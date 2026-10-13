// Waits (browser_wait and wait_for) and browser_run scripts against real Chrome, through the tools
// the agent calls. The cart fixture behaves like the one in ACAMS-33 that made an agent sleep
// between clicks: "Remove" makes a slow request, marks the page aria-busy meanwhile, then reloads
// with one item fewer.

import { expect } from "bun:test";
import { inflateSync } from "node:zlib";
import type { ToolResultContent } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import type { ToolResult } from "../tools/types";
import { describeIf } from "@harness/shared/testing/skip";
import { seedChromeProfile } from "@harness/shared/testing/chrome-profile";
import { findChrome } from "./chrome.ts";

export const chromePath = findChrome();
export const withChrome = describeIf(chromePath, "Chrome not found (set HARNESS_CHROME_PATH): wait and browser_run tests skipped");
export const profileDir = chromePath ? tempDir("harness-wait-test-") : "";
if (chromePath) await seedChromeProfile(profileDir, chromePath);
export const scratch = tempDir("harness-wait-scratch-");

const html = (body: string, title = "Fixture") =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body style="margin:0">${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export function fixtures(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/cart": {
      const n = Number(url.searchParams.get("n") ?? "0");
      const items = Array.from({ length: n }, (_, i) => `<li>Item ${i + 1} <button data-remove-item aria-label="Remove item ${i + 1}">Remove</button></li>`).join("");
      return html(
        `<main id="cart"><ul>${items}</ul><p id="count">${n} items</p></main>
         <script>
           for (const b of document.querySelectorAll("[data-remove-item]")) b.addEventListener("click", async () => {
             document.getElementById("cart").setAttribute("aria-busy", "true");
             await fetch("/slow?ms=700");
             location.href = "/cart?n=${n - 1}";
           });
         </script>`,
        "Cart",
      );
    }
    case "/slow":
      return Bun.sleep(Number(url.searchParams.get("ms") ?? "500")).then(() => new Response("ok"));
    case "/hang":
      return new Promise<Response>(() => {});
    case "/hanging":
      return html(`<p>waiting</p><script>fetch("/hang")</script>`, "Hanging");
    case "/busy":
      return html(`<div aria-busy="true"><button id="b" onclick="this.textContent='pressed'">Go</button></div>`, "Busy");
    case "/late": {
      const ms = Number(url.searchParams.get("ms") ?? "500");
      return html(
        `<div id="box" style="position:fixed;inset:0;background:rgb(255,255,255)"></div>
         <script>setTimeout(() => {
           const d = document.createElement("div"); d.className = "done"; d.textContent = "All done";
           document.body.append(d); document.getElementById("box").style.background = "rgb(0,128,0)";
         }, ${ms})</script>`,
        "Late",
      );
    }
    case "/plain":
      return html(`<h1 id="x" class="title big">Plain</h1>`, "Plain");
    case "/form":
      // Each button changes the page a moment after the click, so an expectation has to wait for it.
      return html(
        `<input id="q"><ul id="list"><li>Item 1</li></ul>
         <button id="add">Add</button> <button id="clear">Clear</button>
         <button id="toggle" aria-expanded="false">Toggle</button> <button id="go">Go</button>
         <a id="link" href="/plain" data-x>Link</a> <p id="hint" style="display:none">Hint</p>
         <iframe id="f" srcdoc="<p id='inner'>Inside</p>"></iframe>
         <script>
           const list = document.getElementById("list");
           const later = (id, ms, fn) => document.getElementById(id).addEventListener("click", () => setTimeout(fn, ms));
           later("add", 300, () => { const li = document.createElement("li"); li.textContent = "Item " + (list.children.length + 1); list.append(li); });
           later("clear", 500, () => list.replaceChildren());
           later("toggle", 200, () => document.getElementById("toggle").setAttribute("aria-expanded", "true"));
           later("go", 200, () => { location.href = "/plain?done=1"; });
         </script>`,
        "Form",
      );
    default:
      return new Response("not found", { status: 404 });
  }
}

export const texts = (r: ToolResult) => r.content.filter((c): c is Extract<ToolResultContent, { type: "text" }> => c.type === "text").map((c) => c.text);
export const all = (r: ToolResult) => texts(r).join("\n");

/** The first pixel of a PNG (always stored raw: no filter has a left or upper neighbour there). */
export function firstPixel(base64: string): [number, number, number] {
  const png = Buffer.from(base64, "base64");
  const colorType = png[25];
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  expect([2, 6]).toContain(colorType!);
  return [raw[1]!, raw[2]!, raw[3]!];
}

export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
