import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Progress } from "@harness/shared/state";
import { ConductorProgress } from "./Conductor";

const progress = (byStatus: Partial<Progress["byStatus"]>, attention = 0): Progress => {
  const all = { planning: 0, in_progress: 0, blocked: 0, review: 0, done: 0, ...byStatus };
  return { total: Object.values(all).reduce((n, c) => n + c, 0), byStatus: all, attention };
};

describe("ConductorProgress (ticket detail header)", () => {
  test("a ticket without children shows nothing", () => {
    expect(renderToStaticMarkup(<ConductorProgress progress={progress({})} onOpen={() => {}} />)).toBe("");
  });

  test("a button with the label and the bar, and no waiting line when nothing waits on you", () => {
    const html = renderToStaticMarkup(<ConductorProgress progress={progress({ done: 2, in_progress: 1 })} onOpen={() => {}} />);
    expect(html).toStartWith('<button class="cond-progress"');
    expect(html).toContain("2/3 done · 1 in progress");
    expect(html).toContain('class="cond-bar cond-bar-md"');
    expect(html).not.toContain("waiting on you");
  });

  test("counts the children waiting on you, singular and plural", () => {
    const one = renderToStaticMarkup(<ConductorProgress progress={progress({ blocked: 1, done: 1 }, 1)} onOpen={() => {}} />);
    expect(one).toContain(">1 ticket waiting on you<");
    const two = renderToStaticMarkup(<ConductorProgress progress={progress({ blocked: 2 }, 2)} onOpen={() => {}} />);
    expect(two).toContain(">2 tickets waiting on you<");
  });
});
