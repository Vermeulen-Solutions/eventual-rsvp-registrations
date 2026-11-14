// Self-contained: the package ships astro/, including the public types, and the shared library is
// bundled into the plugin at build time (a dev dependency), so site code must not import it.
export type { AttendeeRecord, AttendeeStatus, WaitlistEntry, WaitlistStatus, EventAttendanceConfig, RsvpSubmission } from "./types";

/** KV key of the pooled seat ledger (same format as eventual-capacity's capacityLedgerKey). */
export function capacityLedgerKey(scope: string, occurrenceStart = ""): string {
  const normScope = scope.trim();
  const normDate = occurrenceStart.trim();
  return normDate ? `ledger:${normScope}:${normDate}` : `ledger:${normScope}`;
}
