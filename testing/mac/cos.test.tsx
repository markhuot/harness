import { describe, expect, test } from "bun:test";
import type { CosChatEntry } from "@harness/shared";
import { CosPane } from "../../app/src/renderer/views/Cos";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { defaultPanes, openCos } from "../../app/src/renderer/state/paneModel";
import { getPanes, leaves, updatePanes, usePanes } from "../../app/src/renderer/state/panes";
import { ProjectSettingsView } from "../../app/src/renderer/views/ProjectSettings";
import { SettingsView } from "../../app/src/renderer/views/Settings";
import { all, click, edited, mount, text, type } from "./render";
import { FakeClient } from "./fakeClient";
import { world } from "../world";
import { minutesAgo } from "../world/time";

type M = Awaited<ReturnType<typeof mount>>;

/** The chief's pane, as the workspace shows it beside the board. */
function Routed() {
  const panes = usePanes("*");
  const leaf = leaves(panes.root).find((l) => l.content.kind === "cos");
  return leaf && leaf.content.kind === "cos" ? <CosPane paneId={leaf.id} content={leaf.content} /> : <div data-testid="elsewhere" />;
}

/** Opens the chief named by a `#/cos/<scope>[/<tab>]` shorthand in a pane, the way the board's card does. */
const open = (hash = "#/cos/all", client?: FakeClient) => {
  const [scope = "all", tab = "chat"] = hash.replace("#/cos/", "").split("/").map(decodeURIComponent);
  updatePanes("*", () => openCos(defaultPanes("B"), scope, tab as "chat" | "inbox"));
  return mount(<Routed />, { client });
};
const paneTab = () => {
  const c = leaves(getPanes("*").root).find((l) => l.content.kind === "cos")?.content;
  return c && c.kind === "cos" ? c.tab : null;
};
const byId = (m: M, id: string) => m.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const msgs = (m: M) => all(m.container, '[data-testid^="cos-msg"]').map((e) => text(e));
const events = (m: M) => all(m.container, '[data-testid="cos-event"]');
const eventRow = (m: M, id: string) => events(m).find((e) => e.dataset.event === id)!;

