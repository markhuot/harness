// Iframes, refs, keys, select and upload against real Chrome, through the tools the agent calls.
// The checkout fixture works like a Stripe Elements page: the card fields live in an iframe on
// another site (localhost vs 127.0.0.1, so Chrome runs it out of process), the expiry field only
// listens for key presses, and paying opens a 3-D Secure challenge in an iframe inside that one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { tempDir } from "@harness/shared/testing";
import { imageSize } from "../attachments.ts";
import {
  browserClick,
  browserContent,
  browserEval,
  browserKeys,
  browserRun,
  browserRunStatus,
  browserScreenshot,
  browserSelect,
  browserSnapshot,
  browserType,
  browserUpload,
  browserWait,
  resolveUploadPaths,
} from "../tools";
import { fakeContext, fakeOps, fakeSession } from "../tools/fakes";
import type { ToolContext, ToolResult } from "../tools/types";
import { findChrome } from "./chrome.ts";
import { frameChain } from "./frames.ts";
import { BrowserManager } from "./manager.ts";
import { checkCondition, describeCondition } from "./wait.ts";

const chromePath = findChrome();
const withChrome = chromePath ? describe : describe.skip;
const profileDir = chromePath ? tempDir("harness-frames-test-") : "";
const work = tempDir("harness-frames-work-");
const scratch = tempDir("harness-frames-scratch-");

const html = (body: string, title = "Fixture") =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body style="margin:0">${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** The card iframe's site (localhost): another site than the checkout's, so it runs out of process. */
function cardSite(req: Request): Response {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/card":
      return html(
        `<label>Card number <input id="number" autocomplete="cc-number"></label>
         <label>Expiry <input id="exp" placeholder="MM / YY"></label>
         <label>CVC <input id="cvc"></label>
         <button id="choose" type="button">Upload ID</button><input id="doc" type="file" hidden><span id="docname"></span>
         <button id="confirm" type="button">Confirm card</button>
         <div id="challenge"></div>
         <script>
           window.keys = [];
           window.clicks = [];
           const number = document.getElementById("number");
           number.addEventListener("keydown", (e) => keys.push(e.key));
           // Formats as you type, like Stripe's card field.
           number.addEventListener("input", () => {
             const digits = number.value.replace(/\\D/g, "").slice(0, 16);
             number.value = digits.replace(/(\\d{4})(?=\\d)/g, "$1 ");
           });
           // Only key presses count: an insert is undone.
           const exp = document.getElementById("exp");
           exp.dataset.v = "";
           exp.addEventListener("keydown", (e) => { if (/^\\d$/.test(e.key)) { exp.dataset.v += e.key; } });
           exp.addEventListener("input", () => { exp.value = exp.dataset.v; });
           document.getElementById("choose").addEventListener("click", () => document.getElementById("doc").click());
           document.getElementById("doc").addEventListener("change", (e) => { document.getElementById("docname").textContent = e.target.files[0].name; });
           document.getElementById("confirm").addEventListener("click", (e) => {
             clicks.push({ trusted: e.isTrusted });
             document.getElementById("challenge").innerHTML = '<iframe id="tds" title="3-D Secure" src="/challenge" style="width:300px;height:80px;border:0"></iframe>';
           });
         </script>`,
        "Card",
      );
    case "/challenge":
      return html(
        `<button id="complete" onclick="this.textContent = 'Authenticated'; parent.parent.postMessage('paid ' + parent.document.getElementById('number').value, '*')">Complete authentication</button>`,
        "Challenge",
      );
    default:
      return new Response("not found", { status: 404 });
  }
}

