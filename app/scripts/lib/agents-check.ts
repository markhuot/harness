// Sub-agents end-to-end: a dummy `/agents 3` ticket runs two sub-agents, the second starting a
// nested third. The ticket's Agents & tasks tab lists them live, a row opens that sub-agent's
// transcript (with its breadcrumb), and the session transcript's Agent rows link to theirs. Then a
// `/bgtask` ticket's background Bash command: its row, its output growing live, and its link.
// Used by scripts/real-service.ts and scripts/agents.ts.
import type { Project, Subagent, TaskOutput, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { until, type launchApp } from "./drive";

type App = Awaited<ReturnType<typeof launchApp>>;
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

export async function checkAgentsTab({ api, app, check, shot, project }: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; project: Project }) {
  const { js, exists, go } = app;
  // A session without sub-agents has no Agents tab, even when a link asks for it.
  const plain = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "No helpers needed", driver: "dummy", start: true });
  await until("plain ticket settles", async () => !(await api<TicketDetail>("GET", `/tickets/${plain.key}`)).ticket.busy, 20000);
  await go(`#/board/${project.id}/ticket/${plain.key}/agents`);
  await until("plain ticket pane", () => exists('.tab[data-tab="spec"]'));
  await Bun.sleep(500);
  check("no Agents tab on a session without sub-agents", !(await exists('.tab[data-tab="agents"]')));
  check("a link to its Agents tab shows the Spec instead", (await exists('.tab.on[data-tab="spec"]')) && !(await exists(".agents-tab")));

  const t = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Split this up /agents 3", driver: "dummy", start: true });
  await go(`#/board/${project.id}/ticket/${t.key}/spec`);

  // The tab appears once the session has a sub-agent, with a live dot while one runs.
  const live = await until("Agents tab with a running sub-agent", () => js<boolean>(`!!document.querySelector('.tab[data-tab="agents"] .live-dot')`), 20000);
  check("Agents tab appears (live) while a sub-agent runs", live);
  await js(`document.querySelector('.tab[data-tab="agents"]').click()`);
  await until("agent rows", () => exists(".agent-row"));
  check("a running sub-agent is listed as running", await exists('.agent-row[data-kind="agent"][data-status="running"]'));
  check("one list, no Running / Finished sections", !(await exists(".agents-tab .children-group")));
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
    const r = await js<string[]>(`[...document.querySelectorAll('.agent-row')].map(e => e.dataset.status + ":" + e.querySelector(".child-title").textContent)`);
    return r.length === 3 && r.every((x) => x.startsWith("succeeded:")) ? r : null;
  });
  check("the Agents tab lists all three as done, live", rows.length === 3, rows.join(" | "));
  const order = await js<string[]>(`[...document.querySelectorAll('.agent-row')].map(e => e.dataset.agent)`);
  const latest = [...subs].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt).map((s) => s.id);
  check("the list puts the latest updated first", order.join() === latest.join(), order.join());
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
  check("the breadcrumb goes through its parent", crumbs.includes("Agents & tasks") && crumbs.includes("Sub-task 2"), crumbs);
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

  await checkBackgroundTask({ api, app, check, shot, project });
}

