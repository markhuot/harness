import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ICON_PATHS } from "@harness/shared/state";
import { ReviewMark } from "./bits";

describe("ReviewMark", () => {
  test("a skipped agent review is outlined and muted, with a minus", () => {
    const html = renderToStaticMarkup(<ReviewMark who="agent" state="skipped" />);
    expect(html).toContain('title="Agent review: skipped"');
    expect(html).toContain("badge-outline review-skipped");
    expect(html).toContain(`d="${ICON_PATHS.minus}"`);
    expect(html).not.toContain("pending-dot");
    expect(html).not.toContain("badge-green");
  });

  test("each state gets its own mark", () => {
    const marks = (["pending", "approved", "changes_requested", "skipped"] as const).map((s) => renderToStaticMarkup(<ReviewMark who="agent" state={s} />));
    expect(new Set(marks).size).toBe(4);
    expect(marks[0]).toContain("pending-dot");
    expect(marks[1]).toContain(`d="${ICON_PATHS.check}"`);
    expect(marks[2]).toContain('title="Agent review: changes requested"');
  });
});
