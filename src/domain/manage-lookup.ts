import { isWellFormedToken, type Budget } from "@vermeulen.solutions/eventual-capacity";
import { hashCancelToken, hashClaimToken } from "./security";
import type { AttendanceCtx } from "./waitlist";

/**
 * What the manage page shows before the guest confirms anything: which event and date, how many
 * seats, and where the booking stands. Read-only, so it's safe to call on page load; the token is
 * the same one the cancel or claim route takes. Never returns the email address. 1 call.
 */
export async function lookupManageLink(ctx: AttendanceCtx, budget: Budget, input: unknown, nowMs = Date.now()) {
  const body = (input && typeof input === "object" ? input : {}) as { action?: unknown; token?: unknown };
  const token = body.token;
  if (!isWellFormedToken(token)) return { ok: false as const, error: "INVALID_TOKEN" };

  if (body.action === "claim") {
    const claimTokenHash = await hashClaimToken(token as string);
    const found = await budget.call(() => ctx.storage.waitlist_entries.query({ where: { claimTokenHash }, limit: 1 }));
    const entry = found.items[0]?.data;
    if (!entry) return { ok: false as const, error: "ENTRY_NOT_FOUND" };
    const expired = entry.status === "expired" || (entry.status === "offered" && !(nowMs < Date.parse(entry.offerExpiresAt ?? "")));
    return {
      ok: true as const,
      kind: "claim" as const,
      state: expired ? "expired" : entry.status === "claimed" ? "claimed" : entry.status === "offered" ? "offered" : "unavailable",
      eventTitle: entry.eventTitle ?? "",
      occurrenceStart: entry.occurrenceStart,
      quantity: entry.quantity,
      ...(entry.locale ? { locale: entry.locale } : {}),
      ...(entry.offerExpiresAt ? { offerExpiresAt: entry.offerExpiresAt } : {}),
    };
  }

  if (body.action !== "cancel") return { ok: false as const, error: "INVALID_ACTION" };
  const cancelTokenHash = await hashCancelToken(token as string);
  const found = await budget.call(() => ctx.storage.attendees.query({ where: { cancelTokenHash }, limit: 1 }));
  const row = found.items[0]?.data;
  if (!row) return { ok: false as const, error: "ALREADY_CANCELLED_OR_UNKNOWN" };
  return {
    ok: true as const,
    kind: "cancel" as const,
    state: row.status, // going | pending | attended | waitlist | cancelled
    eventTitle: row.eventTitle ?? "",
    occurrenceStart: row.occurrenceStart,
    ...(row.startsAt ? { startsAt: row.startsAt } : {}),
    ...(row.allDay ? { allDay: true } : {}),
    ...(row.timezone ? { timezone: row.timezone } : {}),
    quantity: row.quantity || 1,
    displayName: row.displayName,
    ...(row.locale ? { locale: row.locale } : {}),
  };
}
