import { type Budget } from "@vermeulen.solutions/eventual-capacity";
import { guestMessages, normalizeLocale } from "./messages";
import { sendGuestEmail } from "./notify";
import type { AttendeeRecord } from "./types";
import type { AttendanceCtx } from "./waitlist";
import { getPluginConfig, manageLink } from "./config";
import { generateCancelToken } from "./security";
import { calendarLink, formatWhen } from "./calendar";

export const REMINDER_TASK = "attendance-reminders";

/** Reminders per tick: query 1 + (guarded flip 1 + email 1) each, within 10 calls with a cold config. */
export const REMINDER_BATCH = 3;

export interface ReminderResult {
  sent: number;
  disabled: boolean;
}

/**
 * Cron task: emails confirmed attendees whose occurrence starts within the lead time.
 *
 * Each attendee carries `reminder: "due" | "sent"` (set "due" at registration), so the query
 * only ever returns attendees still owed a reminder. Each one is flipped to "sent" with a
 * guarded `updateIf` *before* the email goes out: two overlapping ticks can never both send,
 * and a crash between the two loses one reminder rather than duplicating it (at most once).
 *
 * At the default limits that is about 3 reminders per minute per site (~180/hour), so reminders
 * for a large event go out over the hour before the lead time rather than all at once.
 */
export async function runReminderTick(ctx: AttendanceCtx, budget: Budget, nowMs = Date.now()): Promise<ReminderResult> {
  const config = await getPluginConfig(ctx, budget);
  if (config.reminderLeadHours === 0) return { sent: 0, disabled: true };

  const nowIso = new Date(nowMs).toISOString();
  const horizon = new Date(nowMs + config.reminderLeadHours * 3_600_000).toISOString();
  const due = (await budget.call(() =>
    ctx.storage.attendees.query({
      where: { reminder: "due", status: "going", startsAt: { gt: nowIso, lte: horizon } },
      orderBy: { startsAt: "asc" },
      limit: REMINDER_BATCH,
    })
  )) as { items: Array<{ data: AttendeeRecord }> };

  let sent = 0;
  for (const { data: attendee } of due.items) {
    if (!budget.has(2)) break;
    const flipped = await budget.call(() =>
      ctx.storage.attendees.updateIf(attendee.id, {
        where: { reminder: "due", status: "going" },
        set: { reminder: "sent", remindedAt: nowIso },
      })
    );
    if (!flipped.applied) continue; // cancelled, checked in, or reminded meanwhile
    if (!attendee.email) continue;

    const locale = normalizeLocale(attendee.locale, config.defaultLocale);
    const t = await guestMessages(ctx, budget, locale);
    const when = attendee.startsAt
      ? formatWhen({ startsAt: attendee.startsAt, allDay: attendee.allDay === true, timezone: attendee.timezone }, locale)
      : t.soon;
    const site = ctx.site?.url ?? "";
    const cancelToken = await generateCancelToken(config.hmacSecret, attendee.id, attendee.createdAt, attendee.eventId);
    const message = t.reminder({
      name: attendee.displayName,
      title: attendee.eventTitle || t.fallbackTitle,
      when,
      quantity: attendee.quantity,
      calendarUrl: calendarLink(site, attendee.eventId, attendee.occurrenceStart, attendee.collection, ctx.plugin?.id),
      cancelUrl: manageLink(site, config, "cancel", cancelToken),
    });
    if (await sendGuestEmail(ctx, budget, config.replyTo, attendee, message, "Reminder email failed")) sent++;
  }
  return { sent, disabled: false };
}