function checkoutSite(card: string) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/checkout":
        return html(
          `<h1>Checkout</h1>
           <div style="height:1200px"></div>
           <iframe id="card-frame" name="__privateStripeFrame5" title="Secure card payment input frame" src="${card}/card"
             style="border:4px solid #ccc;padding:6px;width:400px;height:260px"></iframe>
           <select id="country" aria-label="Country"><option value="us">United States</option><option value="ca">Canada</option><option value="mx" disabled>Mexico</option></select>
           <input id="avatar" type="file">
           <p id="status">unpaid</p>
           <p id="changes"></p>
           <script>
             addEventListener("message", (e) => { document.getElementById("status").textContent = e.data; });
             const country = document.getElementById("country");
             country.addEventListener("change", () => { document.getElementById("changes").textContent += country.value + ";"; });
             document.getElementById("avatar").addEventListener("change", (e) => { document.getElementById("changes").textContent += "file:" + e.target.files[0].name + ";"; });
           </script>`,
          "Checkout",
        );
      case "/late":
        return html(
          `<p>Loading payment form…</p>
           <script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", '<iframe id="late" src="${card}/card"></iframe>'); }, 400);</script>`,
          "Late",
        );
      default:
        return new Response("not found", { status: 404 });
    }
  };
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** A tool call that has to fail: its error text, whether the tool returned it or threw it. */
async function failure(tool: { execute(input: any, ctx: ToolContext): Promise<ToolResult> }, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  let r: ToolResult;
  try {
    r = await tool.execute(input, ctx);
  } catch (e) {
    return (e as Error).message;
  }
  if (!r.isError) throw new Error(`Expected an error, got: ${textOf(r)}`);
  return textOf(r);
}

