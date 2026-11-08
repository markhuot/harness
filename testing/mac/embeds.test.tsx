import { describe, expect, test } from "bun:test";
import type { Attachment } from "@harness/shared";
import { EMBED_MAX_HEIGHT } from "@harness/shared/state";
import { Markdown, SpecAttachmentsScope } from "../../app/src/renderer/components/Markdown";
import { mount } from "./render";

const PAGE = "3f2a9c1e-0000-4000-8000-000000000001";
const FILE = "3f2a9c1e-0000-4000-8000-000000000002";
const attachments: Attachment[] = [
  { id: PAGE, path: "/h/attachments/page", name: "profile.html", source: "spec", kind: "page", mimeType: "text/html" },
  { id: FILE, path: "/h/attachments/file", name: "notes.txt", source: "spec", kind: "file", mimeType: "text/plain" },
];

const render = (text: string) =>
  mount(
    <SpecAttachmentsScope attachments={attachments}>
      <Markdown text={text} />
    </SpecAttachmentsScope>,
  );

/**
 * happy-dom gives a frame on a scheme it can't load no window; give each one a window of its own,
 * as the browser does, so a message can come from it.
 */
const withWindow = (frame: HTMLIFrameElement) => {
  if (!frame.contentWindow) Object.defineProperty(frame, "contentWindow", { value: {} as Window });
  return frame;
};
const frameOf = (c: HTMLElement) => withWindow(c.querySelector<HTMLIFrameElement>("[data-testid=md-embed-frame]")!);

describe("page attachments in markdown", () => {
  test("a page attachment line renders a sandboxed embed at its harness-embed URL, captioned, with a full-screen button", async () => {
    const { container: c } = await render(`Intro\n\n[Flame graph](attachment:${PAGE})\n\nAfter`);
    const frame = frameOf(c);
    expect(frame.getAttribute("src")).toBe(`harness-embed://${PAGE}/`);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    expect(c.querySelector(".md-embed-bar")?.textContent).toContain("Flame graph");
    expect(c.querySelector("[data-testid=md-embed-full]")).not.toBeNull();
    expect(frame.style.height).toBe("360px");
  });

  test("a non-page attachment line, and one the ticket doesn't list, render as their text", async () => {
    const { container: c } = await render(`[Notes](attachment:${FILE})\n\n[Gone](attachment:missing-id)`);
    expect(c.querySelector("[data-testid=md-embed]")).toBeNull();
    expect([...c.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Notes", "Gone"]);
  });

  test("an inline page link opens the page full screen rather than embedding it; other inline attachments are text", async () => {
    const m = await render(`See [the graph](attachment:${PAGE}) and [notes](attachment:${FILE}).`);
    const c = m.container;
    expect(c.querySelector("[data-testid=md-embed]")).toBeNull();
    expect(c.querySelector("p")?.textContent).toBe("See the graph and notes.");
    const link = c.querySelector<HTMLAnchorElement>("[data-testid=md-embed-link]")!;
    expect(link.textContent).toBe("the graph");
    await m.settle(() => link.click());
    const full = document.querySelector<HTMLIFrameElement>("[data-testid=embed-full-frame]");
    expect(full?.getAttribute("src")).toBe(`harness-embed://${PAGE}/`);
    expect(full?.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    await m.settle(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[data-testid=embed-full-frame]")).toBeNull();
  });

  test("the full-screen button opens the page over the window, and its close button closes it", async () => {
    const m = await render(`[Flame graph](attachment:${PAGE})`);
    await m.settle(() => m.container.querySelector<HTMLButtonElement>("[data-testid=md-embed-full]")!.click());
    expect(document.querySelector(".overlay.embed-full [data-testid=embed-full-frame]")).not.toBeNull();
    await m.settle(() => document.querySelector<HTMLButtonElement>("[data-testid=embed-full-close]")!.click());
    expect(document.querySelector(".overlay.embed-full")).toBeNull();
  });

  test("the embed follows its own frame's height and ignores messages from any other frame", async () => {
    const m = await render(`[One](attachment:${PAGE})\n\n[Two](attachment:${PAGE})`);
    const [one, two] = [...m.container.querySelectorAll<HTMLIFrameElement>("[data-testid=md-embed-frame]")].map(withWindow);
    const post = (from: Window | null, data: unknown) => m.settle(() => void window.dispatchEvent(new MessageEvent("message", { data, source: from })));
    expect(one!.contentWindow).not.toBe(two!.contentWindow);
    await post(two!.contentWindow, { harnessEmbedHeight: 900 });
    expect(one!.style.height).toBe("360px");
    expect(two!.style.height).toBe("900px");
    await post(null, { harnessEmbedHeight: 1200 });
    expect(one!.style.height).toBe("360px");
    await post(one!.contentWindow, { harnessEmbedHeight: 640.2 });
    expect(one!.style.height).toBe("641px");
  });

  test("a reported height past the maximum is held there (the page scrolls inside)", async () => {
    const m = await render(`[Tall](attachment:${PAGE})`);
    const frame = frameOf(m.container);
    await m.settle(() => void window.dispatchEvent(new MessageEvent("message", { data: { harnessEmbedHeight: 99999 }, source: frame.contentWindow })));
    expect(frame.style.height).toBe(`${EMBED_MAX_HEIGHT}px`);
  });

  test("a failed load shows a placeholder with the caption and full-screen button, and the rest of the spec still renders", async () => {
    const m = await render(`[Broken](attachment:${PAGE})\n\nStill here`);
    const frame = frameOf(m.container);
    await m.settle(() => void window.dispatchEvent(new MessageEvent("message", { data: { harnessEmbedFailed: 404 }, source: frame.contentWindow })));
    expect(m.container.querySelector("[data-testid=md-embed-frame]")).toBeNull();
    expect(m.container.querySelector("[data-testid=md-embed-failed]")).not.toBeNull();
    expect(m.container.querySelector(".md-embed-bar")?.textContent).toContain("Broken");
    expect(m.container.querySelector("[data-testid=md-embed-full]")).not.toBeNull();
    expect(m.container.querySelector("p")?.textContent).toBe("Still here");
  });
});
