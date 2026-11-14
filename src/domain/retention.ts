import type { Budget } from "@vermeulen.solutions/eventual-capacity";
import { getEditableConfig } from "./config";
import { isLiveOccurrence } from "./delete-guard";
import type { AttendeeRecord, WaitlistEntry } from "./types";
import type { AttendanceCtx } from "./waitlist";

export interface RetentionResult {
  attendees: number;
  waitlist: number;
}

/**
 * Hourly retention sweep: erases personal data (names, email addresses, answers)
 * from attendee records and waitlist entries whose retention period has expired.
 *
 * Bookings for an event without a date are kept while they're live; the period
 * starts again each time the sweep finds one (retainFrom is moved to now).
 *
 * Worst case: 1 config + 1 query attendees + 4 updates + 1 query waitlist + 2 updates <= 10.
 */
export async function runRetentionTick(
  ctx: AttendanceCtx,
  budget: Budget,
  nowMs = Date.now()
): Promise<RetentionResult> {
  // 1. Get editable config (1 call, no secret needed)
  const config = await getEditableConfig(ctx, budget);
  const cutoff = new Date(nowMs - config.retentionDays * 86_400_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  let erasedAttendees = 0;
  let erasedWaitlist = 0;

  // 2. Query due attendees: limit 4
  if (budget.has(1)) {
    const dueAttendees = (await budget.call(() =>
      ctx.storage.attendees.query({
        where: { retainFrom: { lt: cutoff } },
        orderBy: { retainFrom: "asc" },
        limit: 4,
      })
    )) as { items: Array<{ data: AttendeeRecord }> };

    for (const { data: a } of dueAttendees.items) {
      if (!budget.has(1)) break;
      const isLive = (a.status === "going" || a.status === "pending" || a.status === "waitlist") && isLiveOccurrence(a.startsAt || a.occurrenceStart, nowMs);
      if (isLive) {
        await budget.call(() =>
          ctx.storage.attendees.updateIf(a.id, {
            where: { retainFrom: a.retainFrom },
            set: { retainFrom: nowIso },
          })
        );
        continue;
      }
      const res = await budget.call(() =>
        ctx.storage.attendees.updateIf(a.id, {
          where: { retainFrom: a.retainFrom },
          set: {
            displayName: "",
            email: "",
            answers: [] as any,
            replyTo: "" as any,
            ipHash: "",
            retainFrom: "~erased",
            erasedAt: nowIso,
          },
        })
      );
      if (res.applied) erasedAttendees++;
    }
  }

  // 3. With remaining calls (keep >= 1 spare), query and erase waitlist entries
  if (budget.has(2)) {
    const limit = Math.max(1, Math.min(4, budget.remaining - 2));
    const dueWaitlist = (await budget.call(() =>
      ctx.storage.waitlist_entries.query({
        where: { retainFrom: { lt: cutoff } },
        orderBy: { retainFrom: "asc" },
        limit,
      })
    )) as { items: Array<{ data: WaitlistEntry }> };

    for (const { data: w } of dueWaitlist.items) {
      if (!budget.has(1)) break;
      const isLive = (w.status === "queued" || w.status === "offered") && isLiveOccurrence(w.startsAt || w.occurrenceStart, nowMs);
      if (isLive) {
        await budget.call(() =>
          ctx.storage.waitlist_entries.updateIf(w.id, {
            where: { retainFrom: w.retainFrom },
            set: { retainFrom: nowIso },
          })
        );
        continue;
      }
      const res = await budget.call(() =>
        ctx.storage.waitlist_entries.updateIf(w.id, {
          where: { retainFrom: w.retainFrom },
          set: {
            displayName: "",
            email: "",
            retainFrom: "~erased",
            erasedAt: nowIso,
          },
        })
      );
      if (res.applied) erasedWaitlist++;
    }
  }

  return { attendees: erasedAttendees, waitlist: erasedWaitlist };
}