withChrome("iframes, refs, keys, select and upload (real Chrome)", () => {
  let checkout: Server<unknown>;
  let card: Server<unknown>;
  let base: string;
  let browser: BrowserManager;
  let n = 0;
  /** A fresh session (its own tabs) on the checkout page. */
  async function ctxAt(path = "/checkout"): Promise<ToolContext> {
    const ctx = fakeContext({
      runId: `run-${++n}`,
      session: fakeSession({ id: `frames-${n}` }),
      browser,
      cwd: work,
      ops: fakeOps({ fileOutputScope: async () => ({ scratchDir: scratch, readOnly: false }) }),
    });
    await browser.open(ctx.session.id, `${base}${path}`);
    return ctx;
  }
  const run = async (tool: { execute(input: any, ctx: ToolContext): Promise<ToolResult> }, input: Record<string, unknown>, ctx: ToolContext) => {
    const r = await tool.execute(input, ctx);
    if (r.isError) throw new Error(textOf(r));
    return textOf(r);
  };
  const evalIn = (ctx: ToolContext, expression: string, frame?: string | string[]) => browser.evaluate(ctx.session.id, expression, { frame });

  beforeAll(() => {
    card = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: cardSite });
    checkout = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: checkoutSite(`http://localhost:${card.port}`) });
    base = `http://127.0.0.1:${checkout.port}`;
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000 });
  });

  afterAll(async () => {
    await browser?.shutdown();
    void checkout?.stop(true);
    void card?.stop(true);
  });

  test("the card iframe really runs out of process, and its own document can't be reached from the page", async () => {
    const ctx = await ctxAt();
    await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
    // Cross-origin: the page can't see in.
    expect(await evalIn(ctx, "document.getElementById('card-frame').contentDocument === null")).toBe("true");
    // Out of process: the frame's document lives in another CDP session than the tab's.
    const tab = (browser as any).entries.get(ctx.session.id).tabs.get(1);
    const frames = [...tab.frames.frames.values()] as { url: string; session: { id: string } }[];
    const cardFrame = frames.find((f) => f.url.endsWith("/card"))!;
    expect(cardFrame.session.id).not.toBe(tab.session.id);
  }, 30_000);

  describe("frame", () => {
    test("browser_content lists the page's iframes with the frame to pass, and reads inside one", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      const top = await run(browserContent, {}, ctx);
      expect(top).toContain("Checkout");
      expect(top).not.toContain("Card number");
      expect(top).toContain(`frame "#card-frame" — http://localhost:${card.port}/card, 420×280, "Secure card payment input frame"`);
      const inside = await run(browserContent, { frame: "#card-frame" }, ctx);
      expect(inside).toContain("Card number");
      expect(inside).not.toContain("Checkout");
    }, 30_000);

    test("browser_eval runs in the iframe's document, a selector by the iframe's name works too", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      expect(await run(browserEval, { expression: "location.host" }, ctx)).toBe(`"127.0.0.1:${checkout.port}"`);
      expect(await run(browserEval, { expression: "location.host", frame: "iframe[name^=__privateStripeFrame]" }, ctx)).toBe(`"localhost:${card.port}"`);
    }, 30_000);

    test("browser_type fills a field inside the cross-origin iframe, which formats it as it would for a person", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      expect(await run(browserType, { selector: "#number", frame: "#card-frame", text: "4242424242424242" }, ctx)).toBe('Typed into #number in frame "#card-frame".');
      expect(await evalIn(ctx, "document.getElementById('number').value", "#card-frame")).toBe('"4242 4242 4242 4242"');
      // Typing again replaces the value.
      await run(browserType, { selector: "#number", frame: "#card-frame", text: "5555555555554444" }, ctx);
      expect(await evalIn(ctx, "document.getElementById('number').value", "#card-frame")).toBe('"5555 5555 5555 4444"');
    }, 30_000);

    test("browser_click lands a real click on a button in an iframe below the fold, and in an iframe inside that one", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#confirm" }, ctx);
      await run(browserClick, { selector: "#confirm", frame: "#card-frame", wait_for: { frame: ["#card-frame", "#tds"], selector: "#complete" } }, ctx);
      // A trusted event: the real mouse click, not the el.click() fallback.
      expect(await evalIn(ctx, "JSON.stringify(window.clicks)", "#card-frame")).toBe(JSON.stringify(JSON.stringify([{ trusted: true }])));
      expect(await run(browserClick, { selector: "#complete", frame: ["#card-frame", "#tds"], wait_for: { text: "paid" } }, ctx)).toContain('Clicked #complete in frame ["#card-frame","#tds"]');
      expect(await evalIn(ctx, "document.getElementById('complete').textContent", ["#card-frame", "#tds"])).toBe('"Authenticated"');
    }, 30_000);

    test("a frame that isn't there yet is waited for; one that matches no iframe, or not an iframe, says so", async () => {
      const ctx = await ctxAt("/late");
      const early = await failure(browserContent, { frame: "#late" }, ctx);
      expect(early).toContain('No iframe matches frame "#late".');
      const waited = await run(browserWait, { frame: "#late", selector: "#number", timeout: 10 }, ctx);
      expect(waited).toContain('"#number" visible in frame "#late" after');
      const notFrame = await failure(browserWait, { frame: "p", selector: "#number", timeout: 10 }, ctx);
      expect(notFrame).toContain('frame "p" matches a <p>, not an <iframe>.');
      // It failed at once, not at the timeout.
      expect(notFrame).not.toContain("Timed out");
    }, 30_000);

    test("a screenshot of the frame is the iframe's box, of an element inside it that element's", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      const size = async (input: Record<string, unknown>) => {
        const r = await browserScreenshot.execute(input, ctx);
        const img = r.content.find((c) => c.type === "image") as { data: string };
        return imageSize("image/png", Buffer.from(img.data, "base64"));
      };
      // A box at a fractional position takes in the pixel it starts in: one more at most.
      const near = (got: { width: number; height: number } | null, w: number, h: number) => {
        expect(got!.width - w).toBeOneOf([0, 1]);
        expect(got!.height - h).toBeOneOf([0, 1]);
      };
      near(await size({ frame: "#card-frame" }), 420, 280);
      const box = JSON.parse(JSON.parse(await evalIn(ctx, "JSON.stringify([document.getElementById('number').offsetWidth, document.getElementById('number').offsetHeight])", "#card-frame")));
      near(await size({ selector: "#number", frame: "#card-frame" }), box[0], box[1]);
    }, 30_000);
  });

  describe("browser_snapshot", () => {
    test("nests the iframe's tree with refs that click and type inside it; a node keeps its ref, and a reload makes it stale", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      const snap = await run(browserSnapshot, {}, ctx);
      expect(snap).toMatch(/- heading "Checkout" \[ref=e\d+\] level=1/);
      expect(snap).toMatch(/- iframe "Secure card payment input frame" \[ref=e\d+\]\n\s+- document/);
      const number = /textbox "Card number" \[ref=(e\d+)\]/.exec(snap)![1]!;
      // The iframe's lines are indented under it.
      const iframeIndent = /( *)- iframe "Secure card/.exec(snap)![1]!.length;
      const numberIndent = /( *)- textbox "Card number"/.exec(snap)![1]!.length;
      expect(numberIndent).toBeGreaterThan(iframeIndent);
      await run(browserType, { ref: number, text: "4000002500003155" }, ctx);
      expect(await evalIn(ctx, "document.getElementById('number').value", "#card-frame")).toBe('"4000 0025 0000 3155"');
      const again = await run(browserSnapshot, {}, ctx);
      expect(again).toContain(`textbox "Card number" [ref=${number}] value="4000 0025 0000 3155"`);
      // Only the iframe's tree.
      const only = await run(browserSnapshot, { frame: "#card-frame" }, ctx);
      expect(only).not.toContain("Checkout");
      expect(only).toContain(`[ref=${number}]`);
      await browser.open(ctx.session.id, `${base}/checkout?again`);
      const stale = await failure(browserClick, { ref: number }, ctx);
      expect(stale).toContain(`Ref ${number} is stale`);
    }, 30_000);

    test("max_nodes caps the tree and says how much it left out", async () => {
      const ctx = await ctxAt();
      const snap = await run(browserSnapshot, { max_nodes: 3 }, ctx);
      expect(snap.split("\n").filter((l) => l.trimStart().startsWith("- "))).toHaveLength(3);
      expect(snap).toMatch(/\(\d+ more nodes not shown/);
    }, 30_000);
  });

  describe("browser_keys", () => {
    test("Tab and Shift+Tab move focus between the iframe's fields", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#number" }, ctx);
      await run(browserClick, { selector: "#number", frame: "#card-frame" }, ctx);
      await run(browserKeys, { keys: ["Tab"] }, ctx);
      expect(await evalIn(ctx, "document.activeElement.id", "#card-frame")).toBe('"exp"');
      await run(browserKeys, { keys: ["Shift+Tab"] }, ctx);
      expect(await evalIn(ctx, "document.activeElement.id", "#card-frame")).toBe('"number"');
    }, 30_000);

    test("per_key reaches a field that only listens for key presses; an insert doesn't", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#exp" }, ctx);
      await run(browserClick, { selector: "#exp", frame: "#card-frame" }, ctx);
      await run(browserKeys, { text: "1234" }, ctx);
      expect(await evalIn(ctx, "document.getElementById('exp').value", "#card-frame")).toBe('""');
      expect(await run(browserKeys, { text: "1234", per_key: true }, ctx)).toBe('Typed "1234" key by key.');
      expect(await evalIn(ctx, "document.getElementById('exp').value", "#card-frame")).toBe('"1234"');
    }, 30_000);

    test("an unknown key is refused before anything is sent", async () => {
      const ctx = await ctxAt();
      const r = await failure(browserKeys, { keys: ["Tab", "Hyper+q"] }, ctx);
      expect(r).toContain('Unknown modifier "Hyper"');
    }, 30_000);
  });

  describe("browser_select", () => {
    test("picks by label (ignoring case) and index, firing change; lists the options when nothing matches", async () => {
      const ctx = await ctxAt();
      expect(await run(browserSelect, { selector: "#country", label: "canada" }, ctx)).toBe('Selected "Canada" in #country.');
      await run(browserSelect, { selector: "#country", index: 0 }, ctx);
      expect(await evalIn(ctx, "document.getElementById('changes').textContent")).toBe('"ca;us;"');
      const none = await failure(browserSelect, { selector: "#country", value: "zz" }, ctx);
      expect(none).toContain('No option of #country matches "zz"');
      expect(none).toContain('1: "Canada" (value "ca")');
      const off = await failure(browserSelect, { selector: "#country", value: "mx" }, ctx);
      expect(off).toContain('The option "Mexico" is disabled.');
      const notSelect = await failure(browserSelect, { selector: "#status", value: "x" }, ctx);
      expect(notSelect).toContain("#status is a <p>, not a <select>");
    }, 30_000);
  });

  describe("browser_upload", () => {
    test("sets a file on an input, and through the file chooser a button inside the iframe opens", async () => {
      const ctx = await ctxAt();
      writeFileSync(join(work, "id.png"), "fake png");
      expect(await run(browserUpload, { selector: "#avatar", paths: ["id.png"] }, ctx)).toBe("Uploaded id.png to #avatar.");
      expect(await evalIn(ctx, "document.getElementById('changes').textContent")).toBe('"file:id.png;"');
      await run(browserWait, { frame: "#card-frame", selector: "#choose" }, ctx);
      expect(await run(browserUpload, { selector: "#choose", frame: "#card-frame", paths: ["id.png"], wait_for: { frame: "#card-frame", text: "id.png" } }, ctx)).toStartWith(
        'Uploaded id.png to #choose in frame "#card-frame" (through the file dialog it opened).',
      );
    }, 30_000);

    test("a button that opens no file chooser says so", async () => {
      const ctx = await ctxAt();
      writeFileSync(join(work, "id.png"), "fake png");
      const r = await failure(browserUpload, { selector: "#status", paths: ["id.png"] }, ctx);
      expect(r).toContain("#status isn't an <input type=file>, and clicking it didn't open a file chooser.");
    }, 30_000);
  });

  test("a browser_run script pays through the iframe with frames, keys and a ref", async () => {
    const ctx = await ctxAt();
    const script = `await wait({ frame: "#card-frame", selector: "#number" });
await type("#number", "4242424242424242", { frame: "#card-frame" });
await click({ selector: "#exp", frame: "#card-frame" });
await keys({ text: "1230", per_key: true });
await select("#country", { label: "Canada" });
await click("#confirm", { frame: "#card-frame", wait_for: { frame: ["#card-frame", "#tds"], selector: "#complete" } });
const tree = await snapshot();
const ref = /button "Complete authentication" \\[ref=(e\\d+)\\]/.exec(tree)[1];
await click({ ref }, { wait_for: { text: "paid" } });
return [await content("#status"), await evaluate(() => document.getElementById("exp").value, { frame: "#card-frame" })];`;
    let r = await browserRun.execute({ script, wait: 30 }, ctx);
    const job = Number(/Job (\d+)/.exec(textOf(r))![1]);
    while (/: running \(/.test(textOf(r))) r = await browserRunStatus.execute({ job, wait: 10 }, ctx);
    expect(textOf(r)).toContain('Result: ["paid 4242 4242 4242 4242","1230"]');
  }, 60_000);

  describe("tool input", () => {
    test("an element is a selector or a ref, and a ref takes no frame", async () => {
      const ctx = await ctxAt();
      expect(textOf(await browserClick.execute({}, ctx))).toBe("Pass selector or ref (one of them).");
      expect(textOf(await browserClick.execute({ selector: "#a", ref: "e1" }, ctx))).toBe("Pass selector or ref (one of them).");
      expect(textOf(await browserType.execute({ ref: "e1", frame: "#card-frame", text: "x" }, ctx))).toBe("A ref already knows its frame: pass ref without frame.");
      expect(await failure(browserClick, { ref: "e999" }, ctx)).toContain("No element has ref e999 in this tab.");
      expect(textOf(await browserSelect.execute({ selector: "#country", value: "us", index: 1 }, ctx))).toBe("Pass one of value, label or index.");
    }, 30_000);

    test("a frame sent as a JSON string is the array it spells; an attribute selector stays a selector", async () => {
      const ctx = await ctxAt();
      await run(browserWait, { frame: "#card-frame", selector: "#confirm" }, ctx);
      await run(browserClick, { selector: "#confirm", frame: "[name^=__privateStripeFrame]", wait_for: { frame: '["#card-frame", "#tds"]', selector: "#complete" } }, ctx);
      expect(await run(browserEval, { expression: "document.title", frame: '["#card-frame","#tds"]' }, ctx)).toBe('"Challenge"');
    }, 30_000);
  });
});

