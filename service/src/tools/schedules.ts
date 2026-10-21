// A chief of staff's schedules (DESIGN.md "Schedules"): reminders for the human and wake-ups for itself.

import { SCHEDULE_MAX_ACTIVE, SCHEDULE_MIN_INTERVAL_MS, type Schedule } from "@harness/shared";
import { describeSpec, describeTime } from "../cos/schedule-time";
import { defineTool, schema } from "./util";

/** One schedule as the tools show it. */
const view = (s: Schedule) => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  ...(s.message ? { message: s.message } : {}),
  when: describeSpec(s.spec),
  ...(s.projectKey ? { project: s.projectKey } : {}),
  status: s.status,
  next: s.nextFireAt ? describeTime(s.nextFireAt) : null,
  ...(s.lastFireAt ? { last: `${describeTime(s.lastFireAt)} (${s.lastOutcome})` } : {}),
});

export const scheduleCreate = defineTool<{ kind: "reminder" | "wake"; title: string; message?: string; at?: string; every_minutes?: number; cron?: string; project_key?: string }>({
  name: "schedule_create",
  description: `Schedule something for later, in the Mac's timezone. kind "reminder" posts a notification to the human at that time and starts no run ("remind me to deploy X on Friday morning"); kind "wake" wakes YOU then, as an event with your message in it ("check the board every weekday at 9"): you are woken only if you are switched on, and a wake that comes due while you are off is skipped, not saved. Give exactly one of: at (once; an ISO 8601 date-time such as "2026-10-23T09:00", the Mac's local time without an offset, in the future), every_minutes (repeating, at least ${SCHEDULE_MIN_INTERVAL_MS / 60_000}), or cron (repeating; 5 fields "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1-5", never more often than every ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes). A wake with no project_key is yours to place: say in its message which project it is about. A schedule that comes due while the Mac slept or the service was down fires once when it is back, not once per missed time; a one-shot more than a day late is dropped. You can have ${SCHEDULE_MAX_ACTIVE} active schedules; write the message so you can act on it without remembering why you set it.`,
  inputSchema: schema(
    {
      kind: { type: "string", enum: ["reminder", "wake"], description: "reminder: notify the human, no run. wake: wake you with the message." },
      title: { type: "string", minLength: 1, description: "A short label, shown in the notification or event title and in schedule_list." },
      message: { type: "string", description: "What the reminder says, or what to do when woken." },
      at: { type: "string", description: 'Once, at this ISO 8601 date-time, e.g. "2026-10-23T09:00" (Mac local time without an offset).' },
      every_minutes: { type: "number", minimum: SCHEDULE_MIN_INTERVAL_MS / 60_000, description: "Repeat every this many minutes." },
      cron: { type: "string", minLength: 1, description: 'Repeat on a 5-field cron expression in the Mac\'s timezone, e.g. "0 9 * * 1-5".' },
      project_key: { type: "string", minLength: 1, description: "The project it is about, e.g. \"SHOP\"; one you cover." },
    },
    ["kind", "title"],
  ),
  async run(input, ctx) {
    const s = await ctx.ops.scheduleCreate(ctx, {
      kind: input.kind,
      title: input.title,
      message: input.message ?? "",
      at: input.at,
      everyMinutes: input.every_minutes,
      cron: input.cron,
      projectKey: input.project_key,
    });
    return `Scheduled ${s.kind} ${s.id}: ${describeSpec(s.spec)}; next fire ${describeTime(s.nextFireAt!)}.`;
  },
});

export const scheduleList = defineTool<{ include_finished?: boolean }>({
  name: "schedule_list",
  description:
    "List your schedules, soonest first: id, kind, when, the next fire and what the last one did. Only active ones unless include_finished is true (then also the one-shots that ran, were missed or were cancelled). You see only your own.",
  inputSchema: schema({ include_finished: { type: "boolean", description: "Also schedules that are done, missed or cancelled. Default false." } }),
  async run(input, ctx) {
    const list = await ctx.ops.scheduleList(ctx, { all: input.include_finished ?? false });
    return list.length ? JSON.stringify(list.map(view), null, 2) : "No schedules.";
  },
});

export const scheduleCancel = defineTool<{ id: string }>({
  name: "schedule_cancel",
  description: "Cancel one of your active schedules by id (from schedule_list or schedule_create). It never fires again. You can't cancel another chief's.",
  inputSchema: schema({ id: { type: "string", minLength: 1, description: "The schedule's id." } }, ["id"]),
  async run({ id }, ctx) {
    const s = await ctx.ops.scheduleCancel(ctx, id);
    return `Cancelled "${s.title}" (${s.id}).`;
  },
});

export const scheduleTools = [scheduleCreate, scheduleList, scheduleCancel];