/** `/bgtask 8`: a background Bash command writing a line every 20 dummy delays, then finishing. */
async function checkBackgroundTask({ api, app, check, shot, project }: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; project: Project }) {
  const { js, exists, go } = app;
  const lines = 8;
  const t = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `Count in the background /bgtask ${lines}`, driver: "dummy", start: true });
  await go(`#/board/${project.id}/ticket/${t.key}/spec`);

  const live = await until("Agents & tasks tab with a running task", () => js<boolean>(`!!document.querySelector('.tab[data-tab="agents"] .live-dot')`), 20000);
  check("the tab appears (live) while a background task runs", live);
  check("the tab is called Agents & tasks", (await js<string>(`document.querySelector('.tab[data-tab="agents"]').firstChild.textContent`)) === "Agents & tasks");
  await js(`document.querySelector('.tab[data-tab="agents"]').click()`);
  const row = await until("running task row", () => js<{ id: string; chip: string; title: string } | null>(`(() => {
    const r = document.querySelector('.agent-row[data-kind="bash"][data-status="running"]');
    return r && { id: r.dataset.agent, chip: r.querySelector(".badge")?.textContent ?? "", title: r.querySelector(".child-title").textContent };
  })()`));
  check("the task row shows a Bash chip and its description", row.chip === "Bash" && row.title === `Count to ${lines}`, `${row.chip} · ${row.title}`);
  check("the row shows the command under the title", (await js<string>(`document.querySelector('.agent-row[data-agent="${row.id}"] .child-summary')?.textContent ?? ""`)).includes(`seq ${lines}`));
  await shot("tasks-1-list-running");

  // Its output view: the command, then the output growing while it runs.
  await js(`document.querySelector('.agent-row[data-agent="${row.id}"]').click()`);
  await until("task view", () => exists(".task-view"));
  check("the route addresses the task", (await js<string>(`location.hash`)).endsWith(`/agent:${row.id}`));
  check("the back crumb says Agents & tasks", (await js<string>(`document.querySelector(".task-view .agent-crumbs")?.textContent ?? ""`)).trim() === "Agents & tasks");
  check("the view shows the command", (await js<string>(`document.querySelector(".task-command")?.textContent ?? ""`)).includes(`seq ${lines}`));
  const outLines = () => js<string[]>(`(document.querySelector(".task-output-text")?.textContent ?? "").split("\\n").filter(Boolean)`);
  const first = await until("some output", async () => {
    const l = await outLines();
    return l.length > 0 && l.length < lines ? l : null;
  }, 20000);
  const grown = await until("the output grows", async () => {
    const l = await outLines();
    return l.length > first.length ? l : null;
  }, 10000);
  const stillRunning = await exists('.task-view .agent-title .spinner');
  check("the output grows while the task runs", stillRunning && grown.length > first.length, `${first.length} → ${grown.length} lines`);
  await shot("tasks-2-output-running");

  await until("task done", () => exists('.task-view .agent-status[data-status="succeeded"]'), 30000);
  const done = await until("all the output", async () => {
    const l = await outLines();
    return l.length === lines ? l : null;
  }, 5000);
  check("when it's done the whole output stays", done[0] === "line 1" && done[lines - 1] === `line ${lines}`, done.join(" | "));
  check("the output has no ANSI escapes", !done.some((l) => l.includes("\u001b") || l.includes("[32m")));
  check("the result shows under the output", (await js<string>(`document.querySelector(".task-result")?.textContent ?? ""`)).includes("completed (exit code 0)"));
  const pinned = await js<boolean>(`(() => { const el = document.querySelector(".task-output"); return el.scrollHeight - el.clientHeight - el.scrollTop < 4; })()`);
  check("the output pane sits at the bottom", pinned);
  await shot("tasks-3-output-done");

  await js(`document.querySelector('.task-view [data-testid="agents-back"]').click()`);
  await until("back to the list", () => exists(`.agent-row[data-agent="${row.id}"][data-status="succeeded"]`));
  await shot("tasks-4-list-done");

  // The transcript's Bash row links to the output.
  await go(`#/board/${project.id}/ticket/${t.key}/transcript`);
  const link = await until("Open output link", () => js<string | null>(`document.querySelector('.t-tool-agent[data-agent="${row.id}"] .btn')?.textContent ?? null`));
  check("the transcript's Bash row links to its output", link.trim() === "Open output", link);
  await js(`document.querySelector('.t-tool-agent[data-agent="${row.id}"] .btn').click()`);
  const opened = await until("task view from the transcript", () => exists(".task-view .task-output-text"));
  check("Open output opens the task's output", opened && (await js<string>(`location.hash`)).endsWith(`/agent:${row.id}`));

  const served = await api<TaskOutput>("GET", `/sessions/${t.sessionId}/subagents/${encodeURIComponent(row.id)}/output`);
  check("the API serves the task's output", served.done && served.text.includes(`line ${lines}`));

  await checkLongList({ api, app, check, shot, project, ticket: t });
}

/**
 * A long session: three more `/agents 5` turns on the task's ticket make 16 rows (15 agents, one
 * task), more than the pane holds. The list scrolls under its filter, and the filter's Agents and
 * Tasks toggles narrow it (both or neither: everything).
 */
