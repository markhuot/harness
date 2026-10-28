import { describe, expect, test } from "bun:test";
import { Markdown } from "../../app/src/renderer/components/Markdown";
import { mount } from "./render";

const render = async (text: string) => (await mount(<Markdown text={text} />)).container;

describe("markdown: tables, headings and lists inside lists and quotes", () => {
  test("a table inside a list item renders as a styled table in that item", async () => {
    const c = await render("- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |");
    expect(c.querySelectorAll("li > .md-table table th").length).toBe(2);
    expect(c.querySelector("li > .md-table td")?.textContent).toBe("1");
  });
  test("a table inside a block quote renders as a table", async () => {
    const c = await render("> | a | b |\n> |---|---|\n> | 1 | 2 |");
    expect(c.querySelectorAll("blockquote .md-table th").length).toBe(2);
  });
  test("a heading and a list inside a quote, and a heading inside a list item", async () => {
    const q = await render("> ## Title\n>\n> - one\n> - two");
    expect(q.querySelector("blockquote h2")?.textContent).toBe("Title");
    expect(q.querySelectorAll("blockquote li").length).toBe(2);
    const l = await render("- item\n  ## Title");
    expect(l.querySelector("li h2")?.textContent).toBe("Title");
  });
  test("a nested quote and plain quote lines keep their breaks", async () => {
    const c = await render("> a\n> b\n>\n> > deep");
    expect(c.querySelector("blockquote p br")).not.toBeNull();
    expect(c.querySelector("blockquote blockquote")?.textContent).toBe("deep");
  });
});
