import type { RpcBudget } from "@vermeulen.solutions/eventual-capacity";
import type { AttendanceCtx } from "./waitlist";

const GRACE_PERIOD_MS = 12 * 3_600_000;

/**
 * A registration is live when its occurrence has not passed.
 * An empty date means an undated event (always live), unless the event itself has a start.
 * Dated events stay live until 12 hours after their start.
 */
export function isLiveOccurrence(occurrenceStart: string, nowMs = Date.now()): boolean {
  if (!occurrenceStart) return true;
  const startMs = Date.parse(occurrenceStart);
  if (Number.isNaN(startMs)) return false;
  return startMs >= nowMs - GRACE_PERIOD_MS;
}

/**
 * Checks whether an event has any upcoming/live registrations (going, pending, or waitlist).
 * At most 3 storage queries (≤ 3 calls).
 */
export async function hasLiveRegistrations(
  actx: AttendanceCtx,
  budget: RpcBudget,
  eventId: string,
  nowMs = Date.now()
): Promise<boolean> {
  for (const status of ["going", "pending", "waitlist"] as const) {
    if (!budget.has(1)) return false;
    const found = await budget.call(() =>
      actx.storage.attendees.query({ where: { eventId, status }, limit: 50 })
    );
    if (found.items.some((it) => isLiveOccurrence(it.data.startsAt || it.data.occurrenceStart, nowMs))) {
      return true;
    }
  }
  return false;
}
