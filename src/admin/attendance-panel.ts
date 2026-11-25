import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import type { AttendeeRecord, WaitlistEntry } from "../domain/types";
import { LEDGER_PREFIX, RpcBudget, normalizeEmail, summarizeAnswers } from "@vermeulen.solutions/eventual-capacity";
import { eventCollections, getFreshPluginConfig, getPluginConfig, manageLink, turnstileEnabled, updatePluginConfig, type EditableConfig, type PluginConfig } from "../domain/config";
import { calendarLink, eventTiming } from "../domain/calendar";
import { guestMessages, languageName, LOCALES, normalizeLocale } from "../domain/messages";
import { generateCancelToken } from "../domain/security";
import { sendGuestEmail } from "../domain/notify";
import { ensureSchedules } from "../domain/schedules";
import { runReconcileTick } from "../domain/reconcile";
import { isLiveOccurrence } from "../domain/delete-guard";
import {
  attendanceCtx,
  cancelAttendee,
  poolKeyFor,
  promoteNextWaitlistEntry,
  moveToEndOfQueue,
  runWaitlistMaintenance,
  PROMOTION_RPC_COST,
} from "../domain/waitlist";
import { mintRosterDownload } from "./roster-export";
import { adminText, type AdminText } from "./i18n";
import { languagePack } from "../i18n";
import { resolveLocale } from "../locales/index.mjs";
import {
  filterFormBlock,
  formatOccurrence,
  heatmapBlock,
  sanitizeFilter,
  sessionsFromLedgers,
  sessionsTableBlock,
  totalsBlock,
  upcoming,
  type Filter,
} from "./overview";

type Blocks = BlockResponse["blocks"];
type Toast = BlockResponse["toast"];

const OVERVIEW = "/attendance";
const ROSTER = "/attendance/roster";
const SETTINGS = "/attendance/settings";

/**
 * Calls a list page needs after an action: ledgers 1, filter 1, attendees 1, and one to spare
 * (the settings page needs only the config, 0–2). Actions leave this much; when they can't, a
 * light page is returned instead of failing.
 */
const RENDER_COST = 4;

interface Interaction {
  type?: string;
  page?: string;
  action_id?: string;
  value?: unknown;
  values?: Record<string, unknown>;
}

function cursorFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { cursor?: unknown }).cursor === "string") {
    return (value as { cursor: string }).cursor;
  }
  return undefined;
}

function nav(t: AdminText, current?: string): Blocks[number] {
  const link = (label: string, path: string) => ({
    type: "link" as const,
    label,
    target: { kind: "plugin-page" as const, path },
    ...(path === current ? { appearance: "primary" as const } : {}),
  });
  return { type: "actions", elements: [link(t.navOverview, OVERVIEW), link(t.navRoster, ROSTER), link(t.navSettings, SETTINGS)] };
}

/** Shown after work that used most of this request's call budget. */
function lightPage(t: AdminText, toast: Toast | undefined): BlockResponse {
  return {
    toast,
    blocks: [
      nav(t),
      { type: "header", text: t.navOverview },
      { type: "context", text: t.lightDone },
    ],
  };
}

/**
 * Turnstile keys from the settings form. The secret is never shown again, so an empty secret
 * field keeps the saved one; clearing the site key turns Turnstile off and forgets the secret.
 */
function turnstilePatch(values: Record<string, unknown> | undefined): EditableConfig {
  if (!values || values.turnstileSiteKey === undefined) return {};
  const siteKey = String(values.turnstileSiteKey ?? "").trim();
  const secret = String(values.turnstileSecretKey ?? "").trim();
  if (!siteKey) return { turnstileSiteKey: "", turnstileSecretKey: "" };
  return { turnstileSiteKey: siteKey, ...(secret ? { turnstileSecretKey: secret } : {}) };
}

/** One saved filter per admin (falls back to a shared one for token callers without a user). */
function filterKey(user?: SandboxedRouteContext["user"]): string {
  return `state:admin-filter:${user?.id ?? "shared"}`;
}

