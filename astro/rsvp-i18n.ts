import { LOCALES, localeDirection, resolveLocale } from "@vermeulen.solutions/eventual-locales";

/**
 * Every visible string of the Attendance site components: RsvpForm (top level) and RsvpManage
 * (`manage`). English is the source; other languages ship in @vermeulen.solutions/eventual-locales
 * (catalogs/attendance-form/<lang>.json, flat dotted keys over this tree). Placeholders stay plain
 * {name}: the client scripts substitute them with String.replace.
 */
const en = {
  title: "Register for this event",
  honeypot: "Leave this field blank",
  name: "Full name",
  namePh: "Jane Doe",
  email: "Email address",
  emailPh: "jane@example.com",
  seats: "Seats",
  seat: "seat",
  seatsWord: "seats",
  // Extra plural forms for languages that have them (Intl.PluralRules "two"/"few"/"many", e.g.
  // the Arabic dual); English uses "seats".
  seatsTwo: "seats",
  seatsFew: "seats",
  seatsMany: "seats",
  submit: "Confirm RSVP",
  client: {
    submitting: "Submitting…",
    submitRequest: "Send request",
    choose: "Choose…",
    closed: "Registration is closed for this event.",
    waitlistTitle: "Added to the waitlist.",
    waitlistBody: "You are position #{n}. A confirmation email is on its way. If a spot opens up you will have 2 hours to claim it.",
    waitlistBodyNoEmail: "You are position #{n}.",
    pendingTitle: "Request received.",
    pendingBody: "The organiser will confirm or decline your request. A confirmation email is on its way.",
    pendingBodyNoEmail: "The organiser will confirm or decline your request.",
    successTitle: "RSVP confirmed!",
    successBody: "Your spot is reserved. A confirmation email with your cancellation link is on its way.",
    successBodyNoEmail: "Your spot is reserved.",
    manage: "Manage or cancel this registration",
    checkAnswers: "Please check the highlighted answers.",
    maxQuantity: "You can reserve up to {n} seats at a time.",
    full: "This session is full.",
    generic: "We could not complete your registration. Please try again.",
    network: "A network error occurred. Please try again.",
    errors: {
      MISSING_REQUIRED_FIELDS: "Please fill in your name and email address.",
      INVALID_EMAIL: "Please enter a valid email address.",
      INVALID_QUANTITY: "Please choose a valid number of seats.",
      INVALID_SUBMISSION_TIMING: "This form has been open for a long time. Please reload the page and try again.",
      EVENT_NOT_FOUND: "This event could not be found.",
      RSVP_DISABLED: "Registration is closed for this event.",
      EVENT_NOT_PUBLISHED: "Registration is not open for this event yet.",
      EVENT_TICKETED: "This event uses tickets. Please use the ticket form.",
      TRY_AGAIN: "We are very busy right now. Please try again.",
      IDEMPOTENCY_CONFLICT: "Please reload the page and try again.",
      ALREADY_CANCELLED: "This registration was cancelled. Reload the page to register again.",
      CHALLENGE_FAILED: "The security check didn’t pass. Please try again.",
      RATE_LIMITED: "Too many registrations from this connection. Please try again in a few minutes.",
    },
    challenge: "Please complete the security check above the button.",
    fieldErrors: {
      REQUIRED: "Please answer this question.",
      INVALID: "Please check this answer.",
      TOO_LONG: "This answer is too long.",
    },
  },
  manage: {
    heading: "Manage your reservation",
    loading: "Loading…",
    client: {
      dateLocale: "en-GB",
      incomplete: "This link is incomplete. Please open it directly from your email.",
      networkReload: "A network error occurred. Please reload the page.",
      notFound: "We could not find this reservation.",
      event: "Event",
      date: "Date",
      seatsLabel: "Seats",
      claimBefore: "Claim before",
      seat: "seat",
      seats: "seats",
      seatsTwo: "seats",
      seatsFew: "seats",
      seatsMany: "seats",
      claimQuestion: "A spot has opened up for you ({seats}). Confirm below to claim it.",
      alreadyCancelled: "This reservation has already been cancelled.",
      checkedIn: "You have already been checked in for this event.",
      leaveQuestion: "Do you want to leave the waitlist? Your place in line will be given up.",
      pendingQuestion: "Your request is waiting for the organiser's approval.",
      cancelQuestion: "Do you want to cancel your reservation ({seats})? Your {seatWord} will be released to someone else.",
      claimButton: "Claim my spot",
      leaveButton: "Leave the waitlist",
      withdrawButton: "Withdraw request",
      cancelButton: "Cancel my reservation",
      claimed: "Your spot is confirmed. We have emailed you the details.",
      left: "You have left the waitlist.",
      withdrawn: "Your request has been withdrawn.",
      cancelled: "Your reservation has been cancelled.",
      wentWrong: "Something went wrong. Please try again later.",
      network: "A network error occurred. Please try again.",
      errors: {
        INVALID_TOKEN: "This link is not valid. Please use the link from your most recent email.",
        ALREADY_CANCELLED: "This reservation has already been cancelled.",
        ALREADY_CANCELLED_OR_UNKNOWN: "This reservation has already been cancelled or does not exist.",
        ENTRY_NOT_FOUND: "We could not find this offer. Please use the link from your most recent email.",
        ALREADY_CLAIMED: "You have already claimed this spot. See you there!",
        OFFER_EXPIRED: "This 2-hour offer has expired, so the spot is being offered to the next person in line.",
        OFFER_NO_LONGER_AVAILABLE: "This offer is no longer available.",
        ATTENDEE_NOT_WAITLISTED: "This reservation is no longer on the waitlist.",
      },
    },
  },
} as const;

