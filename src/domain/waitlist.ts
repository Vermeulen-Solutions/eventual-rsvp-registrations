import type { WaitlistEntry, AttendeeRecord } from "./types";
import type { CapacityLedger } from "@vermeulen.solutions/eventual-capacity";
import { generateCancelToken, generateClaimToken, hashClaimToken, isWellFormedToken } from "./security";
import {
  adjustLedger,
  capacityLedgerKey,
  formatInZone,
  freeSeats,
  holdSeatsForOffer,
  normalizeLedger,
  poolKeyFromLedgerKey,
  updateLedger,
  LEDGER_PREFIX,
  logWithin,
  type LedgerAdjustment,
  type LogSink,
  type VersionedKv,
} from "@vermeulen.solutions/eventual-capacity";
import { getPluginConfig, manageLink, type SettingsLike } from "./config";
import { approvalDeadline, DEFAULT_APPROVAL_HOURS, resolveAttendance } from "./event-settings";
import { guestMessages, intlLocale, normalizeLocale } from "./messages";
import { calendarLink } from "./calendar";
import { sendGuestEmail } from "./notify";
import type { Budget } from "@vermeulen.solutions/eventual-capacity";

export const OFFER_TTL_MS = 2 * 3600 * 1000;

/** Minimal structural view of the host storage collection API used here. */
export interface Collection<T> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  query(opts?: unknown): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
  updateIf(
    id: string,
    args: { where: Record<string, unknown>; set?: Partial<T> }
  ): Promise<{ applied: true; data: T } | { applied: false }>;
}

