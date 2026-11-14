/**
 * Every text Attendance sends to guests (and the organiser's new-request notice). English is the
 * source and is built in; other languages come from the eventual-locales "attendance" pack
 * (keys "email.…"). A booking stores the language of the form it was made from (`locale`), so
 * its emails stay in that language; the site default (Attendance admin page) covers bookings
 * without one.
 */
import type { Budget } from "@vermeulen.solutions/eventual-capacity";
import { bindMessages, LOCALES as SHIPPED, resolveLocale, type Bound, type Catalog } from "../locales/index.mjs";
import { languagePack, type PackHost } from "../i18n";

/** A shipped language tag: "en" or one of the pack languages ("fr", "pt-BR", …). */
export type Locale = string;
export const LOCALES: readonly Locale[] = ["en", ...SHIPPED];

/** The closest shipped language; `fallback` when the value is empty or not close to any. */
export function normalizeLocale(value: unknown, fallback: Locale = "en"): Locale {
  const text = typeof value === "string" ? value.trim().slice(0, 35) : "";
  if (!text) return fallback;
  const lang = resolveLocale(text);
  return lang === "en" && !/^en\b/i.test(text) ? fallback : lang;
}

/** Intl tag for dates in emails and admin pages: French keeps its Swiss style (fr-CH). */
export function intlLocale(locale: Locale): string {
  return locale === "fr" ? "fr-CH" : locale;
}

/** A language's own name ("Deutsch", "日本語"), for language pickers. */
export function languageName(tag: Locale): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

export interface Email {
  subject: string;
  text: string;
}

const en = {
  fallbackTitle: "the event",
  soon: "soon",
  singleEvent: "single event",
  rsvpConfirmed: {
    subject: ["RSVP confirmed: {title}"],
    text: ["Hi {name},\n\nYour spot for {title} has been reserved!\n{hasCalendar, select, true {\nAdd it to your calendar:\n{calendarUrl}\n} other {}}\nIf you cannot make it, cancel here:\n{cancelUrl}\n"],
  },
  requestReceived: {
    subject: ["Request received: {title}"],
    text: ["Hi {name},\n\nWe received your request for {title}. The organiser will confirm or decline it by {deadline}; your seat is held until then.\n\nTo withdraw your request:\n{cancelUrl}\n"],
  },
  requestDeclined: {
    subject: ["Request declined: {title}"],
    text: ["Hi {name},\n\nThe organiser declined your request for {title}. Your seat has been released.\n"],
  },
  requestLapsed: {
    subject: ["Request lapsed: {title}"],
    text: ["Hi {name},\n\nYour request for {title} wasn't answered in time, so it has lapsed and your seat was released.\n"],
  },
  organiserNewRequest: {
    subject: ["New request: {name} for {title}"],
    text: ["{name} ({email}) asked for {quantity, plural, one {# seat} other {# seats}} for {title} on {date}. Approve or decline it on the Attendance page before {deadline}.\n"],
  },
  waitlisted: {
    subject: ["Waitlist confirmation: {title}"],
    text: ["Hi {name},\n\nYou are on the waitlist for {title} (position #{position}).\n\nIf a spot becomes available you will receive an email with a 2-hour window to claim it.\n\nTo leave the waitlist:\n{cancelUrl}\n"],
  },
  offer: {
    subject: ["A spot has opened up for {title}! Claim within 2 hours"],
    text: ["Hi {name},\n\nA spot has opened up for you for {title}!\n\nPlease claim your reservation within 2 hours using this link:\n{claimUrl}\n\nIf you do not claim within 2 hours, the spot will be offered to the next person in line.\n"],
  },
  claimConfirmed: {
    subject: ["Spot confirmed: {title}"],
    text: ["Hi {name},\n\nYour spot for {title} has been claimed and confirmed!\n{hasCalendar, select, true {\nAdd it to your calendar:\n{calendarUrl}\n} other {}}\nIf you cannot make it, cancel here so someone else can have your seat:\n{cancelUrl}\n"],
  },
  movedToEnd: {
    subject: ["Waitlist update: {title}"],
    text: ["Hi {name},\n\nYou are still on the waitlist for {title}, now at the end of the line. The organiser moved you because the next free seats could not fit your booking of {quantity, plural, one {# seat} other {# seats}} and others were waiting.\n\nIf enough seats become available you will get an email with a 2-hour window to claim them. To leave the waitlist instead, use the link in your original confirmation email.\n"],
  },
  reminder: {
    subject: ["Reminder: {title}, {when}"],
    text: ["Hi {name},\n\nA reminder that {title} is coming up: {when}{quantity, plural, =1 {} other { (# seats)}}.\n\nAdd it to your calendar:\n{calendarUrl}\n\nIf you can no longer come, please cancel so someone else can have your seat:\n{cancelUrl}\n"],
  },
} as const;