export async function handleAttendanceAdmin(
  input: unknown,
  ctx: PluginContext,
  user?: SandboxedRouteContext["user"],
  uiLocale?: string
): Promise<BlockResponse> {
  const budget = new RpcBudget();
  // The admin UI's language (EmDash passes it): its pack is read first (≤ 1 call, none once
  // cached); English until the language-packs cron has stored it.
  const locale = resolveLocale(uiLocale);
  const t = adminText(await languagePack(ctx, budget, uiLocale), locale);
  const actx = attendanceCtx(ctx);
  const kv = ctx.kv as unknown as {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  const req: Interaction = input && typeof input === "object" && !Array.isArray(input) ? (input as Interaction) : {};
  const actionId = String(req.action_id ?? "");
  // Dashboard widget: the five newest registrations that still count (cancelled ones are left out,
  // as on the Registrations page), in the site's time zone when the event has none (≤ 3 calls).
  if (req.page === "widget:recent") {
    const zone = (await getPluginConfig(actx, budget)).defaultTimezone || undefined;
    const res = (await budget.call(() => actx.storage.attendees.query({ where: { status: { in: ["going", "pending", "waitlist", "attended"] } }, orderBy: { createdAt: "desc" }, limit: 5 }))) as { items: Array<{ data: AttendeeRecord }> };
    return {
      blocks: [
        {
          type: "table",
          page_action_id: "page-recent", // never paged
          columns: [{ key: "name", label: t.colAttendee }, { key: "event", label: t.colEvent }, { key: "date", label: t.colDateTime }, { key: "status", label: t.colStatus, format: "badge" }],
          rows: res.items.map(({ data: a }) => ({
            name: a.erasedAt ? "—" : a.displayName,
            event: a.eventTitle ?? "",
            date: formatOccurrence(a.occurrenceStart || a.startsAt || "", t, a.timezone || zone, locale),
            status: a.erasedAt ? t.status.erased : t.status[a.status] ?? a.status,
          })),
          empty_text: t.noRsvps,
        },
        { type: "actions", elements: [{ type: "link", label: t.navOverview, target: { kind: "plugin-page", path: OVERVIEW } }] },
      ],
    };
  }
  // Settings actions always answer with the settings page (also for a page left open from before).
  const page = req.page === SETTINGS || /^(save-config|find-personal-data|erase-personal-data)$/.test(actionId)
    ? SETTINGS
    : req.page === ROSTER ? ROSTER : OVERVIEW;
  const nowMs = Date.now();
  let toast: Toast | undefined;
  let savedFilter: Filter | undefined; // set when this request changed it (saves a read)
  const extra: Blocks = [];
  let personalDataEmail: string | undefined;
  const personalDataBlocks: Blocks = [];

  // ── Actions ───────────────────────────────────────────────────────────────────────────────

  if (req.type === "block_action" && actionId === "checkin-attendee" && typeof req.value === "string") {
    const row = await budget.call(() => actx.storage.attendees.get(req.value as string));
    if (!row || row.erasedAt || row.status !== "going") {
      toast = { message: t.checkInRefused, type: "error" };
    } else {
      const res = await budget.call(() =>
        actx.storage.attendees.updateIf(row.id, {
          where: { status: "going" },
          set: { status: "attended", checkedInAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        })
      );
      toast = res.applied
        ? { message: t.checkedIn, type: "success" }
        : { message: t.checkInRefused, type: "error" };
    }
  }

  if (req.type === "block_action" && actionId === "undo-checkin" && typeof req.value === "string") {
    // A mis-tap at the door: back to "going". Only a checked-in registration can be undone.
    const res = await budget.call(() =>
      actx.storage.attendees.updateIf(req.value as string, {
        where: { status: "attended" },
        set: { status: "going", checkedInAt: "", updatedAt: new Date().toISOString() },
      })
    );
    toast = res.applied ? { message: t.checkInUndone, type: "success" } : { message: t.undoRefused, type: "error" };
  }

  if (req.type === "block_action" && actionId === "approve-attendee" && typeof req.value === "string") {
    const row = await budget.call(() => actx.storage.attendees.get(req.value as string));
    if (!row || row.erasedAt || row.status !== "pending") {
      toast = { message: t.requestAlreadyHandled, type: "info" };
    } else {
      const config = budget.has(3) ? await getPluginConfig(actx, budget) : null;
      const canEmailNow = !!actx.email?.send && !!config && !!row.email && budget.has(2);
      const queueEmail = !!actx.email?.send && !!row.email && !canEmailNow;
      const nowIso = new Date(nowMs).toISOString();
      const res = await budget.call(() =>
        actx.storage.attendees.updateIf(row.id, {
          where: { status: "pending" },
          set: {
            status: "going",
            approvalDueAt: "",
            ...(row.startsAt ? { reminder: "due" as const } : {}),
            ...(row.organiserNotice === "queued" ? { organiserNotice: "sent" as const } : {}),
            ...(queueEmail ? { mail: "queued" as const } : row.mail === "queued" ? { mail: "sent" as const } : {}),
            updatedAt: nowIso,
          },
        })
      );
      if (!res.applied) {
        toast = { message: t.requestAlreadyHandled, type: "info" };
      } else {
        if (canEmailNow && config) {
          const site = ctx.site?.url ?? "";
          const cancelToken = await generateCancelToken(config.hmacSecret, row.id, row.createdAt, row.eventId);
          const cancelUrl = manageLink(site, config, "cancel", cancelToken);
          const calendarUrl = row.startsAt
            ? calendarLink(site, row.eventId, row.occurrenceStart, row.collection, ctx.plugin?.id)
            : undefined;
          const mt = await guestMessages(actx, budget, normalizeLocale(row.locale, config.defaultLocale));
          const msg = mt.rsvpConfirmed({
            name: row.displayName,
            title: row.eventTitle || mt.fallbackTitle,
            calendarUrl,
            cancelUrl,
          });
          await sendGuestEmail(actx, budget, config.replyTo, row, msg, "Approval confirmation email failed");
        }
        toast = { message: queueEmail ? t.approvedQueued : t.approvedSent, type: "success" };
      }
    }
  }

  if (req.type === "block_action" && actionId === "decline-attendee" && typeof req.value === "string") {
    const row = await budget.call(() => actx.storage.attendees.get(req.value as string));
    if (!row || row.erasedAt || row.status !== "pending") {
      toast = { message: t.requestAlreadyHandled, type: "info" };
    } else {
      const result = await cancelAttendee(actx, budget, row);
      if (!result.ok) {
        toast = { message: t.requestAlreadyHandled, type: "info" };
      } else {
        if (row.email && actx.email?.send && budget.has(1)) {
          const config = budget.has(3) ? await getPluginConfig(actx, budget) : null;
          if (config && budget.has(1)) {
            const mt = await guestMessages(actx, budget, normalizeLocale(row.locale, config.defaultLocale));
            await sendGuestEmail(actx, budget, config.replyTo, row,
              mt.requestDeclined({ name: row.displayName, title: row.eventTitle || mt.fallbackTitle }), "Decline email failed");
          }
        }
        if (result.seatsFreed && budget.has(PROMOTION_RPC_COST)) {
          await promoteNextWaitlistEntry(actx, budget, poolKeyFor(row.translationGroup, row.eventId), row.occurrenceStart);
        }
        toast = { message: t.declinedToast, type: "success" };
      }
    }
  }

  if (req.type === "block_action" && actionId === "cancel-attendee" && typeof req.value === "string") {
    const row = await budget.call(() => actx.storage.attendees.get(req.value as string));
    const result = row ? await cancelAttendee(actx, budget, row) : { ok: false, seatsFreed: false };
    // Promote inline when the promotion fits (warm isolate). The page may then not fit: `lightPage` is returned instead (the cron offers the seat if the promotion doesn't run here).
    if (result.ok && row && result.seatsFreed && budget.has(PROMOTION_RPC_COST)) {
      await promoteNextWaitlistEntry(actx, budget, poolKeyFor(row.translationGroup, row.eventId), row.occurrenceStart);
    }
    toast = result.ok
      ? { message: t.cancelled, type: "success" }
      : { message: t.alreadyCancelled, type: "info" };
  }

  if (req.type === "block_action" && actionId === "move-to-end" && typeof req.value === "string") {
    const res = await moveToEndOfQueue(actx, budget, req.value);
    toast = res.ok
      ? { message: t.moved, type: "success" }
      : res.error === "NOT_QUEUED"
      ? { message: t.moveRefused, type: "error" }
      : { message: t.moveRace, type: "info" };
  }

  // The maintenance buttons do a cron tick's worth of work with this request's budget, so they
  // return the light page rather than spending more calls on the full one.
  if (req.type === "block_action" && actionId === "run-maintenance") {
    const res = await runWaitlistMaintenance(actx, budget);
    return lightPage(t, {
      message: t.maintenance(res.expiredCount, res.promotedCount, Boolean(res.budgetExhausted)),
      type: "info",
    });
  }

  if (req.type === "block_action" && actionId === "run-reconcile") {
    const res = await runReconcileTick(actx, budget);
    return lightPage(
      t,
      !res
        ? { message: t.noLedgers, type: "info" }
        : res.status === "CORRECTED"
        ? {
            message: t.corrected(
              res.key,
              `${res.before.taken} → ${res.after.taken}`,
              `${res.before.held} → ${res.after.held}`,
              `${res.before.waitlistCount} → ${res.after.waitlistCount}`
            ),
            type: "success",
          }
        : { message: `${res.key}: ${t.ledgerStatus[res.status] ?? res.status}`, type: "info" }
    );
  }

  if (req.type === "page_load") {
    const fixed = await ensureSchedules(ctx.cron as any, budget);
    if (fixed.length) toast = { message: t.scheduled(fixed.join(", ")), type: "info" };
  }

  if (req.type === "form_submit" && actionId === "save-config") {
    // Two forms share this action (organiser settings, site setup): each sends only its own fields.
    const str = (key: "managePagePath" | "eventCollection" | "replyTo" | "defaultTimezone") =>
      req.values?.[key] !== undefined ? { [key]: String(req.values[key] ?? "") } : {};
    await updatePluginConfig(actx, budget, {
      ...str("managePagePath"),
      ...str("eventCollection"),
      ...str("replyTo"),
      ...(req.values?.reminderLeadHours !== undefined ? { reminderLeadHours: Number(req.values.reminderLeadHours) } : {}),
      ...(req.values?.retentionDays !== undefined ? { retentionDays: Number(req.values.retentionDays) } : {}),
      ...str("defaultTimezone"),
      ...(req.values?.defaultLocale !== undefined ? { defaultLocale: req.values.defaultLocale as any } : {}),
      ...turnstilePatch(req.values),
    });
    toast = { message: t.settingsSaved, type: "success" };
  }

  if (req.type === "form_submit" && actionId === "find-personal-data") {
    const searchEmail = normalizeEmail(req.values?.eraseEmail);
    if (searchEmail) {
      personalDataEmail = searchEmail;
      const foundAttendees = (await budget.call(() =>
        actx.storage.attendees.query({ where: { email: searchEmail }, limit: 20 })
      )) as { items: Array<{ data: AttendeeRecord }> };
      const foundWaitlist = (await budget.call(() =>
        actx.storage.waitlist_entries.query({ where: { email: searchEmail }, limit: 20 })
      )) as { items: Array<{ data: WaitlistEntry }> };

      const pRows: Array<{ title: string; date: string; status: string }> = [];
      let hasErasable = false;

      for (const { data: a } of foundAttendees.items) {
        const isLive = (a.status === "going" || a.status === "pending" || a.status === "waitlist") && isLiveOccurrence(a.startsAt || a.occurrenceStart, nowMs);
        if (!isLive && a.retainFrom !== "~erased") hasErasable = true;
        pRows.push({
          title: a.eventTitle || a.eventId,
          date: formatOccurrence(a.occurrenceStart, t, a.timezone, locale),
          status: isLive ? t.liveNotErased : (a.retainFrom === "~erased" ? t.statusErased : (t.status[a.status] ?? a.status)),
        });
      }

      const attendeeIds = new Set(foundAttendees.items.map((it) => it.data.id));
      for (const { data: w } of foundWaitlist.items) {
        if (attendeeIds.has(w.attendeeId)) continue;
        const isLive = (w.status === "queued" || w.status === "offered") && isLiveOccurrence(w.startsAt || w.occurrenceStart, nowMs);
        if (!isLive && w.retainFrom !== "~erased") hasErasable = true;
        pRows.push({
          title: w.eventTitle || w.eventId,
          date: formatOccurrence(w.occurrenceStart, t, undefined, locale),
          status: isLive ? t.liveNotErased : (w.retainFrom === "~erased" ? t.statusErased : w.status),
        });
      }

      personalDataBlocks.push({
        type: "table",
        page_action_id: "page-personal-data",
        columns: [
          { key: "title", label: t.colEventTitle },
          { key: "date", label: t.colDateTime },
          { key: "status", label: t.colStatus, format: "badge" },
        ],
        rows: pRows,
        empty_text: t.noPersonalDataFound,
      });

      if (hasErasable) {
        personalDataBlocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "erase-personal-data",
              label: t.erasePersonalData,
              style: "danger",
              value: searchEmail,
              confirm: {
                title: t.eraseConfirmTitle,
                text: t.eraseConfirmText,
                confirm: t.eraseConfirmButton,
                deny: t.keep,
              },
            },
          ],
        });
      }
    }
  }

  if (req.type === "block_action" && actionId === "erase-personal-data") {
    const eraseEmail = normalizeEmail(req.value);
    if (eraseEmail) {
      const foundAttendees = (await budget.call(() =>
        actx.storage.attendees.query({ where: { email: eraseEmail }, limit: 20 })
      )) as { items: Array<{ data: AttendeeRecord }> };
      const foundWaitlist = (await budget.call(() =>
        actx.storage.waitlist_entries.query({ where: { email: eraseEmail }, limit: 20 })
      )) as { items: Array<{ data: WaitlistEntry }> };

      const nowIso = new Date(nowMs).toISOString();
      let erasedCount = 0;
      const erasableAttendees = foundAttendees.items
        .map((it) => it.data)
        .filter((a) => a.retainFrom !== "~erased" && !((a.status === "going" || a.status === "pending" || a.status === "waitlist") && isLiveOccurrence(a.startsAt || a.occurrenceStart, nowMs)));
      const erasableWaitlist = foundWaitlist.items
        .map((it) => it.data)
        .filter((w) => w.retainFrom !== "~erased" && !((w.status === "queued" || w.status === "offered") && isLiveOccurrence(w.startsAt || w.occurrenceStart, nowMs)));

      const toEraseA = erasableAttendees.slice(0, 6);
      for (const a of toEraseA) {
        if (!budget.has(1)) break;
        const res = await budget.call(() =>
          actx.storage.attendees.updateIf(a.id, {
            where: { email: a.email },
            set: { displayName: "", email: "", answers: [] as any, replyTo: "" as any, ipHash: "", retainFrom: "~erased", erasedAt: nowIso },
          })
        );
        if (res.applied) erasedCount++;
      }

      const remainingBudgetForWaitlist = Math.max(0, 6 - toEraseA.length);
      const toEraseW = erasableWaitlist.slice(0, remainingBudgetForWaitlist);
      for (const w of toEraseW) {
        if (!budget.has(1)) break;
        const res = await budget.call(() =>
          actx.storage.waitlist_entries.updateIf(w.id, {
            where: { email: w.email },
            set: { displayName: "", email: "", retainFrom: "~erased", erasedAt: nowIso },
          })
        );
        if (res.applied) erasedCount++;
      }

      const totalErasable = erasableAttendees.length + erasableWaitlist.length;
      const moreRemain = totalErasable > erasedCount;
      toast = moreRemain
        ? { message: t.erasedMore(erasedCount), type: "info" }
        : { message: t.erasedAll(erasedCount), type: "success" };

      if (!budget.has(RENDER_COST)) return lightPage(t, toast);
    }
  }

  if (req.type === "form_submit" && actionId === "apply-filter") {
    const pool = String(req.values?.pool ?? "");
    const occurrence = String(req.values?.occurrence ?? "");
    savedFilter = { ...(pool ? { pool } : {}), ...(pool && occurrence ? { occurrence } : {}) };
    await budget.call(() => kv.set(filterKey(user), savedFilter));
  }

  if (req.type === "block_action" && actionId === "view-session" && typeof req.value === "string") {
    // "View list" on a row of the events table: the value is "pool\noccurrence".
    const [pool = "", occurrence = ""] = req.value.split("\n");
    savedFilter = { ...(pool ? { pool } : {}), ...(pool && occurrence ? { occurrence } : {}) };
    await budget.call(() => kv.set(filterKey(user), savedFilter));
  }

  if (req.type === "block_action" && actionId === "toggle-cancelled") {
    const current = await budget.call(() => kv.get<Filter>(filterKey(user)));
    const { cancelled, ...rest } = current ?? {};
    savedFilter = cancelled ? rest : { ...rest, cancelled: true };
    await budget.call(() => kv.set(filterKey(user), savedFilter));
  }

  if (req.type === "block_action" && actionId === "clear-filter") {
    savedFilter = {};
    await budget.call(() => kv.set(filterKey(user), savedFilter));
  }

  if (req.type === "block_action" && (actionId === "prepare-export" || actionId === "prepare-export-html" || actionId === "prepare-export-csv")) {
    // Distinct ids avoid a duplicate React key; the old `prepare-export` id (with `value`) still
    // works for an admin page that was open before the update.
    const requested = actionId === "prepare-export" ? req.value : actionId.slice("prepare-export-".length);
    const format = requested === "html" ? "html" : "csv";
    // The file follows the event shown on the page: the buttons carry it ("pool\noccurrence"), so
    // the door list's own pick of the next event counts too. Older pages fall back to the filter.
    const [pool = "", occurrence = ""] = typeof req.value === "string" && actionId !== "prepare-export" ? req.value.slice(0, 300).split("\n") : [];
    const currentFilter: Filter | null = typeof req.value === "string" && actionId !== "prepare-export"
      ? { ...(pool ? { pool } : {}), ...(pool && occurrence ? { occurrence } : {}) }
      : savedFilter ?? (await budget.call(() => kv.get<Filter>(filterKey(user))));
    let eventTitle = "";
    if (currentFilter?.pool) {
      const ledgers = (await budget.call(() => kv.list(LEDGER_PREFIX))) as Array<{ key: string; value: unknown }>;
      const base = `${LEDGER_PREFIX}${currentFilter.pool}`;
      const row = ledgers.find((l) => l.key === base || l.key.startsWith(`${base}:`));
      eventTitle = String((row?.value as { label?: string } | undefined)?.label ?? "");
    }
    const link = await mintRosterDownload(
      ctx,
      budget,
      {
        format,
        locale,
        ...(currentFilter?.pool ? { poolKey: currentFilter.pool, ...(eventTitle ? { title: eventTitle } : {}) } : {}),
        ...(currentFilter?.occurrence ? { occurrenceStart: currentFilter.occurrence } : {}),
      },
      ctx.plugin?.id
    );
    extra.push(
      link
        ? {
            type: "actions",
            elements: [{
              type: "link",
              label: format === "csv" ? t.downloadCsv : t.downloadHtml,
              target: { kind: "external", url: link.url },
              appearance: "primary",
            }],
          }
        : { type: "banner", title: t.noSiteUrl, description: t.noSiteUrlBody, variant: "error" }
    );
    if (link) extra.push({ type: "context", text: t.linkNote });
  }

  // ── Render ────────────────────────────────────────────────────────────────────────────────

  if (page === SETTINGS) {
    if (!budget.has(2)) return lightPage(t, toast);
    // Saving the site-setup form keeps that section open, so its result stays in view.
    const setupOpen = actionId === "save-config" && req.values?.eventCollection !== undefined;
    return { toast, blocks: settingsBlocks(t, await getFreshPluginConfig(actx, budget, nowMs), ctx.plugin?.id ?? "eventual-attendance", personalDataEmail, personalDataBlocks, setupOpen) };
  }

  if (!budget.has(RENDER_COST)) return lightPage(t, toast);

  let pending: AttendeeRecord[] | undefined;
  if (page === OVERVIEW && budget.has(RENDER_COST + 1)) {
    pending = ((await budget.call(() =>
      actx.storage.attendees.query({ where: { status: "pending" }, limit: 50 })
    )) as { items: Array<{ data: AttendeeRecord }> }).items.map((it) => it.data).filter((a) => !a.erasedAt);
  }

  const allSessions = upcoming(sessionsFromLedgers(await budget.call(() => kv.list(LEDGER_PREFIX))), nowMs);
  const sessionZones = new Map<string, string>();
  for (const s of allSessions) if (s.timezone) sessionZones.set(`${s.poolKey}\0${s.occurrenceStart}`, s.timezone);
  // Events without a time zone of their own use the site's default one once it is read below.
  let siteZone: string | undefined;
  const zoneFor = (att: AttendeeRecord) =>
    att.timezone || sessionZones.get(`${poolKeyFor(att.translationGroup, att.eventId)}\0${att.occurrenceStart}`) || siteZone;
  // A single event has no occurrence: its booking still knows when it starts.
  const when = (att: AttendeeRecord) => formatOccurrence(att.occurrenceStart || att.startsAt || "", t, zoneFor(att), locale);
  let filter = sanitizeFilter(savedFilter ?? (await budget.call(() => kv.get<Filter>(filterKey(user)))), allSessions);
  // At the door there is usually one event: pick it rather than asking.
  const pools = new Set(allSessions.map((s) => s.poolKey));
  if (page === ROSTER && !filter.pool && pools.size === 1) filter = { pool: [...pools][0]! };
  // Otherwise the door list opens on today's or the next dated event (sessions are sorted by date,
  // undated last), says so, and leaves the saved choice alone.
  // Single events keep their date in the content, not the ledger: one read of the published
  // events (2 calls) gives it, here and on the Registrations page.
  type Item = { id: string; translationGroup?: string; data?: Record<string, unknown> };
  const readEvents = async (): Promise<Item[]> => {
    const config = await getPluginConfig(actx, budget);
    siteZone = config.defaultTimezone || undefined;
    return ((await budget.call(() => ctx.content!.list(eventCollections(config)[0]!, { limit: 100, where: { status: "published" } }))) as { items: Item[] }).items;
  };
  let next: { pool: string; occurrence: string; label: string; at: string; zone?: string } | undefined;
  const first = allSessions[0];
  if (page === ROSTER && !filter.pool) {
    if (first?.occurrenceStart) next = { pool: first.poolKey, occurrence: first.occurrenceStart, label: first.label, at: first.occurrenceStart, zone: first.timezone };
    if (allSessions.some((s) => !s.occurrenceStart) && budget.has(5)) {
      for (const { id, translationGroup, data = {} } of await readEvents()) {
        const timing = eventTiming(data);
        const s = timing && allSessions.find((x) => x.poolKey === (translationGroup || id) && !x.occurrenceStart);
        const at = timing ? Date.parse(timing.startsAt) : NaN;
        if (s && at >= nowMs - 12 * 3_600_000 && (!next || at < Date.parse(next.at))) {
          next = { pool: s.poolKey, occurrence: "", label: s.label, at: timing.startsAt, zone: timing.timezone || undefined };
        }
      }
    }
  }
  if (next) filter = { pool: next.pool, ...(next.occurrence ? { occurrence: next.occurrence } : {}) };

  const where = filter.pool
    ? { translationGroup: filter.pool, ...(filter.occurrence ? { occurrenceStart: filter.occurrence } : {}) }
    : undefined;
  const q = String(req.values?.q ?? "").trim().toLowerCase().slice(0, 80);
  const named = (a: AttendeeRecord) => !q || (!a.erasedAt && (a.displayName.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)));
  type Page = { items: Array<{ data: AttendeeRecord }>; cursor?: string; hasMore: boolean };
  /** Reads pages of 100 until `want` matches are found or this request's calls run low. */
  const scan = async (match: (a: AttendeeRecord) => boolean, want: number, from?: string) => {
    const found: AttendeeRecord[] = [];
    let cursor = from;
    let pages = 0;
    do {
      const res = (await budget.call(() => actx.storage.attendees.query({ where, limit: 100, cursor }))) as Page;
      found.push(...res.items.map((it) => it.data).filter(match));
      cursor = res.hasMore ? res.cursor : undefined;
    } while (cursor && found.length < want && ++pages < 3 && budget.has(1));
    return { found, cursor };
  };

  // A chosen event narrows only the name list. It is remembered between visits, so it says so
  // plainly, with the way back next to it.
  const chosen = allSessions.find((s) => s.poolKey === filter.pool);
  const filterBlocks = (submitLabel: string, searchLabel: string): Blocks => [
    filterFormBlock(allSessions, filter, t, locale, { q, searchLabel, submitLabel }),
    ...(chosen && !next && (page !== ROSTER || pools.size > 1)
      ? [
          ...(page === ROSTER ? [] : [{
            type: "banner" as const,
            title: t.filterOn(chosen.label + (filter.occurrence ? ` · ${formatOccurrence(filter.occurrence, t, chosen.timezone, locale)}` : "")),
            description: t.filterOnBody,
          }]),
          { type: "actions" as const, elements: [{ type: "button" as const, action_id: "clear-filter", label: t.showAllEvents, style: "primary" as const }] },
        ]
      : []),
  ];

  // The printable list and CSV of the event shown (all events when none is).
  const fileBlocks = (intro: string): Blocks => [
    { type: "divider" },
    { type: "context", text: intro },
    {
      type: "actions",
      elements: ["html", "csv"].map((format) => ({
        type: "button" as const,
        action_id: `prepare-export-${format}`,
        label: format === "html" ? t.preparePrintable : t.prepareCsv,
        value: `${filter.pool ?? ""}\n${filter.occurrence ?? ""}`,
      })),
    },
    ...extra,
  ];

  const cancelButton = (att: AttendeeRecord) => ({
    type: "button" as const,
    action_id: "cancel-attendee",
    label: t.cancelRsvp,
    style: "danger" as const,
    value: att.id,
    // "Cancel" alone would read as "close this dialog".
    confirm: { title: t.cancelTitle(att.displayName), text: t.cancelText, confirm: t.cancelConfirm, deny: t.keep },
  });
  const declineButton = (att: AttendeeRecord) => ({
    type: "button" as const,
    action_id: "decline-attendee",
    label: t.decline,
    style: "danger" as const,
    value: att.id,
    confirm: { title: t.declineTitle(att.displayName), text: t.declineText, confirm: t.decline, deny: t.keep },
  });
  const mainButton = (att: AttendeeRecord) =>
    att.status === "going"
      ? { type: "button" as const, action_id: "checkin-attendee", label: t.checkIn, value: att.id }
      : att.status === "attended"
      ? { type: "button" as const, action_id: "undo-checkin", label: t.undoCheckIn, value: att.id }
      : att.status === "pending"
      ? { type: "button" as const, action_id: "approve-attendee", label: t.approve, style: "primary" as const, value: att.id }
      : att.status === "waitlist"
      ? {
          type: "button" as const,
          action_id: "move-to-end",
          label: t.moveToEnd,
          value: att.id,
          confirm: { title: t.moveTitle(att.displayName), text: t.moveText, confirm: t.moveConfirm, deny: t.keep },
        }
      : undefined;
  const lastButton = (att: AttendeeRecord) =>
    att.status === "pending" ? declineButton(att) : att.status !== "cancelled" ? cancelButton(att) : undefined;
  const statusOf = (att: AttendeeRecord) => (att.erasedAt ? t.status.erased : t.status[att.status] ?? att.status);
  /** One person as text plus buttons: unlike table columns, these stay usable on a phone. */
  const card = (att: AttendeeRecord, note?: string): Blocks => {
    const elements = att.erasedAt ? [] : [mainButton(att), lastButton(att)].filter((e): e is NonNullable<typeof e> => !!e);
    return [
      {
        type: "section",
        text: [
          att.erasedAt ? "—" : att.displayName,
          note ?? statusOf(att),
          t.places(att.quantity || 1),
          att.eventTitle ?? "",
          att.occurrenceStart ? when(att) : "",
          att.erasedAt ? "" : att.email,
          att.erasedAt ? "" : summarizeAnswers(att.answers),
        ].filter(Boolean).join(" · "),
      },
      ...(elements.length ? [{ type: "actions" as const, elements }] : []),
    ];
  };

  // ── Door list ─────────────────────────────────────────────────────────────────────────────

  if (page === ROSTER) {
    const blocks: Blocks = [nav(t, page), { type: "header", text: t.rosterHeader }, { type: "context", text: t.rosterIntro }];
    blocks.push(...filterBlocks(t.doorShow, t.doorSearch));
    if (next) blocks.push({ type: "context", text: t.doorNextEvent(`${next.label} · ${formatOccurrence(next.at, t, next.zone || siteZone, locale)}`) });
    const files = fileBlocks(t.doorPrintIntro);
    if (!filter.pool) {
      blocks.push({ type: "empty", title: t.doorChooseTitle, description: allSessions.length ? t.doorChooseText : t.noUpcoming, size: "sm" }, ...files);
      return { toast, blocks };
    }
    const atDoor = (a: AttendeeRecord) => !a.erasedAt && (a.status === "going" || a.status === "attended");
    const { found, cursor } = await scan((a) => atDoor(a) && named(a), 60, actionId === "page-roster" ? cursorFrom(req.value) : undefined);
    if (!q) {
      const inCount = found.filter((a) => a.status === "attended").length;
      blocks.push({ type: "header", text: t.doorCount(inCount, found.length, !!cursor) });
    }
    for (const att of found) {
      const isIn = att.status === "attended";
      blocks.push({
        type: "section",
        text: [
          att.displayName,
          (att.quantity || 1) > 1 ? t.places(att.quantity) : "",
          filter.occurrence ? "" : att.occurrenceStart ? when(att) : "",
          isIn ? t.doorCheckedAt(clock(att.checkedInAt, zoneFor(att))) : "",
          summarizeAnswers(att.answers),
        ].filter(Boolean).join(" · "),
        accessory: isIn
          ? { type: "button", action_id: "undo-checkin", label: t.undoCheckIn, value: att.id }
          : { type: "button", action_id: "checkin-attendee", label: t.checkIn, style: "primary", value: att.id },
      });
    }
    if (!found.length) blocks.push({ type: "empty", title: q ? t.searchNone : t.doorEmpty, size: "sm" });
    if (cursor) blocks.push({ type: "actions", elements: [{ type: "button", action_id: "page-roster", label: t.doorNext, value: cursor }] });
    blocks.push(...files);
    return { toast, blocks };
  }

  // ── Registrations ─────────────────────────────────────────────────────────────────────────

  const blocks: Blocks = [nav(t, page), { type: "header", text: t.navOverview }];

  if (pending?.length) {
    blocks.push({ type: "banner", title: t.attentionTitle(pending.length >= 50 ? "50+" : String(pending.length)), description: t.attentionText, variant: "alert" });
    for (const att of pending.slice(0, 8)) {
      blocks.push(...card(att, att.approvalDueAt ? t.decideBy(formatOccurrence(att.approvalDueAt, t, zoneFor(att), locale)) : undefined));
    }
    if (pending.length > 8) blocks.push({ type: "context", text: t.attentionMore(pending.length - 8) });
    blocks.push({ type: "divider" });
  }

  // One read of the events gives single events their dates (their ledgers have none) and names
  // the ticketed ones: paid places live in Tickets, so this page says where to find them.
  const dates = new Map<string, string>();
  const ticketed: Array<{ label: string; date: string }> = [];
  if (budget.has(4)) {
    for (const { id, translationGroup, data = {} } of await readEvents()) {
      const timing = eventTiming(data);
      if (timing) dates.set(translationGroup || id, timing.startsAt);
      if (data.inventory_mode === "tickets" && (!timing || Date.parse(timing.startsAt) >= nowMs - 12 * 3_600_000)) {
        ticketed.push({ label: String(data.title ?? ""), date: timing ? formatOccurrence(timing.startsAt, t, timing.timezone || siteZone, locale) : "" });
      }
    }
  }
  blocks.push(
    totalsBlock(allSessions, t.scopeAll, t, pending?.length),
    { type: "header", text: t.upcomingSessions },
    sessionsTableBlock(allSessions.map((s) => (s.timezone || !siteZone ? s : { ...s, timezone: siteZone })), t, locale, dates)
  );
  if (ticketed.length) blocks.push(
    { type: "header", text: t.ticketedHeader },
    { type: "context", text: t.ticketedIntro },
    {
      type: "table",
      page_action_id: "page-ticketed", // never paged: no cursor is sent
      columns: [{ key: "label", label: t.colEvent }, { key: "date", label: t.colDateTimeLower }],
      rows: ticketed,
    },
    { type: "actions", elements: [{ type: "link", label: t.openOrders, target: { kind: "external", url: `${ctx.site?.url ?? ""}/_emdash/admin/plugins/eventual-tickets/orders` }, appearance: "secondary" }] }
  );
  const heatmap = heatmapBlock(allSessions, t);
  if (heatmap) blocks.push({ type: "accordion", label: t.heatmapHeader, blocks: [{ type: "context", text: t.heatmapIntro }, heatmap] });

  blocks.push({ type: "divider" }, { type: "header", text: t.attendees }, ...filterBlocks(t.showAttendees, t.filterSearch));

  if (q) {
    // An email address is looked up directly; a name is searched in the selected event's list.
    const email = q.includes("@") ? normalizeEmail(q) : "";
    let found: AttendeeRecord[];
    let cursor: string | undefined;
    if (email) {
      found = ((await budget.call(() => actx.storage.attendees.query({ where: { email }, limit: 50 }))) as Page).items
        .map((it) => it.data)
        .filter((a) => (!filter.pool || poolKeyFor(a.translationGroup, a.eventId) === filter.pool) && (!filter.occurrence || a.occurrenceStart === filter.occurrence));
    } else {
      ({ found, cursor } = await scan(named, 20));
    }
    blocks.push({ type: "context", text: `${found.length ? t.searchFound(Math.min(found.length, 20)) : t.searchNone}${cursor ? ` ${t.searchPartial}` : ""}` });
    for (const att of found.slice(0, 20)) blocks.push(...card(att));
    return { blocks, toast };
  }

  // Cancelled registrations only get in the way of "who is coming": hidden unless asked for.
  const listWhere = filter.cancelled ? where : { ...where, status: { in: ["going", "pending", "waitlist", "attended"] } };
  const result = (await budget.call(() =>
    actx.storage.attendees.query({ where: listWhere, limit: 25, cursor: actionId === "page-attendees" ? cursorFrom(req.value) : undefined })
  )) as Page;
  blocks.push({
    type: "table",
    page_action_id: "page-attendees",
    next_cursor: result.hasMore ? result.cursor : undefined,
    columns: [
      { key: "displayName", label: t.colAttendee },
      { key: "email", label: t.colEmail },
      { key: "status", label: t.colStatus, format: "badge" },
      { key: "quantity", label: t.colSeats, format: "number" },
      { key: "occurrence", label: t.colDateTime },
      { key: "answers", label: t.colAnswers },
      { key: "action", label: t.colAction, format: "element" },
      { key: "cancelAction", label: t.colCancel, format: "element" },
    ],
    rows: result.items.map(({ data: att }) => ({
      displayName: att.erasedAt ? "—" : att.displayName,
      email: att.erasedAt ? "—" : att.email,
      status: statusOf(att),
      quantity: att.quantity || 1,
      occurrence: when(att),
      answers: att.erasedAt ? "" : summarizeAnswers(att.answers),
      action: att.erasedAt ? undefined : mainButton(att),
      cancelAction: att.erasedAt ? undefined : lastButton(att),
    })),
    empty_text: filter.pool ? t.noAttendeesSelection : t.noRsvps,
  });
  blocks.push(
    { type: "context", text: filter.cancelled ? t.cancelledShown : t.cancelledHidden },
    { type: "actions", elements: [{ type: "button", action_id: "toggle-cancelled", label: filter.cancelled ? t.hideCancelled : t.showCancelled }] }
  );
  if (result.items.length) blocks.push({ type: "context", text: t.phoneHint });
  blocks.push(...fileBlocks(t.listFilesIntro));

  return { blocks, toast };
}

