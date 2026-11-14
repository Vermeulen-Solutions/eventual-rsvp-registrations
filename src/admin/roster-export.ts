import type { PluginContext } from "emdash/plugin";
import type { AttendeeRecord } from "../domain/types";
import type { RpcBudget } from "@vermeulen.solutions/eventual-capacity";
import { hashToken, isWellFormedToken } from "../domain/security";
import { formatInZone, summarizeAnswers } from "@vermeulen.solutions/eventual-capacity";
import { eventCollections, getPluginConfig } from "../domain/config";
import { adminText } from "./i18n";
import { languagePack } from "../i18n";
import { localeDirection, resolveLocale } from "../locales/index.mjs";
import { intlLocale } from "../domain/messages";

export interface RosterExportOptions {
  eventId?: string;
  /** The roster page's event filter: every translation of one event shares this pool key. */
  poolKey?: string;
  occurrenceStart?: string;
  /** Event title for the file's header when the pool's records carry none. */
  title?: string;
  format?: "csv" | "html";
  /** Language of the file (the admin UI's when the link was made). */
  locale?: string; // shipped language tag (resolveLocale)
}

export interface RosterFile {
  contentType: string;
  filename: string;
  body: string;
}

/**
 * Raw plugin routes may not serve active same-origin types (text/html, …), so the printable
 * roster is delivered as an attachment the organiser opens locally, never rendered on-site.
 */
const HTML_DOWNLOAD_TYPE = "application/octet-stream";

const EXPORT_PREFIX = "export:";
const EXPORT_TTL_MS = 10 * 60 * 1000;

interface ExportGrant extends RosterExportOptions {
  expiresAt: string;
}

