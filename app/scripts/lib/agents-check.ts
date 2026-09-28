// Sub-agents end-to-end: a dummy `/agents 3` ticket runs two sub-agents, the second starting a
// nested third. The ticket's Agents tab lists them live, a row opens that sub-agent's transcript
// (with its breadcrumb), and the session transcript's Agent rows link to theirs.
// Used by scripts/real-service.ts and scripts/agents.ts.
import type { Project, Subagent, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { until, type launchApp } from "./drive";

type App = Awaited<ReturnType<typeof launchApp>>;
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

export async function checkAgentsTab({ api, app, check, shot, project }: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; project: Project }) {
  const { js, exists, go } = app;
  const t = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: "Split this up /agents 3", driver: "dummy", start: true });
  await go(`#/board/${project.id}/ticket/${t.key}/summaries`);

  // The tab appears once the session has a sub-agent, with a live dot while one runs.
  const live = await until("Agents tab with a running sub-agent", () => js<boolean>(`!!document.querySelector('.tab[data-tab="agents"] .live-dot')`), 20000);
  check("Agents tab appears (live) while a sub-agent runs", live);
  await js(`document.querySelector('.tab[data-tab="agents"]').click()`);
  await until("agent rows", () => exists(".agent-row"));
  check("a running sub-agent sits under Running", await exists('[data-group="running"] .agent-row[data-status="running"]'));
  await shot("agents-1-running");

  const detail = await until(
    "sub-agents finished",
    async () => {
      const d = await api<TicketDetail>("GET", `/tickets/${t.key}`);
      return d.subagents?.length === 3 && d.subagents.every((s) => s.status === "succeeded") ? d : null;
    },
    30000,
  );
  const subs = detail.subagents as Subagent[];
  const nested = subs.find((s) => s.parentId)!;
  check("the service recorded three sub-agents, one nested", !!nested && subs.filter((s) => !s.parentId).length === 2, subs.map((s) => `${s.description}<${s.parentId ?? "-"}>`).join(", "));

  const rows = await until("three finished rows", async () => {
    const r = await js<string[]>(`[...document.querySelectorAll('[data-group="finished"] .agent-row')].map(e => e.dataset.status + ":" + e.querySelector(".child-title").textContent)`);
    return r.length === 3 ? r : null;
  });
  check("the Agents tab lists all three as done, live", rows.every((r) => r.startsWith("succeeded:")), rows.join(" | "));
  check("the tab counts them", (await js<string>(`document.querySelector('.tab[data-tab="agents"] .count')?.textContent ?? ""`)) === "3");
  check("the nested one says who started it", (await js<string>(`document.querySelector('.agent-row[data-agent="${nested.id}"] .agent-via')?.textContent ?? ""`)).includes("Sub-task 2"));
  await shot("agents-2-list");

  // Open the nested sub-agent: its transcript, the breadcrumb, the URL.
  await js(`document.querySelector('.agent-row[data-agent="${nested.id}"]').click()`);
  const sub = await until("sub-agent transcript", async () => {
    const text = await js<string>(`document.querySelector(".agent-view .transcript")?.textContent ?? ""`);
    return text.includes("Sub-task 3 is done.") ? text : null;
  });
  check("the sub-agent's transcript shows its own output", sub.includes("Looking into sub-task 3") && !sub.includes("Hello from the dummy driver"));
  check("its tool calls render", (await js<string[]>(`[...document.querySelectorAll(".agent-view .t-tool-name")].map(e => e.textContent)`)).includes("Read"));
  check("the route addresses the sub-agent", (await js<string>(`location.hash`)).endsWith(`/agent:${nested.id}`));
  check("the Agents tab stays highlighted", await exists('.tab.on[data-tab="agents"]'));
  const crumbs = await js<string>(`document.querySelector(".agent-crumbs")?.textContent ?? ""`);
  check("the breadcrumb goes through its parent", crumbs.includes("Agents") && crumbs.includes("Sub-task 2"), crumbs);
  await js(`document.querySelector(".agent-prompt-toggle").click()`);
  await shot("agents-3-subagent");

  // The parent's transcript links to the nested agent through its Agent row.
  await js(`[...document.querySelectorAll(".agent-crumbs .link")].find(b => b.textContent.includes("Sub-task 2")).click()`);
  await until("parent sub-agent open", () => js<boolean>(`location.hash.endsWith("/agent:${nested.parentId}")`));
  const link = await until("nested agent link in parent transcript", () => exists(`.agent-view .t-tool-agent[data-agent="${nested.id}"]`));
  check("a sub-agent's transcript links to the agent it started", link);

  // The session transcript: no sub-agent output, and Agent rows link out.
  await go(`#/board/${project.id}/ticket/${t.key}/transcript`);
  const main = await until("session transcript", async () => {
    const text = await js<string>(`document.querySelector(".transcript")?.textContent ?? ""`);
    return text.includes("sub-agents finished") ? text : null;
  });
  check("the session transcript leaves sub-agent output out", !main.includes("Looking into sub-task"));
  const links = await js<string[]>(`[...document.querySelectorAll(".t-tool-agent")].map(e => e.dataset.agent)`);
  check("each top-level Agent call links to its sub-agent", links.length === 2 && !links.includes(nested.id), links.join(","));
  await shot("agents-4-transcript");
  await js(`document.querySelector(".t-tool-agent .btn").click()`);
  const opened = await until("opened from transcript", () => js<string>(`location.hash`).then((h) => (h.includes("/agent:") ? h : null)));
  check("Open transcript goes to the sub-agent", opened.endsWith(`/agent:${links[0]}`));

  const api404 = await api<TranscriptEntry[]>("GET", `/sessions/${t.sessionId}/transcript?after=0&subagent=${encodeURIComponent(nested.id)}`);
  check("the API serves the sub-agent's transcript", api404.length > 0 && api404.every((e) => e.subagentId === nested.id));
}
