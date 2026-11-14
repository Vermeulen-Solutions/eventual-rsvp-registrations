import { logWithin, type Budget } from "@vermeulen.solutions/eventual-capacity";
import type { Email, MessageSet } from "./messages";
import type { AttendanceCtx } from "./waitlist";

/** The parts of an attendee or waitlist row an email needs. */
export interface MailTarget {
  id?: string;
  email?: string;
  replyTo?: string;
}

/**
 * Sends one guest email when the budget has a call left. A failed email never rolls back a
 * booking: it is logged and the caller carries on. The reply-to is the row's own address, then
 * the event/site default.
 */
export async function sendGuestEmail(
  ctx: AttendanceCtx,
  budget: Budget,
  replyTo: string,
  row: MailTarget,
  msg: Email,
  label = "Attendance email failed"
): Promise<boolean> {
  if (!row.email || !ctx.email?.send || !budget.has(1)) return false;
  const reply = row.replyTo || replyTo;
  try {
    await budget.call(() => ctx.email!.send({ to: row.email!, ...msg, ...(reply ? { replyTo: reply } : {}) }));
    return true;
  } catch (err) {
    logWithin(budget, ctx.log, "warn", label, { ...(row.id ? { attendeeId: row.id } : {}), error: String(err) });
    return false;
  }
}

/** The confirmation a booking gets after it is written: confirmed, waiting, or awaiting approval. */
export function confirmationFor(
  t: MessageSet,
  row: { displayName: string; eventTitle?: string; status: string; waitlistPosition?: number },
  data: { cancelUrl: string; calendarUrl?: string; deadline?: string }
): Email {
  const title = row.eventTitle || t.fallbackTitle;
  return row.status === "waitlist"
    ? t.waitlisted({ name: row.displayName, title, position: row.waitlistPosition ?? 0, cancelUrl: data.cancelUrl })
    : row.status === "pending"
    ? t.requestReceived({ name: row.displayName, title, deadline: data.deadline!, cancelUrl: data.cancelUrl })
    : t.rsvpConfirmed({ name: row.displayName, title, calendarUrl: data.calendarUrl, cancelUrl: data.cancelUrl });
}
