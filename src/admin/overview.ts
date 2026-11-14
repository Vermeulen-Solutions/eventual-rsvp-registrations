import type { BlockResponse } from "@emdash-cms/blocks";
import { formatInZone, normalizeLedger, poolKeyFromLedgerKey, zonedParts, type CapacityLedger } from "@vermeulen.solutions/eventual-capacity";
import { adminText, type AdminText } from "./i18n";

const EN = adminText();

type Block = BlockResponse["blocks"][number];

/** One pool × occurrence, read from its seat ledger. */
export interface Session {
  key: string;
  poolKey: string;
  occurrenceStart: string;
  label: string;
  timezone?: string;
  capacity: number;
  taken: number;
  held: number;
  waitlistCount: number;
  /** Seats in use as a percentage of capacity; null when capacity is unlimited. */
  usedPct: number | null;
}

/** An occurrence counts as upcoming until 12 hours after it starts; undated single events always do. */
const UPCOMING_GRACE_MS = 12 * 3_600_000;

export function sessionsFromLedgers(entries: Array<{ key: string; value: unknown }>): Session[] {
  const sessions: Session[] = [];
  for (const { key, value } of entries) {
    const ledger = normalizeLedger(value as Partial<CapacityLedger>);
    if (!ledger) continue;
    const poolKey = ledger.poolKey || poolKeyFromLedgerKey(key, ledger.occurrenceStart);
    const used = ledger.taken + ledger.held;
    sessions.push({
      key,
      poolKey,
      occurrenceStart: ledger.occurrenceStart,
      label: ledger.label || poolKey,
      ...(ledger.timezone ? { timezone: ledger.timezone } : {}),
      capacity: ledger.capacity,
      taken: ledger.taken,
      held: ledger.held,
      waitlistCount: ledger.waitlistCount,
      usedPct: ledger.capacity > 0 ? Math.round((used / ledger.capacity) * 100) : null,
    });
  }
  return sessions;
}

export function upcoming(sessions: Session[], nowMs: number): Session[] {
  return sessions
    .filter((s) => !s.occurrenceStart || Date.parse(s.occurrenceStart) >= nowMs - UPCOMING_GRACE_MS)
    .sort((a, b) =>
      (a.occurrenceStart || "9999").localeCompare(b.occurrenceStart || "9999") || a.label.localeCompare(b.label)
    );
}

export interface Filter {
  pool?: string;
  occurrence?: string;
  /** Cancelled registrations are hidden from the list unless this is on. */
  cancelled?: boolean;
}

/** Keeps only filter values that still exist; a date only counts together with its event. */
export function sanitizeFilter(filter: unknown, sessions: Session[]): Filter {
  const f = (filter && typeof filter === "object" ? filter : {}) as Filter;
  const pool = typeof f.pool === "string" && sessions.some((s) => s.poolKey === f.pool) ? f.pool : undefined;
  const occurrence = pool && typeof f.occurrence === "string"
    && sessions.some((s) => s.poolKey === pool && s.occurrenceStart === f.occurrence && f.occurrence !== "")
    ? f.occurrence
    : undefined;
  return { ...(pool ? { pool } : {}), ...(occurrence ? { occurrence } : {}), ...(f.cancelled === true ? { cancelled: true } : {}) };
}

export function applyFilter(sessions: Session[], filter: Filter): Session[] {
  return sessions.filter((s) =>
    (!filter.pool || s.poolKey === filter.pool) && (!filter.occurrence || s.occurrenceStart === filter.occurrence)
  );
}

export function formatOccurrence(value: string, t: AdminText = EN, timezone?: string, locale: string = "en"): string {
  return value ? formatInZone(value, timezone, locale) : t.singleEvent;
}

export function totalsBlock(sessions: Session[], scope: string, t: AdminText = EN, pendingCount?: number): Block {
  const sum = (pick: (s: Session) => number) => sessions.reduce((n, s) => n + pick(s), 0);
  const held = sum((s) => s.held);
  return {
    type: "stats",
    items: [
      { label: t.bookedSeats, value: sum((s) => s.taken), description: scope },
      { label: t.waiting, value: sum((s) => s.waitlistCount), description: held ? t.placesOffered(held) : t.seatsOnWaitlists },
      ...(pendingCount !== undefined
        ? [{ label: t.requestsWaiting, value: pendingCount >= 50 ? "50+" : pendingCount, description: t.requestsPendingNote }]
        : []),
    ],
  };
}

/** One word an organiser can act on, instead of a percentage. */
function fillWord(s: Session, t: AdminText): string {
  if (s.usedPct === null) return t.unlimited;
  if (s.taken + s.held >= s.capacity) return t.sessFull;
  return s.usedPct >= 80 ? t.sessAlmost : t.sessOpen;
}

