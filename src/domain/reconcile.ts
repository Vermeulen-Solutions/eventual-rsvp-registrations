import type { AttendeeRecord, WaitlistEntry } from "./types";
import {
  reconcileLedger,
  reconcileNextLedger,
  scanPages,
  type Budget,
  type ReconcileOutcome,
} from "@vermeulen.solutions/eventual-capacity";
import type { AttendanceCtx } from "./waitlist";

export { QUIET_PERIOD_MS, type ReconcileOutcome } from "@vermeulen.solutions/eventual-capacity";

export const RECONCILE_TASK = "ledger-reconcile";
const RECONCILE_CURSOR_KEY = "state:reconcile-cursor";

/**
 * Recomputes one ledger from Attendance's records with the library's `reconcileLedger` (quiet
 * period on the ledger and every record; the corrected write is CAS-checked against the revision
 * read before the scan): going, attended, and pending (awaiting approval) attendees are `taken`,
 * offered waitlist entries `held`, queued entries `waitlistCount`, and `nextPosition` never falls
 * behind the highest position. Costs 2 calls plus one per page of 100 records; pools too large
 * are skipped.
 */
export function reconcileAttendanceLedger(ctx: AttendanceCtx, budget: Budget, key: string, nowMs = Date.now()): Promise<ReconcileOutcome> {
  return reconcileLedger(ctx.kv, budget, key, async ({ poolKey, occurrenceStart, budget: scan, isQuiet }) => {
    let taken = 0;
    const attendees = await scanPages<AttendeeRecord>(
      scan,
      (cursor) => ctx.storage.attendees.query({ where: { translationGroup: poolKey, occurrenceStart }, limit: 100, cursor }) as any,
      (a) => {
        if (!isQuiet(a.updatedAt)) return false;
        if (a.status === "going" || a.status === "attended" || a.status === "pending") taken += a.quantity || 1;
      },
      1
    );
    if (attendees !== "OK") return attendees;

    let held = 0;
    let waitlistCount = 0;
    let maxPosition = 0;
    const entries = await scanPages<WaitlistEntry>(
      scan,
      (cursor) => ctx.storage.waitlist_entries.query({ where: { poolKey, occurrenceStart }, limit: 100, cursor }) as any,
      (e) => {
        if (!isQuiet(e.updatedAt)) return false;
        if (e.status === "queued") waitlistCount += e.quantity || 1;
        else if (e.status === "offered") held += e.quantity || 1;
        maxPosition = Math.max(maxPosition, e.position || 0);
      },
      1
    );
    if (entries !== "OK") return entries;
    return { taken, held, waitlistCount, maxPosition };
  }, { nowMs, log: ctx.log });
}

/** Cron task: reconciles the next ledger after the round-robin cursor (one per tick). */
export function runReconcileTick(ctx: AttendanceCtx, budget: Budget, nowMs = Date.now()): Promise<ReconcileOutcome | null> {
  return reconcileNextLedger(ctx.kv as any, budget, RECONCILE_CURSOR_KEY, (key, b) => reconcileAttendanceLedger(ctx, b, key, nowMs));
}
