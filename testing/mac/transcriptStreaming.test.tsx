// A streamed token re-renders only the live preview: the transcript's rows, and the markdown in
// them, are left alone however long the transcript is (a long one used to cost every row per token).
import { describe, expect, mock, test } from "bun:test";
import * as shared from "@harness/shared/state";

// Count Markdown's inline tokenizing: every rendered paragraph, heading and list item runs it.
let tokenized = 0;
const realInline = shared.inlineTokens;
mock.module("@harness/shared/state", () => ({ ...shared, inlineTokens: (text: string) => (tokenized++, realInline(text)) }));

const { TicketDetail } = await import("../../app/src/renderer/views/TicketDetail");
const { world } = await import("../world");
const { all, edited, mount, text } = await import("./render");

const S2 = "session-HARNESS-2";
const RUN = "run-HARNESS-2-work";

const longTranscript = edited((w) => {
  const base = w.transcript.find((e) => e.id === "tr-4")!;
  for (let i = 0; i < 40; i++) {
    w.transcript.push({ ...base, id: `long-t${i}`, seq: 100 + i * 3, role: "assistant", content: { type: "text", text: `Step ${i}: see HARNESS-5 and \`file${i}.ts\`.\n\n- one\n- two` } });
    w.transcript.push({ ...base, id: `long-c${i}`, seq: 101 + i * 3, content: { type: "tool_call", callId: `long-${i}`, name: "Bash", input: { command: `bun test ${i}` } } });
    w.transcript.push({ ...base, id: `long-r${i}`, seq: 102 + i * 3, content: { type: "tool_result", callId: `long-${i}`, name: "Bash", output: [{ type: "text", text: "ok" }], isError: false } });
  }
});

const delta = (text: string) => ({ kind: "transcript.delta" as const, sessionId: S2, runId: RUN, text });

describe("Transcript while an agent streams", () => {
  test("a streamed token renders no transcript row's markdown again, and the preview shows the text so far", async () => {
    const m = await mount(<TicketDetail paneId="p1" ticketKey="HARNESS-2" tab="transcript" zoomed={false} />, { world: longTranscript });
    await m.until("the long transcript", () => text(m.container).includes("Step 39"));
    await m.settle(() => m.client.push(delta("Looking ")));
    tokenized = 0;
    for (const word of ["at ", "the ", "socket"]) await m.settle(() => m.client.push(delta(word)));
    expect(text(all(m.container, ".streaming")[0])).toContain("Looking at the socket");
    expect(tokenized).toBe(0);
  });

  test("a new entry renders its own markdown, not every earlier row's", async () => {
    const m = await mount(<TicketDetail paneId="p1" ticketKey="HARNESS-2" tab="transcript" zoomed={false} />, { world: longTranscript });
    await m.until("the long transcript", () => text(m.container).includes("Step 39"));
    tokenized = 0;
    await m.settle(() =>
      m.client.push({ kind: "transcript.appended", entry: { id: "long-new", sessionId: S2, runId: RUN, seq: 1000, role: "assistant", content: { type: "text", text: "Fixed the reconnect." }, createdAt: world.now } }),
    );
    expect(text(m.container)).toContain("Fixed the reconnect.");
    // The new entry's one paragraph, tokenized to find its media and again to render it. The 40
    // earlier entries (three blocks each) stay as they were.
    expect(tokenized).toBe(2);
  });

  test("a ticket's markdown links still follow the ticket's title when it changes", async () => {
    const m = await mount(<TicketDetail paneId="p1" ticketKey="HARNESS-2" tab="transcript" zoomed={false} />, { world: longTranscript });
    await m.until("the long transcript", () => text(m.container).includes("Step 39"));
    const link = () => all(m.container, 'a[data-ticket-key="HARNESS-5"]')[0];
    expect(link()).toBeDefined();
    const t = world.tickets.find((x) => x.key === "HARNESS-5")!;
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...t, title: "Renamed for the test" } }));
    expect(link()!.getAttribute("title")).toBe("Renamed for the test");
  });
});
