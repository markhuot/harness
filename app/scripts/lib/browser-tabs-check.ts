// Browser tabs end-to-end against real headless Chrome: a dummy ticket's agent opens three pages,
// two of them with new_tab, through the real browser tools. The Browser tab's strip must show all
// three, clicking one must switch the screencast to it, and closing the watched tab must fall back.
// Used by scripts/real-service.ts and scripts/browser-tabs.ts.
import type { Project, Ticket, TranscriptEntry } from "@harness/shared";
import { until, type launchApp } from "./drive";

type App = Awaited<ReturnType<typeof launchApp>>;
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

/** A page that fills the viewport with one colour, so the canvas tells which tab it shows. */
const page = (title: string, colour: string) =>
  `data:text/html,<title>${title}</title><body style="margin:0;height:100vh;background:${encodeURIComponent(colour)}"><h1>${title}</h1></body>`;

export async function checkBrowserTabs(opts: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; project: Project }) {
  const { api, app, check, shot, project } = opts;
  const { js, go } = app;
  const calls = [
    { name: "browser_open", input: { url: page("Alpha", "#c33") } },
    { name: "browser_open", input: { url: page("Beta", "#3c3"), new_tab: true } },
    { name: "browser_open", input: { url: page("Gamma", "#33c"), new_tab: true } },
    { name: "browser_eval", input: { expression: "document.title", tab: 2 } },
  ];
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `/tools ${JSON.stringify(calls)}`, driver: "dummy", start: true });
  await go(`#/board/${project.id}/ticket/${ticket.key}/browser`);

  const chips = () => js<string[]>(`[...document.querySelectorAll(".browser-tab-select")].map(e => e.textContent.trim())`);
  const chipsAre = (want: string) => until(`tab chips ${want}`, async () => (await chips()).join("|") === want, 30000).catch(() => false);
  // The colour right of the canvas's middle says which tab is drawn (the tab keeps its own 1280 × 800,
  // letterboxed into the pane, so a corner may be outside the frame).
  const tint = () =>
    js<string>(`(() => { const c = document.querySelector(".browser-canvas"); if (!c || !c.width) return "";
      const d = c.getContext("2d").getImageData(Math.floor(c.width * 0.7), Math.floor(c.height * 0.5), 1, 1).data;
      return d[0] > 150 && d[1] < 100 ? "red" : d[1] > 150 && d[0] < 100 ? "green" : d[2] > 150 && d[0] < 100 ? "blue" : ""; })()`);
  const drawn = (colour: string) => until(`a ${colour} frame`, async () => (await tint()) === colour, 15000).catch(() => false);

  check("the agent's three tabs show in the strip", await chipsAre("Alpha|Beta|Gamma"), (await chips()).join("|"));
  const results = (await api<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=0`))
    .filter((e) => e.content.type === "tool_result")
    .map((e) => JSON.stringify(e.content))
    .join(" ");
  check("new_tab results name tabs 2 and 3, and tab 2 reads its own page", /in tab 2/.test(results) && /in tab 3/.test(results) && /\\"Beta\\"/.test(results), results.slice(0, 400));
  check("the viewer starts on tab 1 (red)", await drawn("red"), await tint());

  await js(`[...document.querySelectorAll(".browser-tab-select")].find(e => e.textContent.includes("Gamma"))?.click()`);
  check("clicking Gamma switches the screencast to it (blue)", await drawn("blue"), await tint());
  check("the URL field follows the tab", (await js<string>(`document.querySelector(".browser-url-input")?.value ?? ""`)).includes("Gamma"));
  await shot("6b-browser-tabs");

  await js(`[...document.querySelectorAll(".browser-tab")].find(e => e.textContent.includes("Gamma"))?.querySelector(".browser-tab-close")?.click()`);
  check("closing the watched tab removes its chip", await chipsAre("Alpha|Beta"), (await chips()).join("|"));
  check("and the viewer falls back to tab 1 (red)", await drawn("red"), await tint());
  const state = await api<{ tabs?: { id: number }[] } | null>("GET", `/browser/${ticket.sessionId}`);
  check("the service agrees: tabs 1 and 2 remain", JSON.stringify(state?.tabs?.map((t) => t.id)) === "[1,2]", JSON.stringify(state?.tabs));
}