describe("resolveUploadPaths", () => {
  const cwd = tempDir("harness-upload-cwd-");
  const scratchDir = tempDir("harness-upload-scratch-");
  const outside = tempDir("harness-upload-outside-");
  writeFileSync(join(cwd, "a.txt"), "a");
  writeFileSync(join(scratchDir, "b.txt"), "b");
  writeFileSync(join(outside, "secret.txt"), "s");
  mkdirSync(join(cwd, "dir"), { recursive: true });
  symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));

  test("takes files under the working directory or the scratch folder, relative ones from the working directory", () => {
    expect(resolveUploadPaths(["a.txt", join(scratchDir, "b.txt")], { cwd, scratchDir })).toEqual([realpathSync(join(cwd, "a.txt")), realpathSync(join(scratchDir, "b.txt"))]);
  });

  test("refuses a file elsewhere, a symlink that leads out, a folder, and a missing file", () => {
    expect(() => resolveUploadPaths([join(outside, "secret.txt")], { cwd, scratchDir })).toThrow("files must be inside your working directory");
    expect(() => resolveUploadPaths(["link.txt"], { cwd, scratchDir })).toThrow("files must be inside your working directory");
    expect(() => resolveUploadPaths(["dir"], { cwd, scratchDir })).toThrow("it isn't a file");
    expect(() => resolveUploadPaths(["nope.txt"], { cwd, scratchDir })).toThrow("there's no file there");
  });
});

