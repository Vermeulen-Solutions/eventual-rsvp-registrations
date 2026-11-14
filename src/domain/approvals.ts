import { formatInZone, logWithin, type RpcBudget } from "@vermeulen.solutions/eventual-capacity";
import { getPluginConfig } from "./config";
import { guestMessages, intlLocale, normalizeLocale } from "./messages";
import { sendGuestEmail } from "./notify";
import { cancelAttendee, type AttendanceCtx } from "./waitlist";

export interface ApprovalTickResult {
  lapsed: number;
  noticed: number;
}

/**
 * Cron tick (`attendance-approvals`, every 5 minutes, <= 10 host calls):
 * 1. Expires pending approval requests past their `approvalDueAt` deadline (up to 2 per tick),
 *    releasing seats via `cancelAttendee` and emailing the guest. Waitlist promotion is left
 *    to `waitlist-maintenance`.
 * 2. Sends queued organiser notice emails for new pending requests with remaining budget.
 */
export async function runApprovalTick(
  actx: AttendanceCtx,
  budget: RpcBudget,
  nowMs = Date.now()
): Promise<ApprovalTickResult> {
  const config = await getPluginConfig(actx, budget);
  const nowIso = new Date(nowMs).toISOString();
  let lapsed = 0;
  let noticed = 0;

  if (budget.has(1)) {
    const due = await budget.call(() =>
      actx.storage.attendees.query({ where: { status: "pending", approvalDueAt: { lt: nowIso } }, limit: 2 })
    );
    for (const { data: row } of due.items) {
      if (!row.approvalDueAt || !(row.approvalDueAt < nowIso)) continue;
      if (!budget.has(4)) break;
      const res = await cancelAttendee(actx, budget, row);
      if (!res.ok) continue;
      lapsed++;
      const mt = await guestMessages(actx, budget, normalizeLocale(row.locale, config.defaultLocale));
      await sendGuestEmail(actx, budget, config.replyTo, row,
        mt.requestLapsed({ name: row.displayName, title: row.eventTitle || mt.fallbackTitle }), "Approval lapse email failed");
    }
  }

  if (budget.has(3)) {
    const queued = await budget.call(() =>
      actx.storage.attendees.query({ where: { organiserNotice: "queued" }, limit: 2 })
    );
    const orgLocale = normalizeLocale(config.defaultLocale);
    const intlTag = intlLocale(orgLocale);
    const mt = await guestMessages(actx, budget, orgLocale);
    for (const { data: row } of queued.items) {
      const to = row.replyTo || config.replyTo;
      if (!budget.has(to ? 2 : 1)) break;
      const claimed = await budget.call(() =>
        actx.storage.attendees.updateIf(row.id, {
          where: { organiserNotice: "queued" },
          set: { organiserNotice: "sent", updatedAt: nowIso },
        })
      );
      if (!claimed.applied || !to || row.status !== "pending") continue;
      if (!actx.email?.send) continue;
      const rawDate = row.occurrenceStart || row.startsAt;
      const date = rawDate ? formatInZone(rawDate, row.timezone, intlTag) : mt.singleEvent;
      const deadline = formatInZone(row.approvalDueAt || nowIso, row.timezone, intlTag);
      try {
        await budget.call(() => actx.email!.send({
          to,
          ...mt.organiserNewRequest({
            name: row.displayName,
            email: row.email,
            quantity: row.quantity || 1,
            title: row.eventTitle || mt.fallbackTitle,
            date,
            deadline,
          }),
        }));
        noticed++;
      } catch (err) {
        logWithin(budget, actx.log, "warn", "Organiser approval notice failed", { attendeeId: row.id, error: String(err) });
      }
    }
  }

  return { lapsed, noticed };
}
