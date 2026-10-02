import { describe, expect, test } from "bun:test";
import type { Project, Ticket } from "../index";
import { inlineTokens } from "./markdown";
import { initialState, ticketLinkable, type State } from "./reducer";

describe("inlineTokens: ticket keys", () => {
  test("an UPPERCASE-NN word becomes a ticket token between the surrounding text", () => {
    expect(inlineTokens("Merged HARNESS-101, then FOO2-7.")).toEqual([
      { t: "text", text: "Merged " },
      { t: "ticket", key: "HARNESS-101" },
      { t: "text", text: ", then " },
      { t: "ticket", key: "FOO2-7" },
      { t: "text", text: "." },
    ]);
  });

  test("lower-case, mixed-case, glued-on and non-numeric look-alikes stay text", () => {
    for (const s of ["harness/harness-112", "Harness-12", "xHARNESS-12", "HARNESS-12a", "HARNESS-x", "2FA-3"]) {
      expect(inlineTokens(s).some((t) => t.t === "ticket")).toBe(false);
    }
  });

  test("keys inside code spans, links and URLs aren't split out", () => {
    expect(inlineTokens("`HARNESS-1`")).toEqual([{ t: "code", text: "HARNESS-1" }]);
    expect(inlineTokens("https://happycog.atlassian.net/browse/PLAYR-123")).toEqual([
      { t: "link", text: "https://happycog.atlassian.net/browse/PLAYR-123", url: "https://happycog.atlassian.net/browse/PLAYR-123" },
    ]);
    expect(inlineTokens("[PLAYR-9](https://x.test/PLAYR-9)")).toEqual([{ t: "link", text: "PLAYR-9", url: "https://x.test/PLAYR-9" }]);
  });

  test("[label](KEY) is a ticket token for KEY that carries the label", () => {
    expect(inlineTokens("See [RFAWC-726](RFACOM-2) now")).toEqual([
      { t: "text", text: "See " },
      { t: "ticket", key: "RFACOM-2", text: "RFAWC-726" },
      { t: "text", text: " now" },
    ]);
    expect(inlineTokens("[the fix](HARNESS-12)")).toEqual([{ t: "ticket", key: "HARNESS-12", text: "the fix" }]);
  });

  test("a link target that only looks like a key isn't a ticket (it stays a file link)", () => {
    expect(inlineTokens("[x](rfacom-2)")).toEqual([{ t: "link", text: "x", url: "rfacom-2" }]);
    expect(inlineTokens("[X](FOO-1a)")).toEqual([{ t: "link", text: "X", url: "FOO-1a" }]);
    for (const s of ["[x](rfacom-2)", "[X](FOO-1a)", "[X](Foo-1)", "[X](2FA-3)", "[X](FOO-1/bar)", "[X](https://x.test/FOO-1)"]) {
      expect(inlineTokens(s).some((t) => t.t === "ticket")).toBe(false);
    }
  });
});

describe("ticketLinkable", () => {
  const project = (id: string, key: string) => ({ id, key }) as Project;
  const ticket = (id: string, key: string) => ({ id, key, projectId: "p1", title: id }) as Ticket;
  const state: State = {
    ...initialState,
    projects: { p1: project("p1", "HARNESS") },
    tickets: { t1: ticket("t1", "PLAYR-123"), t2: ticket("t2", "HARNESS-5") },
    keyAliases: { "OLD-5": "t2" },
    missingKeys: { "HARNESS-999": true },
  };

  test("a loaded ticket links, including a mirrored key outside any project's prefix", () => {
    expect(ticketLinkable(state, "PLAYR-123")).toBe(true);
    expect(ticketLinkable(state, "OLD-5")).toBe(true);
  });

  test("an unloaded key under a project's prefix links (older done tickets aren't in memory)", () => {
    expect(ticketLinkable(state, "HARNESS-40")).toBe(true);
  });

  test("a key the service 404'd, or one matching no project or ticket, stays text", () => {
    expect(ticketLinkable(state, "HARNESS-999")).toBe(false);
    expect(ticketLinkable(state, "UTF-8")).toBe(false);
    expect(ticketLinkable(state, "PLAYR-124")).toBe(false);
  });
});
