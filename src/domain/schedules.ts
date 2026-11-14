import type { RpcBudget } from "@vermeulen.solutions/eventual-capacity";
import { RECONCILE_TASK } from "./reconcile";
import { REMINDER_TASK } from "./reminders";
import { LANGUAGE_PACKS_TASK } from "../i18n";

export const MAINTENANCE_TASK = "waitlist-maintenance";
export const MAIL_TASK = "attendance-mail";
export const RETENTION_TASK = "attendance-retention";
export const APPROVALS_TASK = "attendance-approvals";

/** Every scheduled task this plugin relies on. */
export const SCHEDULES: ReadonlyArray<{ name: string; schedule: string }> = [
  { name: MAINTENANCE_TASK, schedule: "* * * * *" },   // offer expiry + promotion
  { name: RECONCILE_TASK, schedule: "*/10 * * * *" },  // ledger drift correction
  { name: REMINDER_TASK, schedule: "* * * * *" },      // reminder emails
  { name: MAIL_TASK, schedule: "* * * * *" },          // queued confirmation emails
  { name: APPROVALS_TASK, schedule: "*/5 * * * *" },   // lapsed approval expiry + organiser notices
  { name: RETENTION_TASK, schedule: "17 * * * *" },     // erase personal data after retention period
  { name: LANGUAGE_PACKS_TASK, schedule: "* * * * *" }, // missing language packs, ≤ 4 a minute (no call once all are stored)
];

interface CronLike {
  schedule(name: string, opts: { schedule: string }): Promise<void>;
  list(): Promise<Array<{ name: string; schedule: string }>>;
}

/**
 * Makes sure every task is scheduled with the expected expression.
 *
 * `plugin:activate` does not run again when an installed plugin is updated, so a task added in
 * a later version would never be scheduled. The admin page calls this on load to self-heal.
 * Returns the names of tasks it (re)scheduled. Costs 1 call, plus 1 per missing task.
 */
export async function ensureSchedules(cron: CronLike | undefined, budget: RpcBudget): Promise<string[]> {
  if (!cron || !budget.has(1)) return [];
  const existing = await budget.call(() => cron.list());
  const fixed: string[] = [];
  for (const task of SCHEDULES) {
    const current = existing.find((t) => t.name === task.name);
    if (current && current.schedule === task.schedule) continue;
    if (!budget.has(1)) break;
    await budget.call(() => cron.schedule(task.name, { schedule: task.schedule }));
    fixed.push(task.name);
  }
  return fixed;
}

/** Schedules every task without listing first (used by plugin:activate). */
export async function scheduleAll(cron: CronLike | undefined): Promise<void> {
  if (!cron) return;
  for (const task of SCHEDULES) await cron.schedule(task.name, { schedule: task.schedule });
}