/** `dates`: start of each single event by pool key (its ledger has no occurrence date). */
export function sessionsTableBlock(sessions: Session[], t: AdminText = EN, locale: string = "en", dates?: Map<string, string>): Block {
  return {
    type: "table",
    page_action_id: "page-sessions",
    columns: [
      // What matters first: a phone shows only the first columns without scrolling sideways.
      { key: "label", label: t.colEvent },
      { key: "taken", label: t.colBooked },
      { key: "used", label: t.colStatus, format: "badge" },
      { key: "when", label: t.colDateTimeLower },
      { key: "waiting", label: t.waiting, format: "number" },
      { key: "view", label: t.colList, format: "element" },
    ],
    rows: sessions.slice(0, 30).map((s) => ({
      label: s.label,
      when: formatOccurrence(s.occurrenceStart || dates?.get(s.poolKey) || "", t, s.timezone, locale),
      taken: s.capacity > 0 ? `${s.taken + s.held} / ${s.capacity}` : String(s.taken),
      waiting: s.waitlistCount,
      used: fillWord(s, t),
      view: { type: "button" as const, action_id: "view-session", label: t.viewList, value: `${s.poolKey}\n${s.occurrenceStart}` },
    })),
    empty_text: t.noUpcoming,
  };
}

/**
 * Capacity heatmap (ECharts via the `chart` block): weekday × hour of day, coloured by the
 * average share of seats in use. Bands as in the suite spec: green < 50 %, amber 50–85 %,
 * red > 85 % or any waitlist. Times use each ledger's event time zone (falling back to UTC).
 * Returns null when there are fewer than two dated, capacity-limited sessions to compare.
 */
/**
 * "When sessions fill up" as a small table of the busiest weekday/start-hour slots. It used to be
 * an ECharts heatmap, but the admin's chart registry has no heatmap series or visual map, so the
 * chart rendered as an empty box. A table always renders, reads on a phone and needs no legend.
 */
export function heatmapBlock(sessions: Session[], t: AdminText = EN): Block | null {
  const cells = new Map<string, { sum: number; n: number }>();
  for (const s of sessions) {
    if (!s.occurrenceStart || s.usedPct === null) continue;
    const parts = zonedParts(s.occurrenceStart, s.timezone);
    if (!parts) continue;
    const key = `${parts.hour}:${parts.weekday}`;
    const value = s.waitlistCount > 0 ? Math.max(100, s.usedPct) : s.usedPct;
    const cell = cells.get(key) ?? { sum: 0, n: 0 };
    cells.set(key, { sum: cell.sum + value, n: cell.n + 1 });
  }
  const dated = [...cells.values()].reduce((n, c) => n + c.n, 0);
  if (dated < 2) return null;

  const rows = [...cells.entries()]
    .map(([key, c]) => {
      const [hour, day] = key.split(":").map(Number);
      return {
        day: t.days[day] ?? String(day),
        starts: `${String(hour).padStart(2, "0")}:00`,
        used: `${Math.min(100, Math.round(c.sum / c.n))}%`,
        sessions: c.n,
        value: Math.min(100, Math.round(c.sum / c.n)),
      };
    })
    .sort((a, b) => b.value - a.value || a.day.localeCompare(b.day) || a.starts.localeCompare(b.starts))
    .slice(0, 8)
    .map(({ value: _value, ...row }) => row);

  return {
    type: "table",
    block_id: "heatmap",
    page_action_id: "page-heatmap",
    columns: [
      { key: "day", label: t.colDay },
      { key: "starts", label: t.colStarts },
      { key: "used", label: t.colUsedPct },
      { key: "sessions", label: t.colSessions, format: "number" },
    ],
    rows,
  };
}

/** Event → date filter (plus a name search) for the lists. Options come from the upcoming sessions. */
export function filterFormBlock(
  sessions: Session[],
  filter: Filter,
  t: AdminText = EN,
  locale: string = "en",
  opts: { q?: string; searchLabel?: string; submitLabel?: string } = {}
): Block {
  const pools = new Map<string, string>();
  for (const s of sessions) if (!pools.has(s.poolKey)) pools.set(s.poolKey, s.label);
  const dates = filter.pool
    ? sessions.filter((s) => s.poolKey === filter.pool && s.occurrenceStart)
    : [];
  const fields: any[] = [];
  // One event with one date leaves nothing to choose.
  if (pools.size > 1) {
    fields.push({
      type: "select",
      action_id: "pool",
      label: t.filterEvent,
      options: [{ label: t.allEvents, value: "" }, ...[...pools].slice(0, 100).map(([value, label]) => ({ label, value }))],
      initial_value: filter.pool ?? "",
    });
  }
  if (dates.length > 1) {
    fields.push({
      type: "select",
      action_id: "occurrence",
      label: t.filterDate,
      options: [{ label: t.allDates, value: "" }, ...dates.slice(0, 100).map((s) => ({ label: formatOccurrence(s.occurrenceStart, t, s.timezone, locale), value: s.occurrenceStart }))],
      initial_value: filter.occurrence ?? "",
    });
  }
  fields.push({ type: "text_input", action_id: "q", label: opts.searchLabel ?? t.filterSearch, initial_value: opts.q ?? "" });
  return {
    type: "form",
    // The admin keys blocks by block_id and keeps a form's state: a new id shows the new choice.
    block_id: `attendee-filter:${filter.pool ?? ""}:${filter.occurrence ?? ""}`,
    fields,
    submit: { label: opts.submitLabel ?? t.showAttendees, action_id: "apply-filter" },
  };
}