async function checkLongList({ api, app, check, shot, project, ticket: t }: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; project: Project; ticket: Ticket }) {
  const { js, exists, go } = app;
  const settled = () => until("ticket settles", async () => !(await api<TicketDetail>("GET", `/tickets/${t.key}`)).ticket.busy, 30000);
  await settled();
  for (let i = 1; i <= 3; i++) {
    await api("POST", `/tickets/${t.key}/messages`, { text: "/agents 5", move: true });
    await until(`${1 + i * 5} sub-agents and tasks`, async () => ((await api<TicketDetail>("GET", `/tickets/${t.key}`)).subagents?.length ?? 0) >= 1 + i * 5, 30000);
    await settled();
  }
  await go(`#/board/${project.id}/ticket/${t.key}/agents`);
  const rowCount = () => js<number>(`document.querySelectorAll(".agents-scroll .agent-row").length`);
  await until("16 rows", async () => ((await rowCount()) === 16 ? true : null), 10000);
  check("the long list has every row", (await rowCount()) === 16);

  // It scrolls, and its last row comes into view; the filter stays put above it.
  const scroll = await js<{ overflows: boolean; lastVisible: boolean; filterVisible: boolean }>(`(() => {
    const s = document.querySelector(".agents-scroll");
    const overflows = s.scrollHeight > s.clientHeight + 4;
    s.scrollTop = s.scrollHeight;
    const box = s.getBoundingClientRect();
    const last = [...s.querySelectorAll(".agent-row")].at(-1).getBoundingClientRect();
    const filter = document.querySelector(".agents-filter").getBoundingClientRect();
    return { overflows, lastVisible: last.bottom <= box.bottom + 1 && last.top >= box.top, filterVisible: filter.bottom <= box.top + 1 && filter.height > 0 };
  })()`);
  check("a list longer than the pane overflows its scroller", scroll.overflows);
  check("scrolled to the end, the last row is in view", scroll.lastVisible);
  check("the filter stays above the scrolled list", scroll.filterVisible);
  await shot("tasks-5-long-list-scrolled");

  const state = () =>
    js<{ pressed: string[]; kinds: string[]; counts: string[] }>(`({
      pressed: [...document.querySelectorAll('.agents-filter button[aria-pressed="true"]')].map(b => b.dataset.filter),
      kinds: [...new Set([...document.querySelectorAll(".agents-scroll .agent-row")].map(r => r.dataset.kind))].sort(),
      counts: [...document.querySelectorAll(".agents-filter .count")].map(c => c.textContent),
    })`);
  const toggle = (k: "agents" | "tasks") => js(`document.querySelector('.agents-filter [data-filter="${k}"]').click()`);
  const s0 = await state();
  check("the filter counts agents and tasks, nothing pressed", s0.counts.join() === "15,1" && s0.pressed.length === 0 && s0.kinds.join() === "agent,bash", JSON.stringify(s0));
  await toggle("tasks");
  const s1 = await state();
  check("Tasks alone shows only the task", s1.pressed.join() === "tasks" && s1.kinds.join() === "bash" && (await rowCount()) === 1, JSON.stringify(s1));
  await shot("tasks-6-filter-tasks");
  await toggle("agents");
  const s2 = await state();
  check("Agents and Tasks together show everything", s2.pressed.join() === "agents,tasks" && (await rowCount()) === 16, JSON.stringify(s2));
  await toggle("tasks");
  const s3 = await state();
  check("Agents alone shows only agents", s3.pressed.join() === "agents" && s3.kinds.join() === "agent" && (await rowCount()) === 15, JSON.stringify(s3));

  // The filter survives opening a row and coming back.
  await js(`document.querySelector(".agents-scroll .agent-row").click()`);
  await until("an agent's view", () => exists(".agent-view"));
  await js(`document.querySelector('[data-testid="agents-back"]').click()`);
  await until("back to the list", () => exists(".agents-scroll .agent-row"));
  check("the filter is still on Agents after opening one and coming back", (await state()).pressed.join() === "agents" && (await rowCount()) === 15);

  await toggle("agents");
  check("with neither pressed, everything shows again", (await state()).pressed.length === 0 && (await rowCount()) === 16);
}