export interface AttendanceCtx {
  kv: VersionedKv & {
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  settings: SettingsLike;
  storage: {
    attendees: Collection<AttendeeRecord>;
    waitlist_entries: Collection<WaitlistEntry>;
  };
  email?: { send(msg: { to: string; subject: string; text: string; replyTo?: string }): Promise<void> };
  site?: { url?: string };
  plugin?: { id: string; version?: string };
  log?: LogSink;
}

export function attendanceCtx(ctx: unknown): AttendanceCtx {
  return ctx as AttendanceCtx;
}

export function poolKeyFor(translationGroup: string | undefined | null, eventId: string): string {
  return (translationGroup || eventId).trim();
}

/**
 * Calls a promotion needs with the config cached: queue 1, hold 2, offer update 1, email 1 = 5,
 * plus one spare. A cold isolate needs 2 more for the config and signing key; the promotion then
 * checks OFFER_CALLS_AFTER_CONFIG again and leaves the work to the next cron tick when short, so
 * an offer is never made without its email (found by the measured budget test).
 */
export const PROMOTION_RPC_COST = 6;
const OFFER_CALLS_AFTER_CONFIG = 4;

export interface WaitlistPromotionResult {
  promoted: boolean;
  entry?: WaitlistEntry;
  reason?: string;
}

/**
 * Offers freed seats to the head of the pooled FIFO queue.
 *
 * Order matters for safety: seats are HELD in the ledger first, then the entry is moved
 * queued → offered with a guarded update. A crash between the two under-sells (a held seat
 * with no offer), it can never over-sell.
 */
export async function promoteNextWaitlistEntry(
  ctx: AttendanceCtx,
  budget: Budget,
  poolKey: string,
  occurrenceStart = ""
): Promise<WaitlistPromotionResult> {
  if (!budget.has(PROMOTION_RPC_COST)) return { promoted: false, reason: "BUDGET" };

  const head = await budget.call(() =>
    ctx.storage.waitlist_entries.query({
      where: { poolKey, occurrenceStart, status: "queued" },
      orderBy: { position: "asc" },
      limit: 1,
    })
  );
  const candidate = head.items[0]?.data;
  if (!candidate) return { promoted: false, reason: "NO_QUEUED_ATTENDEES" };

  const config = await getPluginConfig(ctx, budget);
  // A cold isolate spends 2 calls on the config and signing key. Hold the seats only if the hold
  // (2), the offer update (1) and the offer email (1) all still fit: an offer nobody is told about
  // would keep the seats for the whole offer window. Otherwise the next cron tick promotes.
  if (!budget.has(OFFER_CALLS_AFTER_CONFIG)) return { promoted: false, reason: "BUDGET" };
  const ledgerKey = capacityLedgerKey(poolKey, occurrenceStart);
  const hold = await holdSeatsForOffer(ctx.kv, budget, ledgerKey, candidate.quantity);
  if (hold !== "HELD") return { promoted: false, reason: hold };

  const now = new Date();
  const offerExpiresAt = new Date(now.getTime() + OFFER_TTL_MS).toISOString();
  const claimToken = await generateClaimToken(config.hmacSecret, candidate.id, candidate.eventId, offerExpiresAt);
  const claimTokenHash = await hashClaimToken(claimToken);

  const offered = await budget.call(() =>
    ctx.storage.waitlist_entries.updateIf(candidate.id, {
      where: { status: "queued" },
      set: { status: "offered", offerExpiresAt, claimTokenHash, updatedAt: now.toISOString() },
    })
  );
  if (!offered.applied) {
    // Entry was cancelled or promoted concurrently: give the seats back to the queue.
    if (budget.has(2)) {
      await adjustLedger(ctx.kv, budget, ledgerKey, { held: candidate.quantity, waitlistCount: -candidate.quantity }, 1);
    } else {
      logWithin(budget, ctx.log, "error", "Held seats could not be returned after a promotion race", { ledgerKey, entryId: candidate.id });
    }
    return { promoted: false, reason: "RACE" };
  }

  const t = await guestMessages(ctx, budget, normalizeLocale(candidate.locale, config.defaultLocale));
  const claimUrl = manageLink(ctx.site?.url ?? "", config, "claim", claimToken);
  await sendGuestEmail(ctx, budget, config.replyTo, candidate,
    t.offer({ name: candidate.displayName, title: candidate.eventTitle || t.fallbackTitle, claimUrl }));

  return { promoted: true, entry: { ...candidate, ...offered.data } };
}

export interface ClaimWaitlistResult {
  ok: boolean;
  attendee?: AttendeeRecord;
  waitlistEntry?: WaitlistEntry;
  error?: string;
}

/**
 * Claims an offered spot. The guarded offered → claimed update is the single point of
 * exclusivity: concurrent claims, a racing cancel, and the expiry sweep cannot all win.
 * Seats move held → taken, which keeps total occupancy constant, so a failed ledger write
 * can only under-sell.
 */
export async function claimWaitlistSpot(
  ctx: AttendanceCtx,
  budget: Budget,
  claimToken: unknown,
  nowMs = Date.now()
): Promise<ClaimWaitlistResult> {
  if (!isWellFormedToken(claimToken)) return { ok: false, error: "INVALID_TOKEN" };

  const tokenHash = await hashClaimToken(claimToken);
  const found = await budget.call(() =>
    ctx.storage.waitlist_entries.query({ where: { claimTokenHash: tokenHash }, limit: 1 })
  );
  const entry = found.items[0]?.data;
  if (!entry) return { ok: false, error: "ENTRY_NOT_FOUND" };
  if (entry.status === "claimed") return { ok: false, error: "ALREADY_CLAIMED" };
  if (entry.status === "expired") return { ok: false, error: "OFFER_EXPIRED" };
  if (entry.status !== "offered") return { ok: false, error: "INVALID_STATUS" };

  const expiresAtMs = entry.offerExpiresAt ? Date.parse(entry.offerExpiresAt) : 0;
  if (!(nowMs < expiresAtMs)) return { ok: false, error: "OFFER_EXPIRED" };

  const nowIso = new Date(nowMs).toISOString();
  const claimed = await budget.call(() =>
    ctx.storage.waitlist_entries.updateIf(entry.id, {
      where: { status: "offered", claimTokenHash: tokenHash },
      set: { status: "claimed", claimedAt: nowIso, updatedAt: nowIso },
    })
  );
  if (!claimed.applied) return { ok: false, error: "OFFER_NO_LONGER_AVAILABLE" };

  const ledgerKey = capacityLedgerKey(entry.poolKey, entry.occurrenceStart);
  const moved = await adjustLedger(ctx.kv, budget, ledgerKey, { heldToTaken: entry.quantity }, 2);
  if (!moved) logWithin(budget, ctx.log, "error", "Claim could not move held seats to taken", { ledgerKey, entryId: entry.id });

  let needsApproval = false;
  let approvalHours = DEFAULT_APPROVAL_HOURS;
  if ((ctx.storage as any).attendance_settings && budget.has(2)) {
    const resolved = await resolveAttendance(
      (ctx.storage as any).attendance_settings,
      budget,
      { id: entry.eventId, translationGroup: entry.poolKey, status: "published", data: {} }
    );
    needsApproval = resolved.config.requireApproval;
    approvalHours = resolved.config.approvalHours;
  } else if ((ctx.storage as any).attendance_settings) {
    logWithin(budget, ctx.log, "warn", "Skipped approval check on waitlist claim due to call budget", { entryId: entry.id, attendeeId: entry.attendeeId });
  }

  let config = budget.has(3) ? await getPluginConfig(ctx, budget) : null;
  const canEmailNow = !!ctx.email?.send && !!config && budget.has(2);
  const queueEmail = !!ctx.email?.send && !canEmailNow;
  const approvalDueAt = needsApproval ? approvalDeadline(nowMs, approvalHours, entry.occurrenceStart || undefined) : undefined;
  const hasOrganiserAddress = Boolean(entry.replyTo || config?.replyTo);

  const promoted = await budget.call(() =>
    ctx.storage.attendees.updateIf(entry.attendeeId, {
      where: { status: "waitlist" },
      set: {
        status: needsApproval ? "pending" : "going",
        ...(approvalDueAt ? { approvalDueAt } : {}),
        ...(needsApproval && hasOrganiserAddress ? { organiserNotice: "queued" } : {}),
        ...(queueEmail ? { mail: "queued" } : {}),
        updatedAt: nowIso,
      },
    })
  );
  if (!promoted.applied) return { ok: false, error: "ATTENDEE_NOT_WAITLISTED" };
  const attendee = promoted.data;

  // Tokens are deterministic, so the original cancellation link is re-minted, not replaced.
  if (config && canEmailNow) {
    const cancelToken = await generateCancelToken(config.hmacSecret, attendee.id, attendee.createdAt, attendee.eventId);
    const locale = normalizeLocale(attendee.locale ?? entry.locale, config.defaultLocale);
    const t = await guestMessages(ctx, budget, locale);
    const title = entry.eventTitle || t.fallbackTitle;
    const cancelUrl = manageLink(ctx.site?.url ?? "", config, "cancel", cancelToken);
    const msg = needsApproval
      ? t.requestReceived({
          name: attendee.displayName,
          title,
          deadline: formatInZone(approvalDueAt!, attendee.timezone, intlLocale(locale)),
          cancelUrl,
        })
      : t.claimConfirmed({
          name: attendee.displayName,
          title,
          calendarUrl: attendee.startsAt ? calendarLink(ctx.site?.url ?? "", attendee.eventId, attendee.occurrenceStart, attendee.collection, ctx.plugin?.id) : undefined,
          cancelUrl,
        });
    await sendGuestEmail(ctx, budget, config.replyTo, attendee, msg);
  }

  return { ok: true, attendee, waitlistEntry: { ...entry, ...claimed.data } };
}

export interface MoveToEndResult {
  ok: boolean;
  error?: "NOT_QUEUED" | "NO_LEDGER" | "RACE";
  position?: number;
}

/**
 * Organiser action: sends a queued attendee to the back of the line (suite D7). Strict FIFO
 * means a head that needs more seats than are free blocks everyone behind it; this is the
 * deliberate, visible way to unblock the queue. The attendee keeps their place in line, only
 * at the end, and is told by email. Seats are untouched, so the next head is offered the free
 * seat by the next maintenance tick.
 *
 * Only `queued` entries move — never an outstanding offer. A new tail position comes from the
 * ledger's nextPosition counter (the same CAS that numbers new registrations), and the entry is
 * moved with a guard on its old position, so concurrent moves and promotions can't collide.
 * ≤ 8 calls.
 */
export async function moveToEndOfQueue(
  ctx: AttendanceCtx,
  budget: Budget,
  attendeeId: string
): Promise<MoveToEndResult> {
  const attendee = await budget.call(() => ctx.storage.attendees.get(attendeeId));
  if (!attendee || attendee.erasedAt || attendee.status !== "waitlist" || !attendee.waitlistEntryId) return { ok: false, error: "NOT_QUEUED" };
  const entry = await budget.call(() => ctx.storage.waitlist_entries.get(attendee.waitlistEntryId!));
  if (!entry || entry.status !== "queued") return { ok: false, error: "NOT_QUEUED" };

  const ledgerKey = capacityLedgerKey(entry.poolKey, entry.occurrenceStart);
  const numbered = await updateLedger<number>(ctx.kv, budget, ledgerKey, (current) =>
    current
      ? { next: { ...current, nextPosition: current.nextPosition + 1 }, result: current.nextPosition }
      : { abort: 0 }
  );
  if (!numbered.applied) return { ok: false, error: numbered.reason === "ABORTED" ? "NO_LEDGER" : "RACE" };
  const position = numbered.result;

  const moved = await budget.call(() =>
    ctx.storage.waitlist_entries.updateIf(entry.id, {
      where: { status: "queued", position: entry.position },
      set: { position, updatedAt: new Date().toISOString() },
    })
  );
  // A lost race only burns a position number; positions are an order, not a count.
  if (!moved.applied) return { ok: false, error: "RACE" };

  if (budget.has(3)) {
    const config = await getPluginConfig(ctx, budget);
    const t = await guestMessages(ctx, budget, normalizeLocale(entry.locale, config.defaultLocale));
    await sendGuestEmail(ctx, budget, config.replyTo, entry,
      t.movedToEnd({ name: entry.displayName, title: entry.eventTitle || t.fallbackTitle, quantity: entry.quantity }));
  }
  return { ok: true, position };
}

export interface CancelResult {
  ok: boolean;
  error?: string;
  attendee?: AttendeeRecord;
  /** Seats returned to the pool; the caller should try to promote the queue head. */
  seatsFreed: boolean;
}

/**
 * Cancels one attendee (`going`, `pending`, `attended`, or `waitlist`). The guarded status update
 * guarantees two concurrent cancels release seats exactly once; `going`, `pending`, and
 * `attended` release `taken` seats on the ledger.
 */
export async function cancelAttendee(
  ctx: AttendanceCtx,
  budget: Budget,
  row: AttendeeRecord
): Promise<CancelResult> {
  if (row.status === "cancelled") return { ok: false, error: "ALREADY_CANCELLED", seatsFreed: false };
  // Erased records keep their seat counts but nobody may act on the person any more.
  if (row.erasedAt) return { ok: false, error: "ALREADY_CANCELLED", seatsFreed: false };

  const nowIso = new Date().toISOString();
  const updated = await budget.call(() =>
    ctx.storage.attendees.updateIf(row.id, {
      where: { status: row.status },
      set: { status: "cancelled", ...(row.organiserNotice === "queued" ? { organiserNotice: "sent" as const } : {}), updatedAt: nowIso },
    })
  );
  if (!updated.applied) return { ok: false, error: "ALREADY_CANCELLED", seatsFreed: false };

  const poolKey = poolKeyFor(row.translationGroup, row.eventId);
  const ledgerKey = capacityLedgerKey(poolKey, row.occurrenceStart);
  let adj: LedgerAdjustment | null = { taken: row.quantity };
  let seatsFreed = true;

  if (row.status === "waitlist" && row.waitlistEntryId) {
    adj = null;
    seatsFreed = false;
    for (let attempt = 0; attempt < 2 && budget.has(4); attempt++) {
      const entry = await budget.call(() => ctx.storage.waitlist_entries.get(row.waitlistEntryId!));
      if (!entry || entry.status === "cancelled" || entry.status === "expired") break;
      if (entry.status === "claimed") {
        adj = { taken: row.quantity };
        seatsFreed = true;
        break;
      }
      const res = await budget.call(() =>
        ctx.storage.waitlist_entries.updateIf(entry.id, {
          where: { status: entry.status },
          set: { status: "cancelled", updatedAt: nowIso },
        })
      );
      if (res.applied) {
        adj = entry.status === "queued" ? { waitlistCount: row.quantity } : { held: row.quantity };
        seatsFreed = entry.status === "offered";
        break;
      }
    }
  }

  if (adj) {
    const released = await adjustLedger(ctx.kv, budget, ledgerKey, adj, 2);
    if (!released) logWithin(budget, ctx.log, "error", "Cancellation could not release ledger seats", { ledgerKey, attendeeId: row.id });
  }

  return { ok: true, attendee: { ...row, ...updated.data }, seatsFreed };
}

export interface MaintenanceResult {
  expiredCount: number;
  promotedCount: number;
  budgetExhausted: boolean;
}

/**
 * Cron task. Expires lapsed offers (returning their held seats) and then promotes queue heads
 * for every pool that has both free seats and queued attendees. Work is bounded by the RPC
 * budget; anything left over is picked up on the next tick.
 */
export async function runWaitlistMaintenance(
  ctx: AttendanceCtx,
  budget: Budget,
  nowMs = Date.now()
): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { expiredCount: 0, promotedCount: 0, budgetExhausted: false };
  const nowIso = new Date(nowMs).toISOString();