function escapeCsv(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '""';
  let str = String(value);
  // Neutralise spreadsheet formula injection (=, +, -, @, full-width forms, tab, CR).
  if (/^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeFilenamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60) || "events";
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const DEFAULT_PLUGIN_ID = "eventual-attendance";

/** Mints a single-use download link (1 RPC). Only the token's SHA-256 is stored. */
export async function mintRosterDownload(
  ctx: PluginContext,
  budget: RpcBudget,
  options: RosterExportOptions,
  pluginId: string = ctx.plugin?.id || DEFAULT_PLUGIN_ID
): Promise<{ url: string; expiresAt: string } | null> {
  const siteUrl = String(ctx.site?.url ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(siteUrl)) return null;
  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  const grant: ExportGrant = { ...options, expiresAt };
  const key = `${EXPORT_PREFIX}${await hashToken(token)}`;
  await budget.call(() => ctx.kv.set(key, grant));
  return { url: `${siteUrl}/_emdash/api/plugins/${pluginId || DEFAULT_PLUGIN_ID}/roster/download?token=${token}`, expiresAt };
}

/** Redeems a download token (2 RPCs) and builds the file with the remaining budget. */
export async function downloadRoster(
  ctx: PluginContext,
  budget: RpcBudget,
  token: string | null
): Promise<RosterFile | null> {
  if (!isWellFormedToken(token)) return null;
  const key = `${EXPORT_PREFIX}${await hashToken(token)}`;
  const grant = await budget.call(() => ctx.kv.getVersioned<ExportGrant>(key));
  if (!grant) return null;
  // Single use: whoever deletes the grant owns the download.
  const consumed = await budget.call(() => ctx.kv.compareAndDelete(key, grant.revision));
  if (!consumed.applied) return null;
  if (!(Date.now() < Date.parse(grant.value.expiresAt))) return null;
  return exportRoster(grant.value, ctx, budget);
}

export async function exportRoster(
  options: RosterExportOptions,
  ctx: PluginContext,
  budget: RpcBudget
): Promise<RosterFile> {
  const t = adminText(await languagePack(ctx, budget, options.locale), resolveLocale(options.locale));
  const attendeesStorage = (ctx.storage as any).attendees;
  const eventCollection = options.eventId
    ? eventCollections(await getPluginConfig(ctx as any, budget))[0]
    : undefined;

  const where: Record<string, unknown> = {};
  if (options.poolKey) where.translationGroup = options.poolKey;
  else if (options.eventId) where.eventId = options.eventId;
  if ((options.poolKey || options.eventId) && options.occurrenceStart) where.occurrenceStart = options.occurrenceStart;

  // Page through results, keeping one RPC for the event title.
  let attendees: AttendeeRecord[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    if (!budget.has(2)) {
      truncated = true;
      break;
    }
    const page = await budget.call(() =>
      attendeesStorage.query({ where: Object.keys(where).length ? where : undefined, limit: 100, cursor })
    ) as { items: Array<{ data: AttendeeRecord }>; cursor?: string; hasMore: boolean };
    attendees.push(...page.items.map((it) => it.data));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  if (options.occurrenceStart && !options.eventId) {
    attendees = attendees.filter((a) => a.occurrenceStart === options.occurrenceStart);
  }

  // Sort: 'going' first, then 'attended', then 'waitlist', then 'cancelled', alphabetically by name
  const statusWeight: Record<string, number> = {
    going: 1,
    attended: 2,
    waitlist: 3,
    cancelled: 4,
  };

  attendees.sort((a, b) => {
    const wa = statusWeight[a.status] ?? 99;
    const wb = statusWeight[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    return a.displayName.localeCompare(b.displayName);
  });

  // Bookings keep a title snapshot, so events in any configured collection get their name
  // without guessing the collection; only older records fall back to the default collection.
  const snapshot = attendees.find((a) => a.eventTitle)?.eventTitle;
  const event = options.eventId && !snapshot && budget.has(1)
    ? await budget.call(() => ctx.content!.get(eventCollection!, options.eventId!)).catch(() => null)
    : null;
  const eventTitle = String(
    options.title
    || snapshot
    || (event?.data as any)?.title
    || (options.eventId ? t.eventLabel(options.eventId) : options.poolKey ? t.rosterTitle : t.allEventsTitle)
  );
  const locale = intlLocale(resolveLocale(options.locale));
  const sessionZone = attendees.find((a) => (!options.occurrenceStart || a.occurrenceStart === options.occurrenceStart) && a.timezone)?.timezone;
  const dateLabel = options.occurrenceStart
    ? formatInZone(options.occurrenceStart, sessionZone, locale)
    : t.allDatesTitle;
  const truncationNote = truncated ? t.truncated(attendees.length) : "";

  if (options.format === "csv") {
    const headers = Object.values(t.csvHeaders);

    const lines = [headers.join(",")];
    if (truncationNote) lines.unshift(escapeCsv(truncationNote));
    for (const a of attendees) {
      const erased = Boolean(a.erasedAt);
      lines.push(
        [
          escapeCsv(a.status === "attended" ? t.yes : t.no),
          escapeCsv(erased ? "—" : a.displayName),
          escapeCsv(erased ? "—" : a.email),
          escapeCsv(erased ? t.status.erased : (t.status[a.status] ?? a.status)),
          escapeCsv(a.quantity || 1),
          escapeCsv(a.occurrenceStart || t.singleEventCsv),
          escapeCsv(a.occurrenceStart ? formatInZone(a.occurrenceStart, a.timezone, locale) : t.singleEventCsv),
          escapeCsv(a.checkedInAt || ""),
          escapeCsv(erased ? "" : summarizeAnswers(a.answers)),
          escapeCsv(a.id),
        ].join(",")
      );
    }

    const filename = `roster-${safeFilenamePart(options.eventId || options.poolKey || "events")}-${Date.now()}.csv`;
    return {
      contentType: "text/csv; charset=utf-8",
      filename,
      body: lines.join("\r\n"),
    };
  }

  // HTML Print Roster
  const rowsHtml = attendees.map((a, idx) => {
    const isAttended = a.status === "attended";
    const erased = Boolean(a.erasedAt);
    const statusClass = a.status;
    const occ = a.occurrenceStart ? formatInZone(a.occurrenceStart, a.timezone, locale) : "-";

    return `<tr>
      <td class="checkbox-col">${isAttended ? "☑" : "☐"}</td>
      <td class="idx-col">${idx + 1}</td>
      <td class="name-col"><strong>${escapeHtml(erased ? "—" : a.displayName)}</strong></td>
      <td>${escapeHtml(erased ? "—" : a.email)}</td>
      <td class="status-col"><span class="badge ${statusClass}">${escapeHtml(erased ? t.status.erased : (t.status[a.status] ?? a.status))}</span></td>
      <td class="num-col">${a.quantity || 1}</td>
      <td class="time-col">${escapeHtml(occ)}</td>
      <td class="answers-col">${escapeHtml(erased ? "" : summarizeAnswers(a.answers))}</td>
      <td class="notes-col"></td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="${resolveLocale(options.locale)}" dir="${localeDirection(resolveLocale(options.locale))}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(t.rosterTitle)}: ${escapeHtml(eventTitle)}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #fff;
      margin: 0;
      padding: 1rem;
      font-size: 13px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 0.5rem;
      margin-bottom: 1rem;
    }
    h1 { margin: 0; font-size: 1.4rem; color: #0f172a; }
    .meta { font-size: 0.85rem; color: #475569; }
    .print-btn {
      background: #0284c7;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.85rem;
    }
    @media print {
      .print-btn { display: none; }
      body { padding: 0; }
    }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th {
      background: #f1f5f9;
      text-align: left;
      padding: 6px 8px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid #cbd5e1;
    }
    td {
      padding: 6px 8px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: middle;
    }
    tr:nth-child(even) { background: #f8fafc; }
    .checkbox-col { width: 28px; text-align: center; font-size: 1.1rem; }
    .idx-col { width: 28px; color: #64748b; font-size: 0.8rem; }
    .name-col { width: 22%; }
    .status-col { width: 90px; }
    .num-col { width: 45px; text-align: center; }
    .time-col { width: 140px; font-size: 0.8rem; color: #475569; }
    .answers-col { font-size: 0.8rem; color: #334155; max-width: 220px; }
    .notes-col { width: 120px; border-left: 1px dashed #cbd5e1; }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .badge.going { background: #e0f2fe; color: #0369a1; }
    .badge.attended { background: #dcfce7; color: #15803d; }
    .badge.waitlist { background: #fef3c7; color: #b45309; }
    .badge.cancelled { background: #fee2e2; color: #b91c1c; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(eventTitle)}</h1>
      <div class="meta">${escapeHtml(t.rosterSession)}: <strong>${escapeHtml(dateLabel)}</strong> | ${escapeHtml(t.rosterTotal)}: <strong>${attendees.length}</strong> | ${escapeHtml(t.printedAt)}: ${new Date().toUTCString()}</div>
      ${truncationNote ? `<div class="meta"><strong>${escapeHtml(truncationNote)}</strong></div>` : ""}
    </div>
    <button class="print-btn" onclick="window.print()">${escapeHtml(t.printButton)}</button>
  </div>
  <table>
    <thead>
      <tr>
        <th class="checkbox-col">${escapeHtml(t.htmlHeaders[0])}</th>
        <th class="idx-col">${escapeHtml(t.htmlHeaders[1])}</th>
        <th>${escapeHtml(t.htmlHeaders[2])}</th>
        <th>${escapeHtml(t.htmlHeaders[3])}</th>
        <th>${escapeHtml(t.htmlHeaders[4])}</th>
        <th class="num-col">${escapeHtml(t.htmlHeaders[5])}</th>
        <th>${escapeHtml(t.htmlHeaders[6])}</th>
        <th>${escapeHtml(t.htmlHeaders[7])}</th>
        <th>${escapeHtml(t.htmlHeaders[8])}</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="9" style="text-align:center;padding:2rem;color:#64748b;">${escapeHtml(t.noAttendeesRegistered)}</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  return {
    contentType: HTML_DOWNLOAD_TYPE,
    filename: `roster-${safeFilenamePart(options.eventId || "events")}.html`,
    body: html,
  };
}
