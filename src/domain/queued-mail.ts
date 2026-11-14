import { formatInZone, type Budget } from "@vermeulen.solutions/eventual-capacity";
import { guestMessages, intlLocale, normalizeLocale } from "./messages";
import { confirmationFor, sendGuestEmail } from "./notify";
import type { AttendeeRecord } from "./types";
import type { AttendanceCtx } from "./waitlist";
import { getPluginConfig, manageLink } from "./config";
import { generateCancelToken } from "./security";
import { calendarLink } from "./calendar";

export const QUEUED_MAIL_BATCH = 3;

export interface QueuedMailResult {
  sent: number;
}

/**
 * Cron task: sends confirmation emails for bookings (going, pending, waitlist) whose inline
 * send was skipped because the booking route could not afford the email within its call budget.
 */
export async function runQueuedMailTick(ctx: AttendanceCtx, budget: Budget, nowMs = Date.now()): Promise<QueuedMailResult> {
  const config = await getPluginConfig(ctx, budget); // 1 or 2 calls
  if (!ctx.email?.send) return { sent: 0 };

  const queued = (await budget.call(() =>
    ctx.storage.attendees.query({
      where: { mail: "queued" },
      limit: QUEUED_MAIL_BATCH,
    })
  )) as { items: Array<{ data: AttendeeRecord }> };

  const nowIso = new Date(nowMs).toISOString();
  let sent = 0;

  for (const { data: a } of queued.items) {
    if (!budget.has(2)) break;

    const claimed = await budget.call(() =>
      ctx.storage.attendees.updateIf(a.id, {
        where: { mail: "queued" },
        set: { mail: "sent", updatedAt: nowIso },
      })
    );
    if (!claimed.applied) continue;
    if (!a.email || a.status === "cancelled" || a.status === "attended") continue;

    const locale = normalizeLocale(a.locale, config.defaultLocale);
    const t = await guestMessages(ctx, budget, locale);
    const site = ctx.site?.url ?? "";
    const cancelToken = await generateCancelToken(config.hmacSecret, a.id, a.createdAt, a.eventId);
    const cancelUrl = manageLink(site, config, "cancel", cancelToken);
    const calendarUrl = a.status === "going" && a.startsAt
      ? calendarLink(site, a.eventId, a.occurrenceStart, a.collection, ctx.plugin?.id)
      : undefined;

    const deadline = a.status === "pending"
      ? formatInZone(a.approvalDueAt || nowIso, a.timezone, intlLocale(locale))
      : undefined;
    const msg = confirmationFor(t, a, { cancelUrl, calendarUrl, deadline });
    if (await sendGuestEmail(ctx, budget, config.replyTo, a, msg, "Queued RSVP email failed")) sent++;
  }

  return { sent };
}