describe("frameChain", () => {
  test("a selector, an array, or an array spelled as JSON; an attribute selector isn't JSON", () => {
    expect(frameChain("#card")).toEqual(["#card"]);
    expect(frameChain(["#a", "#b"])).toEqual(["#a", "#b"]);
    expect(frameChain('["#a", "#b"]')).toEqual(["#a", "#b"]);
    expect(frameChain("[name=card]")).toEqual(["[name=card]"]);
  });

  test("an empty array, a blank selector or a non-string is refused", () => {
    expect(() => frameChain([])).toThrow("frame is a CSS selector for the <iframe> element");
    expect(() => frameChain(["#a", " "])).toThrow("frame is a CSS selector");
    expect(() => frameChain(3)).toThrow("frame is a CSS selector");
  });
});

describe("wait conditions with a frame", () => {
  test("a frame alone is something to wait for, and is described as the iframe loading", () => {
    const c = checkCondition({ frame: ["#card"] });
    expect(c).toEqual({ ok: true, condition: { frame: "#card" } });
    expect(describeCondition({ frame: ["#a", "#b"] })).toBe('frame ["#a","#b"] loaded');
    expect(describeCondition({ frame: "#card", selector: "#number", state: "enabled" })).toBe('"#number" enabled in frame "#card"');
  });

  test("a malformed frame is refused before waiting", () => {
    expect(checkCondition({ frame: [], selector: "#x" })).toEqual({ ok: false, error: "frame is a CSS selector for the <iframe> element, or an array of them for nested frames (outermost first)." });
  });
});