/** `n` chat messages, oldest first: "msg 1" … "msg n". */
const chat = (n: number): CosChatEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${String(i + 1).padStart(3, "0")}`, cosId: "cos-all", createdAt: minutesAgo(n - i), kind: "message", role: "assistant", text: `msg ${i + 1}` }));

describe("Chat", () => {
  test("shows the conversation, with the tickets the chief made and moved as cards and a wake as one short line", async () => {
    const m = await open();
    await m.until("the chat", () => msgs(m).length > 0);
    expect(msgs(m)[0]).toContain("What did the agents get done yesterday?");
    const cards = all(m.container, '[data-testid="cos-ticket-card"]').map((c) => text(c));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("HARNESS-204");
    expect(cards[0]).toContain("Follow up on the flaky palette test");
    expect(cards[0]).toContain("Created");
    expect(cards[1]).toContain("HARNESS-203");
    expect(cards[1]).toContain("In progress → Review");
    expect(text(byId(m, "cos-batch"))).toBe("Woke for 1 event · ignored 3 routine moves");
  });

  test("a card opens its ticket", async () => {
    const m = await open();
    await m.until("the cards", () => !!byId(m, "cos-ticket-card"));
    await click(m, all(m.container, '[data-testid="cos-ticket-card"]')[0]!);
    expect(location.hash).toBe("#/board/all/ticket/HARNESS-204");
  });

  test("a card shows the ticket's live status, not the one the entry was written with", async () => {
    const m = await open();
    await m.until("the cards", () => !!byId(m, "cos-ticket-card"));
    const card = all(m.container, '[data-testid="cos-ticket-card"]').find((c) => c.dataset.ticket === "HARNESS-204")!;
    expect(text(card)).toContain("Planning");
    const t = m.client.world.tickets[0]!;
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...t, key: "HARNESS-204", title: "Follow up on the flaky palette test", status: "review", id: "t-204" } }));
    expect(text(all(m.container, '[data-testid="cos-ticket-card"]').find((c) => c.dataset.ticket === "HARNESS-204"))).toContain("Review");
  });

  test("older messages load a page at a time, each once, and the reader stays on what they were reading", async () => {
    const client = new FakeClient();
    client.cos.chat = chat(70);
    const m = await open("#/cos/all", client);
    await m.until("the newest page", () => msgs(m).length === 30);
    expect(msgs(m)[29]).toBe(msgs(m).at(-1)!);
    expect(msgs(m).at(-1)).toContain("msg 70");
    expect(msgs(m)[0]).toContain("msg 41");

    // The scroller has no layout here: stand in for it (1000px high, 1600px once a page is added).
    const scroller = byId(m, "cos-scroll")!;
    let top = 20;
    Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { get: () => (msgs(m).length > 30 ? 1600 : 1000), configurable: true });
    await m.settle(() => void scroller.dispatchEvent(new Event("scroll")));
    await m.until("the second page", () => msgs(m).length === 60);
    expect(top).toBe(620);
    expect(msgs(m)[0]).toContain("msg 11");
    expect(client.requests.filter((r) => r.startsWith("GET /cos/cos-all/transcript"))).toHaveLength(2);

    await click(m, byId(m, "cos-older")!);
    await m.until("the last page", () => msgs(m).length === 70);
    expect(byId(m, "cos-older")).toBeNull();
    expect(new Set(msgs(m)).size).toBe(70);
  });

  test("a live message already in a loaded page isn't shown twice; a new one is added at the bottom", async () => {
    const client = new FakeClient();
    client.cos.chat = chat(5);
    const m = await open("#/cos/all", client);
    await m.until("the chat", () => msgs(m).length === 5);
    const same = client.cos.chat[4]!;
    await m.settle(() => client.push({ kind: "cos.transcript.appended", cosId: "cos-all", entry: same }));
    expect(msgs(m)).toHaveLength(5);
    await m.settle(() => client.push({ kind: "cos.transcript.appended", cosId: "cos-all", entry: { ...same, id: "m999", createdAt: same.createdAt + 1, kind: "message", role: "assistant", text: "fresh" } as CosChatEntry }));
    expect(msgs(m)).toHaveLength(6);
    expect(msgs(m).at(-1)).toContain("fresh");
  });

  test("another chief's live message stays out of this chat", async () => {
    const client = new FakeClient();
    client.cos.chat = chat(2);
    const m = await open("#/cos/all", client);
    await m.until("the chat", () => msgs(m).length === 2);
    await m.settle(() => client.push({ kind: "cos.transcript.appended", cosId: "cos-work", entry: { ...client.cos.chat[0]!, id: "other", cosId: "cos-work" } }));
    expect(msgs(m)).toHaveLength(2);
  });

  test("the composer posts the message, which shows in the chat, and clears", async () => {
    const m = await open();
    await m.until("the chat", () => msgs(m).length > 0);
    const input = byId(m, "cos-composer-input") as HTMLTextAreaElement;
    expect((byId(m, "cos-send") as HTMLButtonElement).disabled).toBe(true);
    await type(m, input, "  How is HARNESS-202 doing?  ");
    await click(m, byId(m, "cos-send")!);
    expect(m.client.bodies.find((b) => b.request === "POST /cos/cos-all/messages")?.body).toEqual({ text: "How is HARNESS-202 doing?" });
    await m.until("the message", () => msgs(m).some((t) => t.includes("How is HARNESS-202 doing?")));
    expect(input.value).toBe("");
  });

  test("a switched-off chief can't be written to", async () => {
    const client = new FakeClient();
    client.cos.chiefs[0]!.enabled = false;
    const m = await open("#/cos/all", client);
    await m.until("the chat", () => msgs(m).length > 0);
    const input = byId(m, "cos-composer-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toContain("Turn the chief of staff on");
  });
});

describe("Inbox", () => {
  const inbox = () => open("#/cos/all/inbox");

  test("lists the chief's events newest first, with their verdicts", async () => {
    const m = await inbox();
    await m.until("the rows", () => events(m).length > 0);
    expect(events(m).map((e) => e.dataset.event)).toEqual(["ev-waiting", "ev-handling", "ev-ignored", "ev-escalated", "ev-handled", "ev-schedule"]);
    expect(events(m).map((e) => e.dataset.state)).toEqual(["waiting", "handling", "ignored", "escalated", "handled", "handled"]);
    const ignored = text(eventRow(m, "ev-ignored"));
    expect(ignored).toContain("Ignored");
    expect(ignored).toContain("Routine move; the agent review is already running");
    expect(text(eventRow(m, "ev-escalated"))).toContain("Watcher");
    expect(text(eventRow(m, "ev-schedule"))).toContain("Schedule");
    expect(text(eventRow(m, "ev-handled"))).toContain("The chief of staff dealt with it");
  });

  test("only ignored rows offer Escalate anyway, and it escalates that one event", async () => {
    const m = await inbox();
    await m.until("the rows", () => events(m).length > 0);
    const withButton = events(m).filter((e) => e.querySelector('[data-testid="cos-escalate"]')).map((e) => e.dataset.event);
    expect(withButton).toEqual(["ev-ignored"]);
    await click(m, eventRow(m, "ev-ignored").querySelector('[data-testid="cos-escalate"]')!);
    expect(m.client.requests).toContain("POST /cos/events/ev-ignored/escalate");
    expect(m.client.requests.filter((r) => r.includes("escalate"))).toHaveLength(1);
    expect(eventRow(m, "ev-ignored").dataset.state).toBe("escalated");
    expect(eventRow(m, "ev-ignored").querySelector('[data-testid="cos-escalate"]')).toBeNull();
  });

  test("a live event updates its row, and a new one appears", async () => {
    const m = await inbox();
    await m.until("the rows", () => events(m).length > 0);
    const waiting = m.client.cos.events.find((e) => e.id === "ev-waiting")!;
    await m.settle(() => m.client.push({ kind: "cos.event.upserted", event: { ...waiting, status: "ignored", verdict: "ignore", reason: "Not worth a wake" } }));
    expect(text(eventRow(m, "ev-waiting"))).toContain("Not worth a wake");
    await m.settle(() => m.client.push({ kind: "cos.event.upserted", event: { ...waiting, id: "ev-new", title: "Brand new", createdAt: waiting.createdAt + 1 } }));
    expect(events(m)[0]!.dataset.event).toBe("ev-new");
    expect(events(m)).toHaveLength(7);
  });

  test("events nobody owns yet show, another chief's and the chief's own filtered ones don't", async () => {
    const client = new FakeClient();
    const base = client.cos.events[0]!;
    client.cos.events.push({ ...base, id: "ev-nobody", cosId: null, title: "Unassigned" }, { ...base, id: "ev-other", cosId: "cos-work", title: "Other chief" }, { ...base, id: "ev-filtered", verdict: "filtered", status: "ignored", title: "Own move" });
    const m = await open("#/cos/all/inbox", client);
    await m.until("the rows", () => events(m).length > 0);
    const ids = events(m).map((e) => e.dataset.event);
    expect(ids).toContain("ev-nobody");
    expect(ids).not.toContain("ev-other");
    expect(ids).not.toContain("ev-filtered");
  });

  test("an empty Inbox says so", async () => {
    const client = new FakeClient();
    client.cos.events = [];
    const m = await open("#/cos/all/inbox", client);
    await m.until("the empty state", () => !!byId(m, "cos-inbox-empty"));
  });

  test("the + asks the chief to listen for something: the text goes to the chief, the prompt closes and the chat is the tab to open", async () => {
    const m = await inbox();
    await m.until("the rows", () => events(m).length > 0);
    await click(m, byId(m, "cos-listen")!);
    const input = byId(m, "cos-listen-input") as HTMLTextAreaElement;
    expect((byId(m, "cos-listen-send") as HTMLButtonElement).disabled).toBe(true);
    await type(m, input, "Listen to GitHub for PR feedback on harness");
    await click(m, byId(m, "cos-listen-send")!);
    expect(m.client.bodies.find((b) => b.request === "POST /cos/cos-all/messages")?.body).toEqual({ text: "Listen to GitHub for PR feedback on harness" });
    expect(paneTab()).toBe("chat");
    expect(byId(m, "cos-listen-input")).toBeNull();
  });
});

describe("the chief's header", () => {
  test("the tab strip is Chat and Inbox, the Inbox carrying the count of events still open", async () => {
    const m = await open();
    await m.until("the tabs", () => all(m.container, '[role="tab"]').length > 0);
    expect(all(m.container, '[role="tab"]').map((t) => t.dataset.tab)).toEqual(["chat", "inbox"]);
    // waiting, handling and escalated; the ignored and handled rows don't count
    await m.until("the badge", () => text(byId(m, "cos-inbox-count")) === "3");
    await m.settle(() => m.client.push({ kind: "cos.badge", total: 1, byCos: { "cos-all": 1 } }));
    expect(text(byId(m, "cos-inbox-count"))).toBe("1");
    await m.settle(() => m.client.push({ kind: "cos.badge", total: 0, byCos: {} }));
    expect(byId(m, "cos-inbox-count")).toBeNull();
  });

  test("the switch turns the chief off and on", async () => {
    const m = await open();
    await m.until("the chat", () => msgs(m).length > 0);
    const sw = m.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(sw.checked).toBe(true);
    await click(m, sw);
    expect(m.client.bodies.find((b) => b.request === "PATCH /cos/cos-all")?.body).toEqual({ enabled: false });
    expect(m.container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
    expect((byId(m, "cos-composer-input") as HTMLTextAreaElement).disabled).toBe(true);
  });

  test("a scope with no chief offers to turn one on, and shows it once it exists", async () => {
    const m = await open("#/cos/group%3Agroup-personal");
    await m.until("the empty state", () => !!byId(m, "cos-none"));
    expect(text(byId(m, "cos-none"))).toContain("Personal");
    await click(m, byId(m, "cos-create")!);
    expect(m.client.bodies.find((b) => b.request === "POST /cos")?.body).toEqual({ scope: "group:group-personal" });
    await m.until("the chat", () => !!byId(m, "cos-chat"));
    expect(text(byId(m, "cos-title"))).toContain("Personal");
  });

  test("the title names the group's chief", async () => {
    const m = await open("#/cos/group%3Agroup-work");
    await m.until("the title", () => text(byId(m, "cos-title")).includes("Work"));
  });

  test("a chief whose triage can't run says every event wakes it", async () => {
    const client = new FakeClient();
    client.cos.chiefs[0]!.triageUnavailable = "No Haiku backend";
    const m = await open("#/cos/all", client);
    await m.until("the note", () => text(m.container).includes("Triage is unavailable (No Haiku backend)"));
  });
});

describe("Memory", () => {
  const openMemory = async (client?: FakeClient) => {
    const m = await open("#/cos/all", client);
    await m.until("the header", () => !!byId(m, "cos-memory-open"));
    await click(m, byId(m, "cos-memory-open")!);
    await m.until("the memory", () => !!byId(m, "cos-memory-text") && (byId(m, "cos-memory-text") as HTMLTextAreaElement).value !== "");
    return m;
  };

  test("shows the document, including its triage guidance, and saves an edit against the revision it opened", async () => {
    const m = await openMemory();
    const area = byId(m, "cos-memory-text") as HTMLTextAreaElement;
    expect(area.value).toContain("## Triage guidance");
    expect((byId(m, "cos-memory-save") as HTMLButtonElement).disabled).toBe(true);
    await type(m, area, area.value + "\n## Preferences\n\nAnswer blocked tickets briefly.\n");
    await click(m, byId(m, "cos-memory-save")!);
    const put = m.client.bodies.find((b) => b.request === "PUT /tickets/COS-1/memory")?.body as { text: string; baseRevision: string };
    expect(put.baseRevision).toBe("rev-1");
    expect(put.text).toContain("Answer blocked tickets briefly.");
    expect(m.client.cos.memory.text).toBe(put.text);
    expect((byId(m, "cos-memory-save") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a memory the chief changed meanwhile asks before overwriting: its version can be loaded", async () => {
    const m = await openMemory();
    const area = byId(m, "cos-memory-text") as HTMLTextAreaElement;
    await type(m, area, "mine");
    m.client.cos.memory = { text: "# Memory\n\nthe chief's version\n", revision: "rev-2" };
    await click(m, byId(m, "cos-memory-save")!);
    expect(byId(m, "cos-memory-conflict")).not.toBeNull();
    expect(m.client.cos.memory.text).toContain("the chief's version");
    await click(m, all(byId(m, "cos-memory-conflict")!, "button").find((b) => text(b) === "Load its version")!);
    expect((byId(m, "cos-memory-text") as HTMLTextAreaElement).value).toContain("the chief's version");
    expect(byId(m, "cos-memory-conflict")).toBeNull();
  });

  test("keeping mine saves over the chief's change against its new revision", async () => {
    const m = await openMemory();
    await type(m, byId(m, "cos-memory-text") as HTMLTextAreaElement, "mine");
    m.client.cos.memory = { text: "theirs", revision: "rev-2" };
    await click(m, byId(m, "cos-memory-save")!);
    await click(m, all(byId(m, "cos-memory-conflict")!, "button").find((b) => text(b) === "Keep mine")!);
    await click(m, byId(m, "cos-memory-save")!);
    const puts = m.client.bodies.filter((b) => b.request === "PUT /tickets/COS-1/memory").map((b) => b.body as { text: string; baseRevision: string });
    expect(puts.at(-1)).toEqual({ text: "mine", baseRevision: "rev-2" });
    expect(m.client.cos.memory.text).toBe("mine");
  });
});

describe("the board's callout", () => {
  const board = (hash = "#/board") => mount(<BoardPane />, { hash });
  const callout = (m: M) => byId(m, "cos-callout")!;
  const sw = (m: M) => callout(m).querySelector<HTMLInputElement>('input[role="switch"]')!;

  test("a card above the columns, not in one, with the count of its open events", async () => {
    updatePanes("*", () => defaultPanes("B"));
    const m = await board();
    await m.until("the callout", () => !!byId(m, "cos-callout-badge"));
    expect(callout(m).dataset.scope).toBe("all");
    expect(text(callout(m))).toContain("All projects");
    expect(callout(m).closest(".column")).toBeNull();
    expect(text(byId(m, "cos-callout-badge"))).toBe("3");
    await m.settle(() => m.client.push({ kind: "cos.badge", total: 5, byCos: { "cos-all": 4, "cos-work": 2 } }));
    expect(text(byId(m, "cos-callout-badge"))).toBe("4");
  });

  test("a group's board shows its group's chief, and a project's board its group's", async () => {
    const group = await board("#/board/group/group-work");
    await group.until("the callout", () => !!byId(group, "cos-callout"));
    expect(callout(group).dataset.scope).toBe("group:group-work");
    const project = world.projects.find((p) => p.groupId === "group-work")!;
    const m = await board(`#/board/${project.id}`);
    await m.until("the callout", () => !!byId(m, "cos-callout"));
    expect(callout(m).dataset.scope).toBe("group:group-work");
  });

  test("the card opens the chief's pane beside the board, focused", async () => {
    updatePanes("*", () => defaultPanes("B"));
    const m = await board();
    await m.until("the callout", () => !!byId(m, "cos-callout-open"));
    await click(m, byId(m, "cos-callout-open")!);
    const cos = leaves(getPanes("*").root).find((l) => l.content.kind === "cos");
    expect(cos?.content).toEqual({ kind: "cos", scope: "all", tab: "chat" });
    expect(getPanes("*").focusedId).toBe(cos!.id);
    expect(m.client.requests).not.toContain("POST /cos");
  });

  test("a group without a chief gets one made on first open", async () => {
    updatePanes("*", () => defaultPanes("B"));
    const m = await board("#/board/group/group-personal");
    await m.until("the callout", () => !!byId(m, "cos-callout-open"));
    await click(m, byId(m, "cos-callout-open")!);
    expect(m.client.bodies.find((b) => b.request === "POST /cos")?.body).toEqual({ scope: "group:group-personal" });
    expect(leaves(getPanes("*").root).some((l) => l.content.kind === "cos" && l.content.scope === "group:group-personal")).toBe(true);
  });

  test("the switch turns the chief off, or turns a group's on by making one", async () => {
    updatePanes("*", () => defaultPanes("B"));
    const m = await board();
    await m.until("the callout", () => !!byId(m, "cos-callout"));
    expect(sw(m).checked).toBe(true);
    await click(m, sw(m));
    expect(m.client.bodies.find((b) => b.request === "PATCH /cos/cos-all")?.body).toEqual({ enabled: false });
    expect(sw(m).checked).toBe(false);
    const g = await board("#/board/group/group-personal");
    await g.until("the callout", () => !!byId(g, "cos-callout"));
    expect(sw(g).checked).toBe(false);
    await click(g, sw(g));
    expect(g.client.bodies.find((b) => b.request === "POST /cos")?.body).toEqual({ scope: "group:group-personal" });
    expect(sw(g).checked).toBe(true);
  });
});

