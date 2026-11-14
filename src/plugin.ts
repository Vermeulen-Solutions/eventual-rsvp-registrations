import { pluginResponse, pluginRoute, type SandboxedPlugin } from "emdash/plugin";
import {
  adjustLedger,
  BudgetSlice,
  capacityLedgerKey,
  formatInZone,
  isCommandId,
  ensureSchedulesOnce,
  isTicketManaged,
  normalizeLedger,
  type CapacityLedger,
  logWithin,
  poolKeyOfEvent,
  reserveSeats,
  RpcBudget,
  RpcBudgetExceeded,
  validateAnswers,
  verifyTurnstile,
} from "@vermeulen.solutions/eventual-capacity";
import { generateCancelToken, hashCancelToken, hashToken, checkHoneypot, checkFormTimestamp, isWellFormedToken } from "./domain/security";
import type { AttendeeRecord, AttendeeStatus, RsvpSubmission, WaitlistEntry } from "./domain/types";
import { approvalDeadline, resolveAttendance } from "./domain/event-settings";
import { handleAttendanceAdmin } from "./admin/attendance-panel";
import { handleEventEditorPanel } from "./admin/event-editor-panel";
import {
  attendanceCtx,
  cancelAttendee,
  claimWaitlistSpot,
  poolKeyFor,
  promoteNextWaitlistEntry,
  runWaitlistMaintenance,
  PROMOTION_RPC_COST,
} from "./domain/waitlist";
import { downloadRoster, exportRoster } from "./admin/roster-export";
import { eventCollections, getEditableConfig, getPluginConfig, manageLink, resolveCollection, turnstileEnabled } from "./domain/config";
import { guestMessages, intlLocale, normalizeLocale } from "./domain/messages";
import { LANGUAGE_PACKS_TASK, warmLanguagePacks } from "./i18n";
import { confirmationFor, sendGuestEmail } from "./domain/notify";
import { lookupManageLink } from "./domain/manage-lookup";
import { APPROVALS_TASK, MAINTENANCE_TASK, MAIL_TASK, RETENTION_TASK, SCHEDULES, scheduleAll } from "./domain/schedules";
import { RECONCILE_TASK, runReconcileTick } from "./domain/reconcile";
import { REMINDER_TASK, runReminderTick } from "./domain/reminders";
import { runApprovalTick } from "./domain/approvals";
import { runQueuedMailTick } from "./domain/queued-mail";
import { runRetentionTick } from "./domain/retention";
import { CALENDAR_ROUTE, calendarLink, eventIcs, eventTiming } from "./domain/calendar";
import { hasLiveRegistrations } from "./domain/delete-guard";
import { hashVisitorIp, isIpRateLimited } from "./domain/ip-limit";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function tokenFromBody(input: unknown): unknown {
  return input && typeof input === "object" ? (input as { token?: unknown }).token : undefined;
}

/**
 * The attendee ID is derived from the command, so the attendee record itself is the
 * idempotency claim: a create-only compareAndSet lets exactly one request write it.
 * (A unique index is not relied on: the test host does not enforce `uniqueIndexes` on put.)
 */
async function attendeeIdFor(eventId: string, commandId: string): Promise<string> {
  return `att_${(await hashToken(`rsvp:${eventId}:${commandId}`)).slice(0, 32)}`;
}

/** Same request → the original outcome; same id with different contents → refused. */
function replayRsvp(
  prior: AttendeeRecord,
  req: { eventId: string; email: string; occurrenceStart: string; quantity: number }
) {
  const same = prior.eventId === req.eventId && prior.email === req.email
    && prior.occurrenceStart === req.occurrenceStart && prior.quantity === req.quantity;
  if (!same) return { ok: false, error: "IDEMPOTENCY_CONFLICT" };
  if (prior.status === "cancelled") return { ok: false, error: "ALREADY_CANCELLED" };
  const status = prior.status === "waitlist" ? "waitlist" : prior.status === "pending" ? "pending" : "going";
  return {
    ok: true,
    attendeeId: prior.id,
    status,
    ...(status === "pending" && prior.approvalDueAt ? { approvalDueAt: prior.approvalDueAt } : {}),
    waitlistPosition: status === "waitlist" ? prior.waitlistPosition : undefined,
    replayed: true,
  };
}