/**
 * "18:42" in the event's time zone. An event without a zone gets "18:42 UTC": the server's own
 * zone is UTC on Cloudflare, and an unlabelled time an hour or two off would look like a bug.
 */
function clock(iso: string | undefined, timeZone?: string): string {
  if (!iso) return "";
  const at = (zone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(iso));
  try {
    if (timeZone) return at(timeZone);
  } catch {
    // an invalid zone name: fall through to UTC
  }
  return `${at("UTC")} UTC`;
}

function settingsBlocks(t: AdminText, config: PluginConfig, pluginId: string, personalDataEmail: string | undefined, personalDataBlocks: Blocks, setupOpen: boolean): Blocks {
  return [
    nav(t, SETTINGS),
    { type: "header", text: t.settingsHeader },
    {
      type: "form",
      block_id: "config",
      fields: [
        { type: "text_input", action_id: "replyTo", label: t.fieldReplyTo, initial_value: config.replyTo },
        { type: "number_input", action_id: "reminderLeadHours", label: t.fieldReminders, min: 0, max: 168, initial_value: config.reminderLeadHours },
        {
          type: "select",
          action_id: "defaultLocale",
          label: t.fieldLocale,
          options: LOCALES.map((value) => ({ label: languageName(value), value })),
          initial_value: config.defaultLocale,
        },
        { type: "number_input", action_id: "retentionDays", label: t.fieldRetentionDays, min: 30, max: 3650, initial_value: config.retentionDays },
        { type: "text_input", action_id: "defaultTimezone", label: t.fieldDefaultTimezone, placeholder: "Europe/Zurich", initial_value: config.defaultTimezone },
      ],
      submit: { label: t.save, action_id: "save-config" },
    },
    { type: "divider" },
    { type: "header", text: t.personalDataHeader },
    { type: "context", text: t.personalDataIntro },
    {
      type: "form",
      block_id: "personal-data",
      fields: [{ type: "text_input", action_id: "eraseEmail", label: t.fieldEraseEmail, initial_value: personalDataEmail ?? "" }],
      submit: { label: t.findPersonalData, action_id: "find-personal-data" },
    },
    ...personalDataBlocks,
    { type: "divider" },
    {
      type: "accordion",
      label: t.siteSetupHeader,
      default_open: setupOpen,
      blocks: [
        { type: "context", text: t.settingsIntro },
        {
          type: "form",
          block_id: "site-setup",
          fields: [
            { type: "text_input", action_id: "eventCollection", label: t.fieldCollections, initial_value: config.eventCollection },
            { type: "text_input", action_id: "managePagePath", label: t.fieldManagePath, initial_value: config.managePagePath },
            { type: "text_input", action_id: "turnstileSiteKey", label: t.fieldTurnstileSiteKey, initial_value: config.turnstileSiteKey },
            {
              type: "text_input",
              action_id: "turnstileSecretKey",
              label: t.fieldTurnstileSecret,
              placeholder: config.turnstileSecretKey ? t.turnstileSecretSaved : "",
              initial_value: "",
            },
          ],
          submit: { label: t.save, action_id: "save-config" },
        },
        { type: "context", text: turnstileEnabled(config) ? t.turnstileOn : t.turnstileOff },
        { type: "context", text: t.componentsHint(pluginId) },
        { type: "context", text: t.tasksIntro },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "run-maintenance", label: t.runMaintenance },
            { type: "button", action_id: "run-reconcile", label: t.runReconcile },
          ],
        },
      ],
    },
  ];
}
