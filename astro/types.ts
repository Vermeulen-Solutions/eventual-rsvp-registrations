/**
 * The public types of the Attendance site components and plugin records. Kept inside `astro/` so
 * the published package is self-contained; `src/domain/types.ts` re-exports them for plugin code.
 */

export type QuestionType = "text" | "textarea" | "email" | "phone" | "number" | "date" | "checkbox" | "select";

export interface QuestionDefinition {
  /** Stable key derived from the label (unique within the event). */
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** Choices for `select`. */
  options?: string[];
}

/** One answer as stored with a booking: the label is a snapshot, so later edits don't relabel it. */
export interface Answer {
  id: string;
  label: string;
  value: string | number | boolean;
}

export type AttendeeStatus = 'going' | 'pending' | 'waitlist' | 'cancelled' | 'attended';

export type WaitlistStatus = 'queued' | 'offered' | 'claimed' | 'expired' | 'cancelled';

export interface WaitlistEntry {
  id: string;                      // e.g. "wl_8f192b"
  eventId: string;
  poolKey: string;                 // translationGroup || eventId - waitlists are pooled like capacity
  occurrenceStart: string;         // Canonical UTC ISO instant or "" for single events
  /** The event's own start (Core's `start` or `start_date`), for live checks and retention. */
  startsAt?: string;
  attendeeId: string;              // References AttendeeRecord
  quantity: number;                // Seats requested (denormalised to keep promotion within the RPC budget)
  email: string;                   // Denormalised for the offer email
  displayName: string;
  eventTitle?: string;             // Denormalised for the offer email
  replyTo?: string;                // Event reply-to snapshot at registration (falls back to site-wide)
  locale?: string;                 // Language of the form the booking came from (shipped tag, e.g. "fr", "pt-BR"); its emails use it
  position: number;                // Monotonic per-pool sequence assigned atomically by the ledger
  status: WaitlistStatus;
  claimTokenHash?: string;         // SHA-256 of HMAC claim token
  offerExpiresAt?: string;         // UTC ISO instant (offer time + 2 hours)
  retainFrom?: string;             // ISO instant retention counts from (occurrenceStart || createdAt)
  erasedAt?: string;               // ISO instant personal details were erased
  createdAt: string;
  claimedAt?: string;
  updatedAt: string;
}

export interface AttendeeRecord {
  id: string;
  eventId: string;
  translationGroup?: string;
  occurrenceStart: string; // Canonical UTC ISO instant or "" for single events
  email: string;
  displayName: string;
  status: AttendeeStatus;
  quantity: number;
  cancelTokenHash: string;
  commandId: string;        // idempotency key; the attendee id is derived from it
  waitlistEntryId?: string;
  waitlistPosition?: number;
  replyTo?: string;          // event reply-to snapshot at registration; later emails use it
  locale?: string;           // language of the form the booking came from (shipped tag); every email uses it
  collection?: string;       // event collection when not the default (calendar links in later emails)
  startsAt?: string;         // UTC instant of the occurrence (all-day: midnight UTC of the date)
  allDay?: boolean;
  timezone?: string;         // event time zone snapshot, for reminder wording
  eventTitle?: string;       // title snapshot, for reminder wording
  reminder?: "due" | "sent"; // indexed with status and startsAt; "due" until the reminder is sent
  remindedAt?: string;
  mail?: "queued" | "sent";  // absent = sent inline (or no email system); "queued" = cron sends it
  approvalDueAt?: string;    // UTC ISO instant when a pending request lapses
  organiserNotice?: "queued" | "sent"; // organiser notification state for pending requests
  answers?: Answer[];        // validated answers to the event's questions, with label snapshots
  orderId?: string;        // Future-proof link to Eventual Tickets OrderRecord
  ticketTierId?: string;   // Future-proof link to Eventual Tickets TicketTier
  qrHash?: string;         // Cryptographic ticket validation hash
  checkedInAt?: string;    // Instant of check-in at event door
  ipHash?: string;         // First 32 hex of HMAC-SHA256(signingKey, "ip:" + ip), cleared on erasure
  retainFrom?: string;     // ISO instant retention counts from (startsAt ?? createdAt)
  erasedAt?: string;       // ISO instant personal details were erased
  createdAt: string;
  updatedAt: string;
}

export interface EventAttendanceConfig {
  enabled: boolean;
  capacity: number;
  maxPerRegistration: number;
  allowWaitlist: boolean;
  requireApproval: boolean;
  approvalHours: number;
  /** Per-event reply-to for attendee emails; empty = the site-wide address. */
  replyTo?: string;
  /** Registration questions shown on the RSVP form and validated on the server. */
  questions?: QuestionDefinition[];
}

export interface RsvpSubmission {
  eventId: string;
  occurrenceStart?: string;
  email: string;
  displayName: string;
  quantity?: number;
  /** Answers keyed by question id (see QuestionDefinition). */
  answers?: Record<string, unknown>;
  honeypot?: string;
  formTimestamp?: number;
  commandId?: string;
  /** Language of the form ("fr" | "en"); emails follow it. Defaults to the site setting. */
  locale?: string;
  /** Collection the event lives in, when Attendance reads several (must be configured). */
  collection?: string;
  /** Cloudflare Turnstile token, required when the site turned Turnstile on. */
  turnstileToken?: string;
  /** Set by the form on a command's first submission: no stored outcome can exist yet. */
  firstAttempt?: boolean;
}
