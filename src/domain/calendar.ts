import { buildIcs, eventTiming, type EventTiming } from "@vermeulen.solutions/eventual-capacity";

/** Route name: /_emdash/api/plugins/eventual-attendance/calendar?eventId=…&occurrence=… */
export const CALENDAR_ROUTE = "calendar";
export const DEFAULT_PLUGIN_ID = "eventual-attendance";
export const PLUGIN_ID = DEFAULT_PLUGIN_ID;

// eventTiming moved to the library when Tickets became its second consumer (suite D12).
export { eventTiming, type EventTiming };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Public "add to calendar" link for one occurrence (served by the calendar route). */
export function calendarLink(
  siteUrl: string,
  eventId: string,
  occurrenceStart = "",
  collection = "",
  pluginId: string = DEFAULT_PLUGIN_ID
): string {
  const base = siteUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ eventId });
  if (occurrenceStart) params.set("occurrence", occurrenceStart);
  if (collection) params.set("collection", collection);
  return `${base}/_emdash/api/plugins/${pluginId || DEFAULT_PLUGIN_ID}/${CALENDAR_ROUTE}?${params.toString()}`;
}

/** The .ics body for one occurrence of a published event. */
export function eventIcs(
  event: { id: string; data: Record<string, unknown> },
  timing: EventTiming,
  opts: { occurrenceStart?: string; publicUrl?: string | null; host?: string } = {}
): string {
  const data = event.data ?? {};
  const location = str(data.location) || str(data.virtual_url) || undefined;
  return buildIcs({
    uid: `${event.id}-${opts.occurrenceStart || "event"}@${opts.host || PLUGIN_ID}`,
    title: str(data.title) || "Event",
    start: timing.allDay ? timing.startDate! : timing.startsAt,
    end: timing.end,
    allDay: timing.allDay,
    location,
    url: opts.publicUrl ?? undefined,
  });
}

/** Human date for emails, in the event's time zone when it is valid. */
export function formatWhen(timing: Pick<EventTiming, "startsAt" | "allDay" | "timezone">, locale: string = "en"): string {
  const date = new Date(timing.startsAt);
  // `timeZoneName` cannot be combined with `timeStyle`, so spell the parts out. The zone label
  // matters in a reminder: "17:00" alone does not say whether the event is at home or abroad.
  const opts: Intl.DateTimeFormatOptions = timing.allDay
    ? { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }
    : {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: timing.timezone || "UTC",
        timeZoneName: "short",
      };
  try {
    const text = new Intl.DateTimeFormat(locale === "fr" ? "fr-CH" : locale, opts).format(date);
    return timing.allDay || timing.timezone ? text : `${text} UTC`;
  } catch {
    return `${new Intl.DateTimeFormat(locale === "fr" ? "fr-CH" : locale, { ...opts, timeZone: "UTC" }).format(date)} UTC`;
  }
}