/** English guest-message tree; its dotted paths are the "email." keys of the attendance pack. */
export const EMAIL_EN = en;

interface Base {
  name: string;
  title: string;
}
type Template = { subject(params: object): string; text(params: object): string };

/** The emails of one language, each a function from its data to subject and text. */
export interface MessageSet {
  fallbackTitle: string;
  soon: string;
  singleEvent: string;
  rsvpConfirmed(p: Base & { calendarUrl?: string; cancelUrl: string }): Email;
  requestReceived(p: Base & { deadline: string; cancelUrl: string }): Email;
  requestDeclined(p: Base): Email;
  requestLapsed(p: Base): Email;
  organiserNewRequest(p: Base & { email: string; quantity: number; date: string; deadline: string }): Email;
  waitlisted(p: Base & { position: number; cancelUrl: string }): Email;
  offer(p: Base & { claimUrl: string }): Email;
  claimConfirmed(p: Base & { calendarUrl?: string; cancelUrl: string }): Email;
  movedToEnd(p: Base & { quantity: number }): Email;
  reminder(p: Base & { when: string; quantity: number; calendarUrl: string; cancelUrl: string }): Email;
}

function messageSetOf(text: Bound<typeof en>): MessageSet {
  const out: Record<string, unknown> = { fallbackTitle: text.fallbackTitle, soon: text.soon, singleEvent: text.singleEvent };
  for (const [key, value] of Object.entries(text)) {
    if (typeof value !== "object") continue;
    const template = value as Template;
    out[key] = (p: Record<string, unknown>): Email => {
      const params = { hasCalendar: !!p.calendarUrl, ...p };
      return { subject: template.subject(params), text: template.text(params) };
    };
  }
  return out as unknown as MessageSet;
}

const sets = new WeakMap<object, MessageSet>();
let english: MessageSet | undefined;

/** The emails for a pack catalog (null = English). */
export function messageSet(catalog: Catalog | null | undefined, locale: Locale): MessageSet {
  if (!catalog) return (english ??= messageSetOf(bindMessages(en, null, "en")));
  let set = sets.get(catalog);
  if (!set) {
    const email: Catalog = {};
    for (const key in catalog) if (key.startsWith("email.")) email[key.slice(6)] = catalog[key]!;
    sets.set(catalog, (set = messageSetOf(bindMessages(en, email, locale))));
  }
  return set;
}

/**
 * The emails in `locale`. The pack is read (≤ 1 call, none once cached) only when a call is left
 * besides `reserve` (the send); otherwise, or before the cron has stored the pack, English.
 */
export async function guestMessages(host: PackHost, budget: Budget, locale: Locale, reserve = 1): Promise<MessageSet> {
  return messageSet(await languagePack(host, budget, locale, reserve), locale);
}

/** English, for code paths without a pack (tests, fallbacks). */
export const MESSAGES_EN: MessageSet = messageSet(null, "en");