export const plugin: SandboxedPlugin = {
  hooks: {
    "plugin:activate": async (_event, ctx) => {
      await scheduleAll(ctx.cron);
    },
    cron: async (event, ctx) => {
      if (event.name === MAINTENANCE_TASK) {
        const budget = new RpcBudget();
        const result = await runWaitlistMaintenance(attendanceCtx(ctx), budget);
        if (result.expiredCount || result.promotedCount) logWithin(budget, ctx.log, "info", "Waitlist maintenance", result);
      } else if (event.name === RECONCILE_TASK) {
        await runReconcileTick(attendanceCtx(ctx), new RpcBudget());
      } else if (event.name === REMINDER_TASK) {
        const budget = new RpcBudget();
        const result = await runReminderTick(attendanceCtx(ctx), budget);
        if (result.sent) logWithin(budget, ctx.log, "info", "Attendance reminders sent", result);
      } else if (event.name === MAIL_TASK) {
        const budget = new RpcBudget();
        const result = await runQueuedMailTick(attendanceCtx(ctx), budget);
        if (result.sent > 0 && budget.has(1)) logWithin(budget, ctx.log, "info", "Queued confirmations sent", result);
      } else if (event.name === APPROVALS_TASK) {
        const budget = new RpcBudget();
        const result = await runApprovalTick(attendanceCtx(ctx), budget);
        if ((result.lapsed || result.noticed) && budget.has(1)) logWithin(budget, ctx.log, "info", "Attendance approvals", result);
      } else if (event.name === LANGUAGE_PACKS_TASK) {
        await warmLanguagePacks(ctx as any, new RpcBudget());
      } else if (event.name === RETENTION_TASK) {
        const budget = new RpcBudget();
        const result = await runRetentionTick(attendanceCtx(ctx), budget);
        if ((result.attendees > 0 || result.waitlist > 0) && budget.has(1)) {
          logWithin(budget, ctx.log, "info", "Attendance retention sweep", result);
        }
      }
    },
    "content:beforeDelete": async (event, ctx) => {
      const budget = new RpcBudget();
      const actx = attendanceCtx(ctx);
      const config = await getEditableConfig(actx, budget);          // 1 call, no secret
      if (!eventCollections(config).includes(event.collection)) return;
      const live = await hasLiveRegistrations(actx, budget, event.id); // ≤ 3 calls
      if (!live) return;
      logWithin(budget, ctx.log, "warn", "Delete blocked: the event has live registrations", { id: event.id });
      return false;
    },
  },

  routes: {
    admin: {
      permission: "content:edit_any",
      handler: async (routeCtx, ctx) => handleAttendanceAdmin(routeCtx.input, ctx, routeCtx.user, (routeCtx as any).ui?.locale),
    },

    "admin/editor/attendance": {
      permission: "content:edit_any",
      handler: async (routeCtx, ctx) => handleEventEditorPanel(routeCtx, ctx),
    },

    rsvp: pluginRoute({
      public: true,
      methods: ["POST"],
      request: { body: "json" },
      handler: async (routeCtx, ctx) => {
        const budget = new RpcBudget();
        const body = (routeCtx.input && typeof routeCtx.input === "object" ? routeCtx.input : {}) as Partial<RsvpSubmission>;

        // Anti-abuse checks
        if (!checkHoneypot(typeof body.honeypot === "string" ? body.honeypot : undefined)) {
          return { ok: true, status: "going", message: "Registration received." }; // fool scrapers
        }
        if (!checkFormTimestamp(typeof body.formTimestamp === "number" ? body.formTimestamp : undefined)) {
          return { ok: false, error: "INVALID_SUBMISSION_TIMING" };
        }

        const eventId = String(body.eventId ?? "").trim().slice(0, 128);
        const email = String(body.email ?? "").trim().toLowerCase().slice(0, 320);
        const displayName = String(body.displayName ?? "").trim().slice(0, 100);
        const occurrenceStart = String(body.occurrenceStart ?? "").trim().slice(0, 40);
        const quantity = body.quantity === undefined ? 1 : Number(body.quantity);

        if (!eventId || !email || !displayName) return { ok: false, error: "MISSING_REQUIRED_FIELDS" };
        if (!EMAIL_RE.test(email)) return { ok: false, error: "INVALID_EMAIL" };
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) return { ok: false, error: "INVALID_QUANTITY" };
        if (occurrenceStart && Number.isNaN(Date.parse(occurrenceStart))) return { ok: false, error: "INVALID_OCCURRENCE" };

        const actx = attendanceCtx(ctx);
        const config = await getPluginConfig(actx, budget);
        const locale = normalizeLocale(body.locale, config.defaultLocale);

        // Idempotency: the form sends one commandId per registration attempt. A retry (double
        // click, network retry, lost response) with the same id returns the original outcome
        // instead of booking again. Requests without one get a server id and no dedupe.
        // The form marks a command's first submission, which can't have a stored outcome yet, so
        // the lookup is skipped (1 call saved for Turnstile). The create-only attendee write below
        // still settles any duplicate, so a wrong flag costs only the faster replay.
        const commandId = isCommandId(body.commandId) ? body.commandId : `srv_${crypto.randomUUID()}`;
        const attendeeId = await attendeeIdFor(eventId, commandId);
        if (isCommandId(body.commandId) && body.firstAttempt !== true) {
          const prior = await budget.call(() => actx.storage.attendees.get(attendeeId));
          if (prior) return replayRsvp(prior, { eventId, email, occurrenceStart, quantity });
        }

        const remoteIp = typeof (routeCtx as any).requestMeta?.ip === "string"
          ? (routeCtx as any).requestMeta.ip.trim()
          : "";
        const nowMs = Date.now();

        // Turnstile after the replay check: a retry of a booking that landed has spent its token.
        if (turnstileEnabled(config)) {
          if (!ctx.http?.fetch) return { ok: false, error: "TRY_AGAIN" };
          const challenge = await verifyTurnstile(ctx.http.fetch.bind(ctx.http) as any, budget, {
            secret: config.turnstileSecretKey,
            token: body.turnstileToken,
            remoteIp: remoteIp || null,
          });
          if (!challenge.ok) return { ok: false, error: "CHALLENGE_FAILED" };
        }

        // Per-IP limit (suite D18): only when Turnstile is off and EmDash provides the visitor IP.
        let ipHash = "";
        if (!turnstileEnabled(config) && remoteIp) {
          ipHash = await hashVisitorIp(config.hmacSecret, remoteIp);
          if (await isIpRateLimited(actx.storage.attendees, budget, ipHash, nowMs)) {
            return { ok: false, error: "RATE_LIMITED" };
          }
        }

        const collection = resolveCollection(config, body.collection);
        if (!collection) return { ok: false, error: "EVENT_NOT_FOUND" };
        const extraCollection = collection === eventCollections(config)[0] ? "" : collection;
        const event = await budget.call(() => ctx.content!.get(collection, eventId));
        if (!event) return { ok: false, error: "EVENT_NOT_FOUND" };
        if (event.status !== "published") return { ok: false, error: "EVENT_NOT_PUBLISHED" };
        if (isTicketManaged(event)) return { ok: false, error: "EVENT_TICKETED" };
        const eventData = (event.data ?? {}) as Record<string, unknown>;

        const { config: attendanceConfig } = await resolveAttendance(
          (ctx.storage as any).attendance_settings, budget, event
        );
        const capacity = attendanceConfig.capacity;

        if (!attendanceConfig.enabled) return { ok: false, error: "RSVP_DISABLED" };
        if (quantity > attendanceConfig.maxPerRegistration) {
          return { ok: false, error: "MAX_QUANTITY_EXCEEDED", maxAllowed: attendanceConfig.maxPerRegistration };
        }
        // Registration questions are validated before any seat is reserved.
        const checked = validateAnswers(attendanceConfig.questions ?? [], body.answers);
        if (!checked.ok) return { ok: false, error: "INVALID_ANSWERS", fields: checked.errors };

        // Capacity and waitlist are pooled across all translations of the event.
        const poolKey = poolKeyOfEvent(event);
        const ledgerKey = capacityLedgerKey(poolKey, occurrenceStart);

        // Never reserve seats unless the attendee and waitlist writes can still follow:
        // one CAS attempt (2) + attendee put (1) + waitlist put (1).
        if (!budget.has(4)) return { ok: false, error: "TRY_AGAIN" };
        const eventTimes = eventTiming(eventData, occurrenceStart);
        // Events without their own time zone use the site's chosen one (Registration settings).
        const timing = eventTimes && !eventTimes.timezone && config.defaultTimezone ? { ...eventTimes, timezone: config.defaultTimezone } : eventTimes;
        // Keep 4 RPCs after reserving: attendee create 1 + release 2 + winner read 1 (email queues at 0 cost; waitlist put uses 1 of the release calls on winner).
        const attempts = Math.max(1, Math.min(2, Math.floor((budget.remaining - 4) / 2)));
        const reservation = await reserveSeats(actx.kv, budget, ledgerKey, {
          quantity, capacity, allowWaitlist: attendanceConfig.allowWaitlist, occurrenceStart, poolKey, maxAttempts: attempts,
          label: String(eventData.title ?? "").slice(0, 200) || undefined,
          timezone: timing?.timezone,
        });
        if (!reservation.ok) {
          return {
            ok: false,
            status: "full",
            error: reservation.reason === "FULL"
              ? "Registration is full for this date."
              : "High registration traffic. Please try again in a moment.",
          };
        }
        const position = reservation.status === "waitlist" ? reservation.position : undefined;

        const now = new Date(nowMs).toISOString();
        const cancelToken = await generateCancelToken(config.hmacSecret, attendeeId, now, eventId);
        const eventTitle = String(eventData.title ?? "the event").slice(0, 200);
        const waitlistEntryId = reservation.status === "waitlist" ? `wl_${crypto.randomUUID()}` : undefined;

        // Calls still needed after this point: attendee create 1, waitlist entry 1 (waitlist only), email 1.
        const callsAfterCreate = 1 + (reservation.status === "waitlist" ? 1 : 0);
        const canEmailNow = !!ctx.email?.send && budget.remaining >= callsAfterCreate + 1;
        const queueEmail = !!ctx.email?.send && !canEmailNow;
        const needsApproval = attendanceConfig.requireApproval && reservation.status === "going";
        const status: AttendeeStatus = reservation.status === "waitlist" ? "waitlist" : needsApproval ? "pending" : "going";
        const approvalDueAt = needsApproval ? approvalDeadline(nowMs, attendanceConfig.approvalHours, timing?.startsAt) : undefined;
        const hasOrganiserAddress = Boolean(attendanceConfig.replyTo || config.replyTo);

        const record: AttendeeRecord = {
          id: attendeeId,
          eventId,
          translationGroup: poolKey,
          occurrenceStart,
          email,
          displayName,
          status,
          quantity,
          cancelTokenHash: await hashCancelToken(cancelToken),
          commandId,
          waitlistEntryId,
          waitlistPosition: position,
          replyTo: attendanceConfig.replyTo || undefined,
          startsAt: timing?.startsAt,
          allDay: timing?.allDay,
          timezone: timing?.timezone,
          eventTitle,
          locale,
          ...(extraCollection ? { collection: extraCollection } : {}),
          reminder: timing && !needsApproval ? "due" : undefined,
          ...(approvalDueAt ? { approvalDueAt } : {}),
          ...(needsApproval && hasOrganiserAddress ? { organiserNotice: "queued" } : {}),
          ...(queueEmail ? { mail: "queued" } : {}),
          ...(ipHash ? { ipHash } : {}),
          answers: checked.answers.length ? checked.answers : undefined,
          retainFrom: timing?.startsAt ?? now,
          createdAt: now,
          updatedAt: now,
        };
        // Create-only: if an identical request raced past the lookup, exactly one write wins.
        const created = await budget.call(() => (ctx.storage as any).attendees.compareAndSet(attendeeId, null, record)) as { applied: boolean };
        if (!created.applied) {
          // The loser returns the seats it reserved and replays the winner's outcome. Without
          // budget for the release, the reconcile job returns them (the seats have no record).
          if (budget.has(2)) {
            const attempts = Math.max(1, Math.min(3, Math.floor((budget.remaining - 1) / 2)));
            await adjustLedger(actx.kv, budget, ledgerKey,
              reservation.status === "waitlist" ? { waitlistCount: quantity } : { taken: quantity }, attempts);
          }
          const winner = budget.has(1) ? await budget.call(() => actx.storage.attendees.get(attendeeId)) : null;
          return winner
            ? replayRsvp(winner, { eventId, email, occurrenceStart, quantity })
            : { ok: false, error: "TRY_AGAIN" };
        }

        if (waitlistEntryId) {
          const entry: WaitlistEntry = {
            id: waitlistEntryId,
            eventId,
            poolKey,
            occurrenceStart,
            attendeeId,
            quantity,
            email,
            displayName,
            eventTitle,
            replyTo: attendanceConfig.replyTo || undefined,
            locale,
            position: position ?? 0,
            status: "queued",
            startsAt: timing?.startsAt,
            retainFrom: timing?.startsAt ?? occurrenceStart ?? now,
            createdAt: now,
            updatedAt: now,
          };
          await budget.call(() => (ctx.storage as any).waitlist_entries.put(waitlistEntryId, entry));
        }

        const cancelUrl = manageLink(ctx.site?.url ?? "", config, "cancel", cancelToken);
        const calendarUrl = timing ? calendarLink(ctx.site?.url ?? "", eventId, occurrenceStart, extraCollection, ctx.plugin?.id) : undefined;
        if (canEmailNow && email) {
          const deadline = status === "pending"
            ? formatInZone(approvalDueAt!, timing?.timezone, intlLocale(locale))
            : undefined;
          const msg = confirmationFor(await guestMessages(actx, budget, locale),
            { displayName, eventTitle, status, waitlistPosition: position },
            { cancelUrl, calendarUrl, deadline });
          await sendGuestEmail(actx, budget, attendanceConfig.replyTo || config.replyTo,
            { email, id: attendeeId }, msg, "RSVP email failed");
        }

        return {
          ok: true,
          attendeeId,
          status,
          ...(approvalDueAt ? { approvalDueAt } : {}),
          remaining: reservation.status === "going" ? reservation.remaining : 0,
          waitlistPosition: position,
          email: ctx.email?.send ? (queueEmail ? "queued" : "sent") : "none",
          // The email's own cancel link, for the browser that just booked. It is an HMAC over the
          // attendee; building it costs no host call, and it is the same link the email carries.
          ...(cancelUrl ? { manageUrl: cancelUrl } : {}),
        };
      },
    }),

    // What the public RSVP form needs to render for an event: open or not, seat limit, and the
    // registration questions and places left. Read-only and secret-free. ≤ 4 calls, plus the one-time schedule
    // check (≤ 5, free once an isolate has confirmed it): EmDash never runs plugin:activate for a
    // sandboxed plugin listed in astro.config, and every event page loads this route.
    "rsvp/form": pluginRoute({
      public: true,
      methods: ["GET"],
      request: { body: "none" },
      cacheControl: "no-store", // carries live availability (seatsLeft, full)
      handler: async (routeCtx, ctx) => {
        const eventId = (new URL(routeCtx.request.url).searchParams.get("eventId") ?? "").trim().slice(0, 128);
        if (!eventId) return { ok: false, error: "MISSING_EVENT" };
        const budget = new RpcBudget();
        const actx = attendanceCtx(ctx);
        await ensureSchedulesOnce(actx.kv, ctx.cron as any, new BudgetSlice(budget, 4), SCHEDULES).catch(() => "SKIPPED");
        const editable = await getEditableConfig(actx, budget);
        const eventCollection = resolveCollection(editable, new URL(routeCtx.request.url).searchParams.get("collection"));
        if (!eventCollection) return { ok: false, error: "EVENT_NOT_FOUND" };
        const event = await budget.call(() => ctx.content!.get(eventCollection, eventId));
        if (!event || event.status !== "published") return { ok: false, error: "EVENT_NOT_FOUND" };
        if (isTicketManaged(event)) return { ok: false, error: "EVENT_TICKETED" };
        const { config: settings } = await resolveAttendance((ctx.storage as any).attendance_settings, budget, event);
        // Places left for listings ("Complet"); not cached, so a booked session shows as full at
        // once. The RSVP route stays the authority. null = unlimited.
        const occurrence = (new URL(routeCtx.request.url).searchParams.get("occurrence") ?? "").trim().slice(0, 40);
        const stored = settings.capacity > 0 && budget.has(1)
          ? await budget.call(() => actx.kv.getVersioned<CapacityLedger>(capacityLedgerKey(poolKeyOfEvent(event), occurrence)))
          : null;
        const ledger = stored ? normalizeLedger(stored.value) : null;
        const seatsLeft = settings.capacity > 0 ? Math.max(0, settings.capacity - (ledger?.taken ?? 0) - (ledger?.held ?? 0)) : null;
        return {
          ok: true,
          open: settings.enabled,
          maxPerRegistration: settings.maxPerRegistration,
          allowWaitlist: settings.allowWaitlist,
          ...(settings.requireApproval ? { requiresApproval: true } : {}),
          seatsLeft,
          full: seatsLeft === 0,
          questions: settings.enabled ? settings.questions ?? [] : [],
          // Public by design; the secret key never leaves the server.
          ...(settings.enabled && turnstileEnabled(editable) ? { turnstileSiteKey: editable.turnstileSiteKey } : {}),
        };
      },
    }),

    // POST only: link scanners and prefetchers issue GETs, so a GET must never change state.
    // Email links point to the site's manage page (RsvpManage.astro), which POSTs here.
    cancel: pluginRoute({
      public: true,
      methods: ["POST"],
      request: { body: "json" },
      handler: async (routeCtx, ctx) => {
        const budget = new RpcBudget();
        const token = tokenFromBody(routeCtx.input);
        if (!isWellFormedToken(token)) return { ok: false, error: "INVALID_TOKEN" };

        const actx = attendanceCtx(ctx);
        const cancelTokenHash = await hashCancelToken(token);
        const found = await budget.call(() =>
          actx.storage.attendees.query({ where: { cancelTokenHash }, limit: 1 })
        );
        const row = found.items[0]?.data;
        if (!row || row.status === "cancelled") return { ok: false, error: "ALREADY_CANCELLED_OR_UNKNOWN" };

        const result = await cancelAttendee(actx, budget, row);
        if (!result.ok) return { ok: false, error: result.error };

        // Promote inline when the budget allows; otherwise the cron tick does it within a minute.
        // Fairness holds either way: new registrants queue behind waiting attendees.
        if (result.seatsFreed && budget.has(PROMOTION_RPC_COST)) {
          await promoteNextWaitlistEntry(actx, budget, poolKeyFor(row.translationGroup, row.eventId), row.occurrenceStart);
        }
        return { ok: true, status: "cancelled", displayName: row.displayName };
      },
    }),

    // Read-only: what a cancel or claim link refers to (event, date, seats, state), so the manage
    // page can show it before the guest confirms. POST because the token must not sit in a URL.
    // ≤ 1 call.
    "manage/lookup": pluginRoute({
      public: true,
      methods: ["POST"],
      request: { body: "json" },
      handler: async (routeCtx, ctx) => lookupManageLink(attendanceCtx(ctx), new RpcBudget(), routeCtx.input),
    }),

    "waitlist/claim": pluginRoute({
      public: true,
      methods: ["POST"],
      request: { body: "json" },
      handler: async (routeCtx, ctx) => {
        const result = await claimWaitlistSpot(attendanceCtx(ctx), new RpcBudget(), tokenFromBody(routeCtx.input));
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          status: result.attendee?.status ?? "going",
          ...(result.attendee?.approvalDueAt ? { approvalDueAt: result.attendee.approvalDueAt } : {}),
          displayName: result.attendee?.displayName,
        };
      },
    }),

    // Single-use, 10-minute links minted from the admin page. Browser navigation cannot send the
    // private-route CSRF header, so admin downloads go through this capability-token route.
    // Public "add to calendar" file for one occurrence of a published event. Needs no secret,
    // ≤ 3 calls.
    [CALENDAR_ROUTE]: pluginRoute({
      public: true,
      methods: ["GET"],
      request: { body: "none" },
      response: "raw",
      cacheControl: "public, max-age=300",
      handler: async (routeCtx, ctx) => {
        const url = new URL(routeCtx.request.url);
        const eventId = (url.searchParams.get("eventId") ?? "").trim().slice(0, 128);
        const occurrence = (url.searchParams.get("occurrence") ?? "").trim().slice(0, 40);
        const notFound = () => pluginResponse({
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: { kind: "text", value: "Event not found." },
        });
        if (!eventId || (occurrence && Number.isNaN(Date.parse(occurrence)))) return notFound();

        const budget = new RpcBudget();
        const actx = attendanceCtx(ctx);
        const eventCollection = resolveCollection(await getEditableConfig(actx, budget), url.searchParams.get("collection"));
        if (!eventCollection) return notFound();
        const event = await budget.call(() => ctx.content!.get(eventCollection, eventId));
        if (!event || event.status !== "published") return notFound();
        const timing = eventTiming((event.data ?? {}) as Record<string, unknown>, occurrence);
        if (!timing) return notFound();
        const publicUrl = ctx.content?.getPublicUrl && budget.has(1)
          ? await budget.call(() => ctx.content!.getPublicUrl!(eventCollection, eventId)).catch(() => null)
          : null;

        return pluginResponse({
          status: 200,
          headers: {
            "content-type": "text/calendar; charset=utf-8",
            "content-disposition": 'attachment; filename="event.ics"',
          },
          body: {
            kind: "text",
            value: eventIcs(event as any, timing, { occurrenceStart: occurrence, publicUrl, host: url.host }),
          },
        });
      },
    }),

    "roster/download": pluginRoute({
      public: true,
      methods: ["GET"],
      request: { body: "none" },
      response: "raw",
      handler: async (routeCtx, ctx) => {
        const token = new URL(routeCtx.request.url).searchParams.get("token");
        const exported = await downloadRoster(ctx, new RpcBudget(), token);
        if (!exported) {
          return pluginResponse({
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: { kind: "text", value: "This download link is invalid, expired, or has already been used." },
          });
        }
        return pluginResponse({
          status: 200,
          headers: {
            "content-type": exported.contentType,
            "content-disposition": `attachment; filename="${exported.filename}"`,
          },
          body: { kind: "text", value: exported.body },
        });
      },
    }),

    // Private API export for token-authenticated clients (Authorization header + admin scope).
    "roster/export": pluginRoute({
      public: false,
      permission: "content:edit_any",
      methods: ["GET"],
      request: { body: "none" },
      response: "raw",
      handler: async (routeCtx, ctx) => {
        const url = new URL(routeCtx.request.url);
        const exported = await exportRoster({
          eventId: url.searchParams.get("eventId") || undefined,
          occurrenceStart: url.searchParams.get("occurrence") || url.searchParams.get("occurrenceStart") || undefined,
          format: url.searchParams.get("format") === "html" ? "html" : "csv",
        }, ctx, new RpcBudget());
        return pluginResponse({
          status: 200,
          headers: {
            "content-type": exported.contentType,
            "content-disposition": `attachment; filename="${exported.filename}"`,
          },
          body: { kind: "text", value: exported.body },
        });
      },
    }),
  },
};

/**
 * Public routes never show a visitor EmDash's raw errors (for example a database message). An
 * unexpected failure is logged and answered with a generic "try again"; the file routes answer
 * 503. Expected outcomes still come back from the handlers as before.
 */
const PUBLIC_ROUTES = ["rsvp", "rsvp/form", "cancel", "manage/lookup", "waitlist/claim", CALENDAR_ROUTE, "roster/download"];
for (const name of PUBLIC_ROUTES) {
  const route = (plugin.routes as Record<string, any>)[name];
  if (!route?.handler) continue;
  const handler = route.handler;
  route.handler = async (routeCtx: any, ctx: any) => {
    try {
      return await handler(routeCtx, ctx);
    } catch (err) {
      // A spent call budget leaves no call for the log line; anything else is logged once.
      if (!(err instanceof RpcBudgetExceeded)) {
        try {
          await ctx.log?.error?.("Attendance public route failed", { route: name, error: String(err).slice(0, 500) });
        } catch {
          // logging is best effort
        }
      }
      if (route.response === "raw") {
        return pluginResponse({ status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: { kind: "text", value: "Temporarily unavailable. Please try again." } });
      }
      return { ok: false, error: "TRY_AGAIN" };
    }
  };
}

export default plugin;
