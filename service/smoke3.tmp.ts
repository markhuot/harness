import { HarnessClient } from "@harness/shared";
const c = new HarnessClient({ baseUrl: "http://127.0.0.1:7797", token: process.env.TOK! });
console.log(JSON.stringify(await c.getSettings()));
await c.updateSettings({ claudeModel: "haiku" });
const p = await c.createProject({ path: process.env.DIR! });
const t = await c.createTicket({ projectId: p.id, spec: "hello world", driver: "claude-code", start: true });
let d:any;
const wait = async (f:(t:any)=>boolean) => { for (let i = 0; i < 240; i++) { await Bun.sleep(1000); d = await c.getTicket(t.key); if (f(d.ticket)) return; } };
await wait(t => (t.status==="review" && t.agentReview!=="pending" && !t.busy) || t.status==="blocked");
console.log(d.ticket.status, d.ticket.agentReview, d.ticket.blockedReason);
if (d.ticket.status==="review") { await c.humanReview(t.key, { decision: "approve" }); await c.completeTicket(t.key); await wait(t => (t.status==="done"||t.status==="blocked") && !t.busy); }
console.log("final", d.ticket.status); console.log(d.activity.map((s:any)=>`${s.kind} ${s.author}: ${s.body}`).join("\n---\n"));
