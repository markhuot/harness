import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("nested lists render as nested elements with depth classes and the ordered start", () => {
  const html = render("3. a\n   - b\n     1. c\n4. d");
  expect(html).toContain('<ol class="md-list depth-0" start="3"><li>a<ul class="md-list depth-1"><li>b<ol class="md-list depth-2" start="1"><li>c</li></ol></li></ul></li><li>d</li></ol>');
});

test("remote and file images render as links, never as <img>", () => {
  const html = render("![pixel](https://tracker.example/p.gif)\n\n![after](harness://file/shots/after.png)");
  expect(html).not.toContain("<img");
  expect(html).toContain('href="https://tracker.example/p.gif"');
  expect(html).toContain('href="harness://file/shots/after.png"');
});

test("without a store there is no attachment URL, so an attachment image is its alt text", () => {
  const html = render("![shot](attachment:abc)");
  expect(html).not.toContain("<img");
  expect(html).toContain("shot");
});

test("an image alone on its line is a figure captioned with its alt text; without a store the caption isn't repeated", () => {
  const html = render("![The board after the fix](attachment:abc)");
  expect(html).toContain('<figure class="md-figure" data-testid="md-figure"><figcaption>The board after the fix</figcaption></figure>');
  expect(render("![](attachment:abc)")).not.toContain("<figcaption");
});

test('"thumb" images on a line form one row of thumbnails, each labelled with its alt text', () => {
  const html = render('![Before](attachment:a "thumb") ![After](attachment:b "thumb")');
  expect(html.match(/class="md-thumbs"/g)).toHaveLength(1);
  expect(html.match(/class="md-thumb"/g)).toHaveLength(2);
  expect(html).toContain('<figcaption title="After">After</figcaption>');
  expect(html).not.toContain("md-figure");
});