/** English component texts; their dotted paths are the keys of the attendance-form catalogs. */
export const RSVP_EN = en;
export type RsvpText = typeof en;
type Loose<T> = { [K in keyof T]: T[K] extends string ? string : Loose<T[K]> };

// Each import becomes its own chunk, loaded per language.
const catalogs: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  fr: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/fr.json", { with: { type: "json" } }),
  de: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/de.json", { with: { type: "json" } }),
  nl: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/nl.json", { with: { type: "json" } }),
  es: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/es.json", { with: { type: "json" } }),
  it: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/it.json", { with: { type: "json" } }),
  pt: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/pt.json", { with: { type: "json" } }),
  "pt-BR": () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/pt-BR.json", { with: { type: "json" } }),
  pl: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/pl.json", { with: { type: "json" } }),
  cs: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/cs.json", { with: { type: "json" } }),
  sv: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/sv.json", { with: { type: "json" } }),
  da: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/da.json", { with: { type: "json" } }),
  nb: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/nb.json", { with: { type: "json" } }),
  fi: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/fi.json", { with: { type: "json" } }),
  ja: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/ja.json", { with: { type: "json" } }),
  "zh-CN": () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/zh-CN.json", { with: { type: "json" } }),
  ko: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/ko.json", { with: { type: "json" } }),
  tr: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/tr.json", { with: { type: "json" } }),
  uk: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/uk.json", { with: { type: "json" } }),
  ar: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/ar.json", { with: { type: "json" } }),
  he: () => import("@vermeulen.solutions/eventual-locales/catalogs/attendance-form/he.json", { with: { type: "json" } }),
};

function overlay<T>(english: T, catalog: Record<string, string>, prefix = ""): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(english as Record<string, unknown>)) {
    const path = prefix + key;
    out[key] = typeof value === "string" ? catalog[path] || value : overlay(value, catalog, path + ".");
  }
  return out as T;
}

const loaded = new Map<string, Promise<Loose<RsvpText>>>();

/** The components' texts in the closest shipped language (English when none is close). */
export function rsvpText(locale?: string): Promise<Loose<RsvpText>> {
  const lang = resolveLocale(locale);
  if (lang === "en" || !catalogs[lang]) return Promise.resolve(en);
  if (!loaded.has(lang)) loaded.set(lang, catalogs[lang]!().then((module) => overlay<Loose<RsvpText>>(en, module.default), () => en));
  return loaded.get(lang)!;
}

export { LOCALES, localeDirection };

/** The word for a count in the language's plural category (one / two / few / many / other). */
export function pluralWord(locale: string, n: number, one: string, other: string, few?: string, many?: string, two?: string): string {
  let category = "other";
  try { category = new Intl.PluralRules(locale).select(n); } catch {}
  return category === "one" ? one : category === "two" && two ? two : category === "few" && few ? few : category === "many" && many ? many : other;
}
