import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ICON_PATHS } from "@harness/shared/state";
import { ReviewMark, TicketKey } from "./bits";

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

describe("TicketKey", () => {
  test("a linked ticket shows its remote ID, then its own key muted", () => {
    const html = renderToStaticMarkup(<TicketKey ticket={{ key: "MH-124", externalRef: { key: "MH-62" } }} />);
    expect(html).toBe('MH-62<span class="key-local"> · MH-124</span>');
  });

  test("an unlinked ticket, or a legacy mirror whose key is its remote ID, shows the key alone", () => {
    expect(renderToStaticMarkup(<TicketKey ticket={{ key: "MH-62", externalRef: null }} />)).toBe("MH-62");
    expect(renderToStaticMarkup(<TicketKey ticket={{ key: "FOO-123", externalRef: { key: "FOO-123" } }} />)).toBe("FOO-123");
  });
});