describe("the sidebar", () => {
  test("has no chief of staff rows", async () => {
    const { Sidebar } = await import("../../app/src/renderer/views/Sidebar");
    const m = await mount(<Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />);
    await m.until("the sidebar", () => all(m.container, ".nav-item").length > 0);
    expect(all(m.container, '[data-testid="nav-cos"]')).toHaveLength(0);
    expect(all(m.container, ".nav-item").some((e) => /Chief|Inbox/.test(text(e)))).toBe(false);
  });
});

describe("settings", () => {
  const patched = (m: M, request: string) => m.client.bodies.filter((b) => b.request === request).map((b) => b.body);

  test("the app's two switches show the service's values (enabled by default, unblocking off) and save", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    m.client.overrides.set("PATCH /settings", () => m.client.world.settings);
    await m.until("the section", () => text(m.container).includes("Chief of staff enabled"));
    const sw = (label: string) => m.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    expect(sw("Chief of staff enabled").checked).toBe(true);
    expect(sw("Chief of staff can unblock tickets").checked).toBe(false);
    await click(m, sw("Chief of staff can unblock tickets"));
    await click(m, sw("Chief of staff enabled"));
    expect(patched(m, "PATCH /settings")).toEqual([{ cosCanUnblock: true }, { cosEnabled: false }]);
  });

  test("the watcher forms are gone from Settings", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.until("the page", () => text(m.container).includes("Chief of staff"));
    expect(text(m.container)).not.toContain("Watchers");
    expect(all(m.container, '[data-testid="watcher-defaults"], [data-testid="watcher-model"]')).toEqual([]);
    expect(m.client.unrouted).toEqual([]);
  });

  test("a project inherits the app's value until it overrides it, and can go back to inheriting", async () => {
    const id = world.projects[0]!.id;
    const w = edited((x) => void (x.settings.cosEnabled = false));
    const m = await mount(<ProjectSettingsView />, { hash: `#/project/${id}/settings`, world: w });
    m.client.overrides.set(`PATCH /projects/${id}`, () => m.client.world.projects[0]);
    await m.until("the page", () => !!byId(m, "project-cosEnabled"));
    const sel = (key: string) => byId(m, `project-${key}`) as unknown as HTMLSelectElement;
    expect(sel("cosEnabled").value).toBe("inherit");
    expect(all(sel("cosEnabled"), "option").map((o) => text(o))).toEqual(["Inherit (off)", "On", "Off"]);
    expect(all(sel("cosCanUnblock"), "option")[0]!.textContent).toBe("Inherit (off)");

    const choose = (s: HTMLSelectElement, v: string) =>
      m.settle(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, v);
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await choose(sel("cosEnabled"), "on");
    await choose(sel("cosCanUnblock"), "off");
    await choose(sel("cosEnabled"), "inherit");
    expect(patched(m, `PATCH /projects/${id}`)).toEqual([{ cosEnabled: true }, { cosCanUnblock: false }, { cosEnabled: null }]);
  });

  test("a project's override shows as selected", async () => {
    const id = world.projects[0]!.id;
    const w = edited((x) => void (x.projects[0]!.cosCanUnblock = true));
    const m = await mount(<ProjectSettingsView />, { hash: `#/project/${id}/settings`, world: w });
    await m.until("the page", () => !!byId(m, "project-cosCanUnblock"));
    expect((byId(m, "project-cosCanUnblock") as unknown as HTMLSelectElement).value).toBe("on");
    expect((byId(m, "project-cosEnabled") as unknown as HTMLSelectElement).value).toBe("inherit");
  });
});