  // 1. Expire lapsed offers (4 RPCs each).
  const lapsed = await budget.call(() =>
    ctx.storage.waitlist_entries.query({
      where: { status: "offered", offerExpiresAt: { lte: nowIso } },
      orderBy: { offerExpiresAt: "asc" },
      limit: 2,
    })
  );
  for (const { data: entry } of lapsed.items) {
    if (!budget.has(4 + 1)) {
      result.budgetExhausted = true;
      break;
    }
    const expired = await budget.call(() =>
      ctx.storage.waitlist_entries.updateIf(entry.id, {
        where: { status: "offered" },
        set: { status: "expired", updatedAt: nowIso },
      })
    );
    if (!expired.applied) continue; // claimed or cancelled in the meantime
    result.expiredCount++;
    await adjustLedger(ctx.kv, budget, capacityLedgerKey(entry.poolKey, entry.occurrenceStart), { held: entry.quantity }, 1);
    await budget.call(() =>
      ctx.storage.attendees.updateIf(entry.attendeeId, {
        where: { status: "waitlist" },
        set: { status: "cancelled", updatedAt: nowIso },
      })
    );
  }

  // 2. Promote wherever seats are free and people are waiting.
  if (!budget.has(1 + PROMOTION_RPC_COST)) {
    result.budgetExhausted = true;
    return result;
  }
  const ledgers = await budget.call(() => ctx.kv.list(LEDGER_PREFIX));
  const candidates = ledgers
    .map(({ key, value }) => ({ key, ledger: normalizeLedger(value as Partial<CapacityLedger>) }))
    .filter((c): c is { key: string; ledger: CapacityLedger } =>
      !!c.ledger && c.ledger.waitlistCount > 0 && freeSeats(c.ledger) > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (candidates.length === 0) return result;

  // Round-robin across ticks: a pool whose queue head cannot fit yet must not starve the others.
  let order = candidates;
  let lastTried: string | undefined;
  let cursorRevision: string | null = null;
  const useCursor = candidates.length > 1 && budget.has(2 + PROMOTION_RPC_COST);
  if (useCursor) {
    const cursor = await budget.call(() => ctx.kv.getVersioned<string>(MAINTENANCE_CURSOR_KEY));
    cursorRevision = cursor?.revision ?? null;
    const start = candidates.findIndex((c) => !cursor || c.key > cursor.value);
    order = start <= 0 ? candidates : [...candidates.slice(start), ...candidates.slice(0, start)];
  }

  const reserve = useCursor ? 1 : 0;
  for (const { key, ledger } of order) {
    if (!budget.has(PROMOTION_RPC_COST + reserve)) {
      result.budgetExhausted = true;
      break;
    }
    const poolKey = ledger.poolKey || poolKeyFromLedgerKey(key, ledger.occurrenceStart);
    lastTried = key;
    const promo = await promoteNextWaitlistEntry(ctx, budget, poolKey, ledger.occurrenceStart);
    if (promo.promoted) result.promotedCount++;
  }

  if (useCursor && lastTried) {
    // A lost CAS just means a concurrent tick advanced the cursor; it only steers fairness.
    await budget.call(() => ctx.kv.compareAndSet(MAINTENANCE_CURSOR_KEY, cursorRevision, lastTried));
  }

  return result;
}

const MAINTENANCE_CURSOR_KEY = "state:maintenance-cursor";
