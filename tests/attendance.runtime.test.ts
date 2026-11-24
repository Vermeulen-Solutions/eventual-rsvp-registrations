/**
 * Integration tests against EmDash's real plugin runtime (createPluginRuntimeTestHost):
 * real KV revisions, real storage updateIf, the real route envelope, Block Kit validation,
 * and the production sandbox bridge. No hand-written mocks of host APIs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { AttendeeRecord, WaitlistEntry } from "../src/domain/types";
import type { CapacityLedger } from "@vermeulen.solutions/eventual-capacity";
import { guardBudget } from "./budget-guard";
import pack from "../src/locales/manifest";
import frenchPack from "@vermeulen.solutions/eventual-locales/catalogs/attendance/fr.json";

const SITE = "https://example.test";
let host: PluginRuntimeTestHost;
let seq = 0;

// Fields of Core's event blueprint used here, plus the capacity field pack (suite D2).
const EVENT_FIELDS = [
  { slug: "title", label: "Title", type: "string" },
  { slug: "capacity", label: "Capacity", type: "integer" },
  { slug: "allow_waitlist", label: "Allow waitlist", type: "boolean" },
  { slug: "inventory_mode", label: "Inventory mode", type: "string" },
  { slug: "start", label: "Start", type: "datetime" },
  { slug: "end", label: "End", type: "datetime" },
  { slug: "timezone", label: "Time zone", type: "string" },
  { slug: "location", label: "Location", type: "string" },
];

beforeAll(async () => {
  host = await createPluginRuntimeTestHost({
    site: { url: SITE },
    i18n: { defaultLocale: "en", locales: ["en", "fr"] },
  });
  guardBudget(host); // every invocation must stay within 10 bridge calls (suite P1)
  // As the language-packs cron leaves it: the verified French pack stored in plugin KV.
  await host.fixtures.plugin.kv(`i18n:attendance:${pack.version}:fr`, frenchPack);
  await host.fixtures.collection({ slug: "events", label: "Events", fields: EVENT_FIELDS } as any);
});

afterAll(async () => {
  await host?.dispose();
});

/** A published, RSVP-mode event unless the overrides say otherwise. */
async function makeEvent(
  data: Record<string, unknown>,
  opts: { status?: string; collection?: string; translationOf?: string; locale?: string } = {}
): Promise<string> {
  const item = await host.fixtures.content(opts.collection ?? "events", {
    data: { title: `Event ${++seq}`, inventory_mode: "rsvp", ...data },
    status: opts.status ?? "published",
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.translationOf ? { translationOf: opts.translationOf } : {}),
  } as any);
  return item.id;
}

async function call(route: string, body: unknown): Promise<any> {
  const res = await host.actions.routes.request(route, { method: "POST", body } as any);
  const json = (await res.json()) as any;
  return json.success ? json.data : { ok: false, error: json.error?.code, message: json.error?.message, httpStatus: res.status };
}

let personSeq = 0;
async function rsvp(eventId: string, extra: Record<string, unknown> = {}) {
  const email = `p${++personSeq}@example.test`;
  const result = await call("rsvp", { eventId, email, displayName: `Person ${personSeq}`, quantity: 1, ...extra });
  return { email, result };
}

async function ledger(eventId: string): Promise<CapacityLedger> {
  return (await host.inspect.kv.get<CapacityLedger>(`ledger:${eventId}`))!;
}

/** Latest self-service token of the given kind emailed to `email`. */
async function tokenFor(email: string, action: "cancel" | "claim"): Promise<string> {
  const mails = (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(email));
  for (const mail of mails.reverse()) {
    const match = JSON.stringify(mail).match(new RegExp(`#action=${action}&token=([0-9a-f]{64})`));
    if (match) return match[1];
  }
  throw new Error(`No ${action} token emailed to ${email}`);
}

async function entryFor(attendeeId: string): Promise<WaitlistEntry> {
  const all = await host.inspect.storage.list<WaitlistEntry>("waitlist_entries");
  return all.find((e) => e.data.attendeeId === attendeeId)!.data;
}

const tick = () => host.transport.invokeHook("cron", { name: "waitlist-maintenance" });

async function tickUntil(done: () => Promise<boolean>, maxTicks = 12): Promise<void> {
  for (let n = 0; n < maxTicks && !(await done()); n++) await tick();
}

async function attendee(id: string): Promise<AttendeeRecord> {
  return (await host.inspect.storage.get<AttendeeRecord>("attendees", id))!;
}

describe("capacity ledger (real KV revisions)", () => {
  it("accepts every RSVP up to capacity, then waitlists in FIFO order", async () => {
    const eventId = await makeEvent({ capacity: 2, allow_waitlist: true });
    const a = await rsvp(eventId);
    const b = await rsvp(eventId);
    const c = await rsvp(eventId);
    const d = await rsvp(eventId, { quantity: 2 });

    expect(a.result).toMatchObject({ ok: true, status: "going" });
    expect(b.result).toMatchObject({ ok: true, status: "going", remaining: 0 });
    expect(c.result).toMatchObject({ ok: true, status: "waitlist", waitlistPosition: 1 });
    expect(d.result).toMatchObject({ ok: true, status: "waitlist", waitlistPosition: 2 });
    expect(await ledger(eventId)).toMatchObject({ capacity: 2, taken: 2, held: 0, waitlistCount: 3, nextPosition: 3 });
  });

  it("never oversells under concurrent registrations", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => rsvp(eventId)));
    const going = results.filter((r) => r.result.ok && r.result.status === "going").length;

    expect(going).toBeGreaterThanOrEqual(1);
    expect(going).toBeLessThanOrEqual(3);
    expect((await ledger(eventId)).taken).toBe(going);
  });

  it("rejects malformed quantities without touching the ledger", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    for (const quantity of ["abc", 1.5, 0, -1, 21]) {
      expect((await rsvp(eventId, { quantity })).result).toMatchObject({ ok: false, error: "INVALID_QUANTITY" });
    }
    expect(await host.inspect.kv.get(`ledger:${eventId}`)).toBeNull();
  });

  it("creates its signing key in plugin KV and needs no EMDASH_ENCRYPTION_KEY", async () => {
    // vitest.config.ts sets no encryption key: Attendance must work without one.
    expect(process.env.EMDASH_ENCRYPTION_KEY).toBeUndefined();
    const config = await host.inspect.kv.get<Record<string, unknown>>("config:v1");
    expect(config ?? {}).not.toHaveProperty("hmacSecret");
    const eventId = await makeEvent({ capacity: 2 });
    const r = await rsvp(eventId);
    expect(await call("cancel", { token: await tokenFor(r.email, "cancel") })).toMatchObject({ ok: true });
    expect(await host.inspect.kv.get("state:signing-key")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotent RSVPs", () => {
  const commandId = () => `cmd_${crypto.randomUUID().replace(/-/g, "")}`;

  it("replays the original outcome for a retried request instead of booking twice", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const req = { eventId, email: "retry@example.test", displayName: "Retry", quantity: 2, commandId: commandId() };

    const first = await call("rsvp", req);
    const again = await call("rsvp", req);
    expect(first).toMatchObject({ ok: true, status: "going" });
    expect(again).toMatchObject({ ok: true, status: "going", attendeeId: first.attendeeId, replayed: true });
    expect((await ledger(eventId)).taken).toBe(2);
  });

  it("refuses a reused id with different contents", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const id = commandId();
    await call("rsvp", { eventId, email: "a@example.test", displayName: "A", quantity: 1, commandId: id });
    expect(await call("rsvp", { eventId, email: "b@example.test", displayName: "B", quantity: 1, commandId: id }))
      .toMatchObject({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
    expect((await ledger(eventId)).taken).toBe(1);
  });

  it("books once when identical requests race", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const req = { eventId, email: "race@example.test", displayName: "Race", quantity: 1, commandId: commandId() };
    await host.restart();
    const results = await Promise.all([
      call("rsvp", req),
      call("rsvp", req),
      call("rsvp", req),
      call("rsvp", req),
      call("rsvp", req),
    ]);

    const ids = new Set(results.filter((r) => r.ok).map((r) => r.attendeeId));
    expect(ids.size).toBe(1);
    const rows = (await host.inspect.storage.list<AttendeeRecord>("attendees")).filter((r) => r.data.commandId === req.commandId);
    expect(rows).toHaveLength(1);
    expect((await ledger(eventId)).taken).toBe(1);
  });
});

describe("cancellation", () => {
  it("is POST-only so link scanners cannot cancel reservations", async () => {
    const res = await host.actions.routes.request("cancel", { method: "GET" } as any);
    expect(res.status).toBe(405);
  });

  it("releases seats exactly once under concurrent cancels", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const f = await rsvp(eventId, { quantity: 2 });
    await rsvp(eventId);
    const token = await tokenFor(f.email, "cancel");

    const [x, y] = await Promise.all([call("cancel", { token }), call("cancel", { token })]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect((await ledger(eventId)).taken).toBe(1);
    expect((await attendee(f.result.attendeeId)).status).toBe("cancelled");
  });

  it("rejects malformed tokens before touching storage", async () => {
    expect(await call("cancel", { token: "../../etc" })).toMatchObject({ ok: false, error: "INVALID_TOKEN" });
  });

  it("returns the email's own cancel link to the browser that booked, and it cancels", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    const r = await rsvp(eventId);
    const token = new RegExp("#action=cancel&token=([0-9a-f]{64})").exec(r.result.manageUrl)?.[1];
    expect(r.result.manageUrl).toContain(`/rsvp/manage#action=cancel&token=${token}`);
    expect(await call("cancel", { token })).toMatchObject({ ok: true });
    expect((await attendee(r.result.attendeeId)).status).toBe("cancelled");
  });

  it("leaves the manage link out of a replay", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    const commandId = `cmd_${crypto.randomUUID().replace(/-/g, "")}`;
    const email = `replay-${++personSeq}@example.test`;
    const body = { eventId, email, displayName: "Replay Person", quantity: 1, commandId };
    const first = await call("rsvp", body);
    expect(first.ok).toBe(true);
    expect(first.manageUrl).toContain("#action=cancel&token=");
    const again = await call("rsvp", body);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.manageUrl).toBeUndefined();
  });
});

describe("languages", () => {
  it("sends emails in the language of the form, and in the site default otherwise", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const fr = await rsvp(eventId, { locale: "fr" });
    const en = await rsvp(eventId); // no locale: the site default (English unless changed)
    const subjects = async (email: string) => (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(email)).map((m) => (m as any).subject);
    expect(await subjects(fr.email)).toEqual([expect.stringMatching(/^Inscription confirmée : /)]);
    expect(await call("manage/lookup", { action: "cancel", token: await tokenFor(fr.email, "cancel") })).toMatchObject({ ok: true, locale: "fr" });
    expect(await subjects(en.email)).toEqual([expect.stringMatching(/^Waitlist confirmation: /)]);
    // The waitlist offer follows the booking's own language, not the canceller's.
    await call("cancel", { token: await tokenFor(fr.email, "cancel") });
    expect((await subjects(en.email)).some((s: string) => /^A spot has opened up/.test(s))).toBe(true);

    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", defaultLocale: "fr" });
    const later = await rsvp(await makeEvent({ capacity: 5 }));
    expect(await subjects(later.email)).toEqual([expect.stringMatching(/^Inscription confirmée : /)]);
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", defaultLocale: "en" });
  });
});

describe("several event collections", () => {
  it("takes bookings for every configured collection and refuses others", async () => {
    await host.fixtures.collection({ slug: "school_series", label: "School series", fields: [
      { slug: "title", label: "Title", type: "string" }, { slug: "inventory_mode", label: "Mode", type: "string" },
      { slug: "capacity", label: "Capacity", type: "integer" }, { slug: "start_date", label: "Start", type: "datetime" },
    ] } as any).catch(() => undefined);
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events, school_series", managePagePath: "/rsvp/manage" });
    expect(await host.inspect.kv.get("config:v1")).toMatchObject({ eventCollection: "events, school_series" });

    const series = await makeEvent({ capacity: 1, start_date: "2027-09-29T06:00:00.000Z" }, { collection: "school_series" });
    const booked = await rsvp(series, { collection: "school_series" });
    expect(booked.result).toMatchObject({ ok: true, status: "going" });
    expect((await rsvp(series, { collection: "school_series" })).result).toMatchObject({ ok: false });
    expect((await rsvp(series, { collection: "posts" })).result).toMatchObject({ ok: false, error: "EVENT_NOT_FOUND" });
    expect((await rsvp(series)).result).toMatchObject({ ok: false, error: "EVENT_NOT_FOUND" }); // not in the default collection

    const mail = JSON.stringify((await host.inspect.email()).find((m) => JSON.stringify(m).includes(booked.email)));
    expect(mail).toContain("collection=school_series");
    const form = await (await host.actions.routes.request("rsvp/form", { method: "GET", url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=${series}&collection=school_series` } as any)).json() as any;
    expect(form.data).toMatchObject({ ok: true, open: true, seatsLeft: 0, full: true }); // the one place is booked

    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage" });
  });
});

describe("turnstile (opt-in)", () => {
  const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const SITE_KEY = "1x00000000000000000000AA";
  const SECRET = "1x0000000000000000000000000000000AA";
  const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
  const answer = (body: unknown) => host.http.respond(VERIFY, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  const formFor = async (eventId: string) => {
    const res = await host.actions.routes.request("rsvp/form", { method: "GET", url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=${eventId}` } as any);
    return ((await res.json()) as any).data;
  };
  const turnOn = () => host.admin.submit("/attendance", "save-config", {
    eventCollection: "events", managePagePath: "/rsvp/manage", turnstileSiteKey: SITE_KEY, turnstileSecretKey: SECRET,
  });
  const turnOff = () => host.admin.submit("/attendance", "save-config", {
    eventCollection: "events", managePagePath: "/rsvp/manage", turnstileSiteKey: "", turnstileSecretKey: "",
  });

  it("is off by default: no site key on the form and no call to Cloudflare", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    host.http.clear();
    expect((await formFor(eventId)).turnstileSiteKey).toBeUndefined();
    expect((await rsvp(eventId)).result).toMatchObject({ ok: true, status: "going" });
    expect(host.http.requests()).toHaveLength(0);
  });

  it("publishes only the site key, refuses missing or rejected tokens, and books with a confirmed one", async () => {
    await turnOn();
    try {
      const eventId = await makeEvent({ capacity: 5 });
      const form = await formFor(eventId);
      expect(form.turnstileSiteKey).toBe(SITE_KEY);
      expect(JSON.stringify(form)).not.toContain(SECRET);
      const page = JSON.stringify(await host.admin.loadPage("/attendance"));
      expect(page).not.toContain(SECRET); // the secret is never shown again

      host.http.clear();
      expect((await rsvp(eventId, { firstAttempt: true })).result).toMatchObject({ ok: false, error: "CHALLENGE_FAILED" });
      expect(host.http.requests()).toHaveLength(0); // no token: refused without asking Cloudflare

      await answer({ success: false, "error-codes": ["invalid-input-response"] });
      expect((await rsvp(eventId, { turnstileToken: "forged", firstAttempt: true })).result).toMatchObject({ ok: false, error: "CHALLENGE_FAILED" });
      expect((await ledger(eventId))?.taken ?? 0).toBe(0); // nothing reserved

      await answer({ success: true, hostname: "example.com" });
      const commandId = "c".repeat(32);
      const ok = await rsvp(eventId, { turnstileToken: TOKEN, commandId, firstAttempt: true });
      expect(ok.result).toMatchObject({ ok: true, status: "going" });
      const sent = new URLSearchParams(new TextDecoder().decode(host.http.requests().at(-1)!.body));
      expect(sent.get("secret")).toBe(SECRET);
      expect(sent.get("response")).toBe(TOKEN);

      // A retry of the landed booking replays it without spending another check.
      const before = host.http.requests().length;
      const retry = await call("rsvp", { eventId, email: ok.email, displayName: "Retry", quantity: 1, commandId, turnstileToken: TOKEN });
      expect(retry).toMatchObject({ ok: true, replayed: true, attendeeId: ok.result.attendeeId });
      expect(host.http.requests()).toHaveLength(before);
    } finally {
      await turnOff();
    }
  });

  it("keeps the saved secret when the field is left empty, and clearing the site key turns it off", async () => {
    await turnOn();
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", turnstileSiteKey: SITE_KEY, turnstileSecretKey: "" });
    const eventId = await makeEvent({ capacity: 5 });
    expect((await formFor(eventId)).turnstileSiteKey).toBe(SITE_KEY);
    await turnOff();
    expect((await formFor(eventId)).turnstileSiteKey).toBeUndefined();
    expect((await rsvp(eventId)).result).toMatchObject({ ok: true });
  });

  it("lets bookings through when Cloudflare can't be asked", async () => {
    await turnOn();
    try {
      const eventId = await makeEvent({ capacity: 5 });
      await host.http.respond(VERIFY, new Response("unavailable", { status: 503 }));
      expect((await rsvp(eventId, { turnstileToken: TOKEN, firstAttempt: true })).result).toMatchObject({ ok: true, status: "going" });
    } finally {
      await turnOff();
    }
  });
});

describe("public routes on failure", () => {
  it("never shows visitors a raw database error", async () => {
    // A collection without a table: the database throws, as on the preview before its schema.
    await host.admin.submit("/attendance", "save-config", { eventCollection: "ghosts", managePagePath: "/rsvp/manage" });
    const formRes = await host.actions.routes.request("rsvp/form", { method: "GET", url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=x` } as any);
    const formJson = await formRes.json() as any;
    const booked = await call("rsvp", { eventId: "x", email: "ghost@example.test", displayName: "Ghost", quantity: 1 });
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage" });

    for (const answer of [formJson.data ?? formJson, booked]) {
      expect(JSON.stringify(answer)).not.toMatch(/no such table|SQLITE|D1_ERROR|ec_ghosts/i);
      expect(answer).toMatchObject({ ok: false, error: "TRY_AGAIN" }); // caught, not "not found"
    }
  });
});

describe("manage page lookup", () => {
  it("shows what a cancel or claim link refers to, without changing anything", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const a = await rsvp(eventId);
    const b = await rsvp(eventId);
    const lookup = (action: string, token: string) => call("manage/lookup", { action, token });

    const cancelA = await tokenFor(a.email, "cancel");
    const before = await ledger(eventId);
    expect(await lookup("cancel", cancelA)).toMatchObject({ ok: true, kind: "cancel", state: "going", quantity: 1 });
    expect(await lookup("cancel", await tokenFor(b.email, "cancel"))).toMatchObject({ ok: true, state: "waitlist" });
    expect(await ledger(eventId)).toEqual(before); // read-only
    expect(JSON.stringify(await lookup("cancel", cancelA))).not.toContain(a.email); // no email address

    await call("cancel", { token: cancelA });
    expect(await lookup("cancel", cancelA)).toMatchObject({ ok: true, state: "cancelled" });
    expect(await lookup("claim", await tokenFor(b.email, "claim"))).toMatchObject({ ok: true, kind: "claim", state: "offered", quantity: 1 });
    expect(await lookup("cancel", "0".repeat(64))).toMatchObject({ ok: false, error: "ALREADY_CANCELLED_OR_UNKNOWN" });
    expect(await lookup("delete", cancelA)).toMatchObject({ ok: false, error: "INVALID_ACTION" });
  });
});

describe("waitlist fairness, holds and claims", () => {
  it("holds freed seats for the queue head, blocks queue-jumping, and claims atomically", async () => {
    const eventId = await makeEvent({ capacity: 2, allow_waitlist: true });
    const a = await rsvp(eventId);
    await rsvp(eventId);
    const c = await rsvp(eventId);
    const d = await rsvp(eventId, { quantity: 2 });

    // A cancels: the seat is held for C (head), not released to the public.
    expect(await call("cancel", { token: await tokenFor(a.email, "cancel") })).toMatchObject({ ok: true });
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 1, waitlistCount: 2 });
    expect((await entryFor(c.result.attendeeId)).status).toBe("offered");

    // A newcomer cannot take the held seat and joins the back of the queue.
    const e = await rsvp(eventId);
    expect(e.result).toMatchObject({ ok: true, status: "waitlist", waitlistPosition: 3 });

    // C claims: held → taken, attendee becomes going, and the token is single-use.
    const claimToken = await tokenFor(c.email, "claim");
    expect(await call("waitlist/claim", { token: claimToken })).toMatchObject({ ok: true, status: "going" });
    expect(await ledger(eventId)).toMatchObject({ taken: 2, held: 0, waitlistCount: 3 });
    expect((await attendee(c.result.attendeeId)).status).toBe("going");
    expect(await call("waitlist/claim", { token: claimToken })).toMatchObject({ ok: false, error: "ALREADY_CLAIMED" });

    // The confirmation email carries C's real cancellation token (not the claim token).
    expect(await call("cancel", { token: await tokenFor(c.email, "cancel") })).toMatchObject({ ok: true });

    // D needs 2 seats but only 1 is free: strict FIFO keeps D at the head; E does not jump ahead.
    expect((await entryFor(d.result.attendeeId)).status).toBe("queued");
    expect((await entryFor(e.result.attendeeId)).status).toBe("queued");
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 0, waitlistCount: 3 });
  });

  it("expires lapsed offers on the cron tick and offers the seat to the next in line", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const h = await rsvp(eventId);
    const i = await rsvp(eventId);
    const j = await rsvp(eventId);

    await call("cancel", { token: await tokenFor(h.email, "cancel") });
    const offered = await entryFor(i.result.attendeeId);
    expect(offered.status).toBe("offered");
    const iClaim = await tokenFor(i.email, "claim");

    // Age the offer past its 2-hour window, then run the scheduled task.
    await host.fixtures.plugin.storage("waitlist_entries", offered.id, {
      ...offered,
      offerExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await tick();
    expect((await entryFor(i.result.attendeeId)).status).toBe("expired");
    // Expiry and the follow-up offer may land on different ticks (each tick has a 10-RPC budget).
    await tickUntil(async () => (await entryFor(j.result.attendeeId)).status === "offered");

    expect((await attendee(i.result.attendeeId)).status).toBe("cancelled");
    expect((await entryFor(j.result.attendeeId)).status).toBe("offered");
    expect(await ledger(eventId)).toMatchObject({ taken: 0, held: 1, waitlistCount: 0 });
    expect(await call("waitlist/claim", { token: iClaim })).toMatchObject({ ok: false, error: "OFFER_EXPIRED" });
  });

  it("promotes on the cron tick when inline promotion was skipped", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    await rsvp(eventId);
    const k = await rsvp(eventId);
    // Simulate a freed seat whose inline promotion never ran (e.g. budget exhausted).
    const current = await ledger(eventId);
    await host.fixtures.plugin.kv(`ledger:${eventId}`, { ...current, taken: 0 });

    // Other pools with blocked queue heads exist in this host; round-robin must still reach this one.
    await tickUntil(async () => (await entryFor(k.result.attendeeId)).status === "offered");
    expect((await entryFor(k.result.attendeeId)).status).toBe("offered");
  });
});

describe("admin", () => {
  it("renders a valid attendance page and checks in confirmed attendees only", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const going = await rsvp(eventId);
    const waiting = await rsvp(eventId);

    const page = await host.admin.loadPage("/attendance");
    expect(JSON.stringify(await host.admin.loadPage("/attendance/settings"))).toContain("/_emdash/api/plugins/eventual-attendance/rsvp");
    const tables = page.blocks.filter((b: any) => b.type === "table").map((t: any) => t.page_action_id);
    expect(tables).toEqual(["page-sessions", "page-attendees"]);

    const ok = await host.admin.act("/attendance", "checkin-attendee", { value: going.result.attendeeId });
    expect(ok.toast?.type).toBe("success");
    expect((await attendee(going.result.attendeeId)).status).toBe("attended");

    const refused = await host.admin.act("/attendance", "checkin-attendee", { value: waiting.result.attendeeId });
    expect(refused.toast?.type).toBe("error");
    expect((await attendee(waiting.result.attendeeId)).status).toBe("waitlist");
  });

  it("speaks the admin UI's language: French pages, panel and roster file, English otherwise", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await rsvp(eventId);

    const fr = JSON.stringify(await host.admin.loadPage("/attendance", { locale: "fr" }));
    expect(fr).toContain("Liste d’accueil");
    expect(fr).toContain("Inscrits");
    expect(fr).toContain("Confirmé");
    expect(fr).not.toContain("Registered");

    const panel = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId, { locale: "fr" }));
    expect(panel).toContain("Inscriptions ouvertes");
    expect(panel).not.toContain("Attendance & Capacity");

    const en = JSON.stringify(await host.admin.loadPage("/attendance", { locale: "de" }));
    expect(en).toContain("Registered");

    const res = await host.admin.act("/attendance/roster", "prepare-export-csv", { locale: "fr" });
    expect(JSON.stringify(res.blocks)).toContain("Télécharger la liste (CSV)");
    const url = JSON.stringify(res.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)?.[0];
    const csv = await host.actions.routes.request("roster/download", { method: "GET", url } as any);
    expect((await csv.text()).split("\r\n")[0]).toContain("Pointé,Nom,E-mail");

    const bad = await host.admin.submitEditorPanel(
      "event-attendance",
      "events",
      eventId,
      "save-attendance-settings",
      { questions: "Taille | couleur" },
      { locale: "fr" }
    );
    expect(bad.toast?.type).toBe("error");
    expect(JSON.stringify(bad.blocks)).toContain("n’est pas un type");
    expect(JSON.stringify(bad.blocks)).toContain("Ligne 1 :");
  });

  it("issues single-use roster downloads with formula-safe CSV and no on-site HTML", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await rsvp(eventId, { displayName: "=HYPERLINK(\"http://evil\")" });
    await rsvp(eventId, { displayName: "＝1+1" });

    const linkFor = async (format: "csv" | "html") => {
      const res = await host.admin.act("/attendance/roster", `prepare-export-${format}`);
      const url = JSON.stringify(res.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)?.[0];
      expect(url).toBeTruthy();
      return url!;
    };
    const get = (url: string) => host.actions.routes.request("roster/download", { method: "GET", url } as any);

    const csvUrl = await linkFor("csv");
    const csv = await get(csvUrl);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const csvBody = await csv.text();
    expect(csvBody).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvBody).toContain(`"'＝1+1"`);
    expect((await get(csvUrl)).status).toBe(404); // single use

    const html = await get(await linkFor("html"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).not.toContain("text/html");
    expect(html.headers.get("content-disposition")).toContain("attachment");
  });

  it("a filtered roster contains only that event, with its name", async () => {
    const eventA = await makeEvent({ capacity: 5 });
    const eventB = await makeEvent({ capacity: 5 });
    await rsvp(eventA, { displayName: "Only In A" });
    await rsvp(eventB, { displayName: "Only In B" });
    const titleA = (await host.inspect.content.get("events", eventA))!.data.title as string;
    expect(titleA).toBeTruthy();

    await host.admin.submit("/attendance/roster", "apply-filter", { pool: eventA, occurrence: "" });
    const res = await host.admin.act("/attendance/roster", "prepare-export-csv");
    const url = JSON.stringify(res.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)?.[0];
    expect(url).toBeTruthy();
    const csv = await host.actions.routes.request("roster/download", { method: "GET", url: url! } as any);
    expect(csv.status).toBe(200);
    const body = await csv.text();
    expect(body).toContain("Only In A");
    expect(body).not.toContain("Only In B");

    const htmlRes = await host.admin.act("/attendance/roster", "prepare-export-html");
    const htmlUrl = JSON.stringify(htmlRes.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)?.[0];
    expect(htmlUrl).toBeTruthy();
    const html = await (await host.actions.routes.request("roster/download", { method: "GET", url: htmlUrl! } as any)).text();
    expect(html).toContain(titleA);
    expect(html).not.toContain("All Events");
  });

  it("roster/export refuses anonymous requests", async () => {
    const res = await host.actions.routes.request("roster/export", { method: "POST", body: {} } as any);
    expect(res.status).toBe(401);
  });

  it("roster/export returns the CSV for an event", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await rsvp(eventId, { displayName: "Export Test Person" });

    // An authenticated HTTP request with tokenScopes is not supported by the test host (returns 401);
    // host.transport.invokeRoute bypasses auth on the test host to test the handler logic.
    const invoked = (await host.transport.invokeRoute("roster/export", {
      request: {
        url: `https://example.test/_emdash/api/plugins/eventual-attendance/roster/export?eventId=${eventId}&format=csv`,
        method: "GET",
        headers: {},
      },
    } as any)) as any;

    expect(invoked.status).toBe(200);
    const csv = invoked.body.value;
    expect(csv).toContain("Check-in Status,Display Name,Email");
    expect(csv).toContain("Export Test Person");
  });

  it("the roster buttons have distinct action ids and the old id still works", async () => {
    await host.admin.loadPage("/attendance/roster"); // warm the isolate
    const page = await host.admin.loadPage("/attendance/roster");
    const ids = page.blocks
      .filter((b: any) => b.type === "actions")
      .flatMap((b: any) => b.elements.map((e: any) => e.action_id))
      .filter((id: unknown) => typeof id === "string" && id.startsWith("prepare-export"));
    expect(ids).toEqual(["prepare-export-html", "prepare-export-csv"]);

    // An admin page opened before the update still posts the old id with a value.
    const old = await host.admin.act("/attendance/roster", "prepare-export", { value: "html" });
    expect(JSON.stringify(old.blocks)).toContain("Download the printable list");
  });
  it("saves editor-panel settings that the RSVP route honours", async () => {
    const eventId = await makeEvent({ capacity: 10 });
    const res = await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", {
      enabled: false,
      capacity: 10,
      maxPerRegistration: 2,
      allowWaitlist: false,
    });
    expect(res.toast?.type).toBe("success");
    expect((await rsvp(eventId)).result).toMatchObject({ ok: false, error: "RSVP_DISABLED" });
  });

  it("admin cancel releases the seat and offers it to the head of the waitlist", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const a = await rsvp(eventId);
    const b = await rsvp(eventId);

    // Warm the isolate first so the config is cached (any admin page load, e.g. await host.admin.loadPage("/attendance")): the inline promotion only fits on a warm isolate (see OFFER_CALLS_AFTER_CONFIG in src/domain/waitlist.ts).
    await host.admin.loadPage("/attendance");

    const res = await host.admin.act("/attendance", "cancel-attendee", { value: a.result.attendeeId });
    expect(res.toast?.type).toBe("success");

    expect((await attendee(a.result.attendeeId)).status).toBe("cancelled");
    expect((await entryFor(b.result.attendeeId)).status).toBe("offered");
    expect(await ledger(eventId)).toMatchObject({ taken: 0, held: 1 });
    const token = await tokenFor(b.email, "claim");
    expect(token).toBeTruthy();
  });

  it("admin cancel on a cold isolate leaves the offer to cron", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    const a = await rsvp(eventId);
    const b = await rsvp(eventId);

    await host.restart();

    const res = await host.admin.act("/attendance", "cancel-attendee", { value: a.result.attendeeId });
    expect(res.toast?.type).toBe("success");

    expect((await attendee(a.result.attendeeId)).status).toBe("cancelled");
    expect((await entryFor(b.result.attendeeId)).status).toBe("queued");

    await host.transport.invokeHook("cron", { name: "waitlist-maintenance" });
    expect((await entryFor(b.result.attendeeId)).status).toBe("offered");
    const token = await tokenFor(b.email, "claim");
    expect(token).toBeTruthy();
  });
});

describe("hardening", () => {
  it("keeps RSVPs closed unless enabled, and refuses unpublished or ticketed events", async () => {
    const noMode = await makeEvent({ capacity: 5, inventory_mode: null });
    expect((await rsvp(noMode)).result).toMatchObject({ ok: false, error: "RSVP_DISABLED" });

    const draft = await makeEvent({ capacity: 5 }, { status: "draft" });
    expect((await rsvp(draft)).result).toMatchObject({ ok: false, error: "EVENT_NOT_PUBLISHED" });

    const ticketed = await makeEvent({ capacity: 5, inventory_mode: "tickets" });
    expect((await rsvp(ticketed)).result).toMatchObject({ ok: false, error: "EVENT_TICKETED" });

    // Explicitly enabling in the panel opens an event that has no inventory_mode value.
    await host.admin.submitEditorPanel("event-attendance", "events", noMode, "save-attendance-settings", {
      enabled: true, capacity: 5, maxPerRegistration: 4, allowWaitlist: false,
    });
    expect((await rsvp(noMode)).result).toMatchObject({ ok: true, status: "going" });
  });

  it("shares settings and seats across translations of an event", async () => {
    const en = await makeEvent({ capacity: 1 }, { locale: "en" });
    const fr = await makeEvent({ capacity: 50 }, { locale: "fr", translationOf: en });
    const enItem = await host.inspect.content.get("events", en);
    const pool = enItem!.translationGroup || en;

    // Settings saved on the French version apply to the English one too.
    await host.admin.submitEditorPanel("event-attendance", "events", fr, "save-attendance-settings", {
      enabled: true, capacity: 2, maxPerRegistration: 4, allowWaitlist: false,
    });
    expect(await host.inspect.storage.get("attendance_settings", pool)).toMatchObject({ capacity: 2 });

    expect((await rsvp(en)).result).toMatchObject({ ok: true, status: "going" });
    expect((await rsvp(fr)).result).toMatchObject({ ok: true, status: "going", remaining: 0 });
    expect((await rsvp(en)).result).toMatchObject({ ok: false, status: "full" });
    expect(await host.inspect.kv.get(`ledger:${pool}`)).toMatchObject({ capacity: 2, taken: 2 });
  });

  it("reads events from the configured collection", async () => {
    await host.fixtures.collection({ slug: "activities", label: "Activities", fields: EVENT_FIELDS } as any);
    const activity = await makeEvent({ capacity: 3 }, { collection: "activities" });
    expect((await rsvp(activity)).result).toMatchObject({ ok: false, error: "EVENT_NOT_FOUND" });

    const saved = await host.admin.submit("/attendance", "save-config", { eventCollection: "activities", managePagePath: "/rsvp/manage" });
    expect(saved.toast?.type).toBe("success");
    expect((await rsvp(activity)).result).toMatchObject({ ok: true, status: "going" });

    // Invalid slugs fall back to the default instead of breaking every RSVP.
    await host.admin.submit("/attendance", "save-config", { eventCollection: "Not A Slug!", managePagePath: "/rsvp/manage" });
    expect(await host.inspect.kv.get("config:v1")).toMatchObject({ eventCollection: "events" });
  });

  it("re-schedules missing background tasks when the admin page loads", async () => {
    await host.admin.loadPage("/attendance");
    const names = (await host.inspect.scheduledTasks()).map((t: any) => t.name ?? t.taskName ?? JSON.stringify(t));
    expect(names.join(" ")).toContain("waitlist-maintenance");
    expect(names.join(" ")).toContain("ledger-reconcile");
  });

  it("schedules its tasks from the public form route, for sites that list it in astro.config", async () => {
    // EmDash never runs plugin:activate for sandboxed plugins listed in astro.config.
    for (let i = 0; i < 4 && typeof (await host.inspect.kv.get("state:schedules")) !== "string"; i++) {
      await host.actions.routes.request("rsvp/form", { method: "GET", url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=missing` } as any);
    }
    const fingerprint = String(await host.inspect.kv.get("state:schedules"));
    expect(fingerprint).toBe("attendance-approvals=*/5 * * * *;attendance-language-packs=* * * * *;attendance-mail=* * * * *;attendance-reminders=* * * * *;attendance-retention=17 * * * *;ledger-reconcile=*/10 * * * *;waitlist-maintenance=* * * * *");
    const names = JSON.stringify(await host.inspect.scheduledTasks());
    expect(names).toContain("attendance-reminders");
    expect(names).toContain("attendance-approvals");
  });

  it("corrects ledger drift once the pool has been quiet, and leaves busy pools alone", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const a = await rsvp(eventId);
    const key = `ledger:${eventId}`;
    const old = new Date(Date.now() - 60 * 60_000).toISOString();

    // Drift: 3 phantom seats, e.g. from attendee writes that failed after the reservation.
    const ledgerNow = await ledger(eventId);
    await host.fixtures.plugin.kv(key, { ...ledgerNow, taken: 4, updatedAt: old });

    const reconcileUntil = async (done: () => Promise<boolean>) => {
      for (let n = 0; n < 80 && !(await done()); n++) {
        await host.transport.invokeHook("cron", { name: "ledger-reconcile" });
      }
    };

    // The attendee record was written moments ago: the pool counts as busy and is not touched.
    for (let n = 0; n < 80; n++) await host.transport.invokeHook("cron", { name: "ledger-reconcile" });
    expect((await ledger(eventId)).taken).toBe(4);

    // Once the records are quiet too, the ledger is recomputed from them.
    const row = await attendee(a.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, updatedAt: old });
    await reconcileUntil(async () => (await ledger(eventId)).taken === 1);
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 0, waitlistCount: 0 });
  });
});

describe("0.2: organiser reply-to", () => {
  const lastMailTo = async (email: string) => {
    const mails = (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(email));
    return JSON.stringify(mails[mails.length - 1] ?? {});
  };
  const saveConfig = (replyTo: string) =>
    host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", replyTo });

  it("uses the site-wide reply-to, lets an event override it, and keeps the override for later emails", async () => {
    await saveConfig("Office@Example.TEST");
    const plain = await makeEvent({ capacity: 5 });
    const a = await rsvp(plain);
    expect(await lastMailTo(a.email)).toContain('"replyTo":"office@example.test"');

    const special = await makeEvent({ capacity: 1, allow_waitlist: true });
    await host.admin.submitEditorPanel("event-attendance", "events", special, "save-attendance-settings", {
      enabled: true, capacity: 1, maxPerRegistration: 4, allowWaitlist: true, replyTo: "coach@example.test",
    });
    const first = await rsvp(special);
    const second = await rsvp(special);
    expect(await lastMailTo(first.email)).toContain('"replyTo":"coach@example.test"');

    // The waitlist offer is sent later, from the snapshot on the waitlist entry.
    await call("cancel", { token: await tokenFor(first.email, "cancel") });
    const offer = (await host.inspect.email()).filter((m) => JSON.stringify(m).includes("Claim within 2 hours") && JSON.stringify(m).includes(second.email));
    expect(JSON.stringify(offer)).toContain('"replyTo":"coach@example.test"');

    // Invalid addresses are dropped rather than sent.
    await saveConfig("not an address");
    const b = await rsvp(plain);
    expect(await lastMailTo(b.email)).not.toContain('"replyTo"');
    await saveConfig("");
  });
});

describe("0.2: move to end of waitlist", () => {
  it("unblocks a queue whose head can't fit the free seats, without touching seats", async () => {
    const eventId = await makeEvent({ capacity: 2, allow_waitlist: true });
    const a = await rsvp(eventId);
    await rsvp(eventId);
    const big = await rsvp(eventId, { quantity: 2 });
    const small = await rsvp(eventId);

    // One seat frees up; the head (2 seats) can't take it, so strict FIFO keeps everyone waiting.
    await call("cancel", { token: await tokenFor(a.email, "cancel") });
    await tickUntil(async () => false, 3);
    expect((await entryFor(big.result.attendeeId)).status).toBe("queued");
    expect((await entryFor(small.result.attendeeId)).status).toBe("queued");

    const res = await host.admin.act("/attendance", "move-to-end", { value: big.result.attendeeId });
    expect(res.toast?.type).toBe("success");
    const moved = await entryFor(big.result.attendeeId);
    expect(moved.position).toBeGreaterThan((await entryFor(small.result.attendeeId)).position);
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 0, waitlistCount: 3 });
    const notice = (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(big.email) && JSON.stringify(m).includes("end of the line"));
    expect(notice).toHaveLength(1);

    // The next person in line is offered the free seat on the next tick.
    await tickUntil(async () => (await entryFor(small.result.attendeeId)).status === "offered");
    expect((await entryFor(small.result.attendeeId)).status).toBe("offered");
    expect((await entryFor(big.result.attendeeId)).status).toBe("queued");
  });

  it("refuses to move someone who isn't waiting in the queue", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    const going = await rsvp(eventId);
    const res = await host.admin.act("/attendance", "move-to-end", { value: going.result.attendeeId });
    expect(res.toast?.type).toBe("error");
  });
});

describe("0.2: calendar links and reminders", () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const mailsTo = async (email: string, needle: string) =>
    (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(email) && JSON.stringify(m).includes(needle));
  const remind = () => host.transport.invokeHook("cron", { name: "attendance-reminders" });
  const saveLead = (hours: number) =>
    host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", replyTo: "", reminderLeadHours: hours });

  it("serves a calendar file for an occurrence and links it from the confirmation", async () => {
    const eventId = await makeEvent({ capacity: 5, start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:30:00.000Z", location: "Hall A, level 2" });
    const occurrence = "2026-12-08T10:00:00.000Z";
    const r = await rsvp(eventId, { occurrenceStart: occurrence });
    expect((await mailsTo(r.email, "/calendar?eventId=")).length).toBe(1);

    const base = `${SITE}/_emdash/api/plugins/eventual-attendance/calendar`;
    const res = await host.actions.routes.request("calendar", { method: "GET", url: `${base}?eventId=${eventId}&occurrence=${encodeURIComponent(occurrence)}` } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("DTSTART:20261208T100000Z");
    expect(ics).toContain("DTEND:20261208T113000Z"); // series duration applied to the occurrence
    expect(ics).toContain("LOCATION:Hall A\\, level 2");

    const draft = await makeEvent({ start: "2026-12-01T10:00:00.000Z" }, { status: "draft" });
    expect((await host.actions.routes.request("calendar", { method: "GET", url: `${base}?eventId=${draft}` } as any)).status).toBe(404);
  });

  it("sends each confirmed attendee one reminder inside the lead time, and none otherwise", async () => {
    await saveLead(24);
    const soon = await makeEvent({ capacity: 5, start: inHours(3), end: inHours(4), timezone: "Europe/Zurich" });
    const later = await makeEvent({ capacity: 5, start: inHours(72) });
    const a = await rsvp(soon);
    const cancelled = await rsvp(soon);
    await call("cancel", { token: await tokenFor(cancelled.email, "cancel") });
    const far = await rsvp(later);

    for (let n = 0; n < 4; n++) await remind();
    const reminders = await mailsTo(a.email, "Reminder:");
    expect(reminders).toHaveLength(1);
    expect(JSON.stringify(reminders[0])).toContain("/calendar?eventId=");
    expect(JSON.stringify(reminders[0])).toContain("#action=cancel&token=");
    expect(await mailsTo(cancelled.email, "Reminder:")).toHaveLength(0);
    expect(await mailsTo(far.email, "Reminder:")).toHaveLength(0);
    expect(await attendee(a.result.attendeeId)).toMatchObject({ reminder: "sent" });
  });

  it("sends no reminders when the lead time is 0", async () => {
    await saveLead(0);
    const soon = await makeEvent({ capacity: 5, start: inHours(2) });
    const b = await rsvp(soon);
    await remind();
    expect(await mailsTo(b.email, "Reminder:")).toHaveLength(0);
    expect(await attendee(b.result.attendeeId)).toMatchObject({ reminder: "due" });
    await saveLead(24);
  });

  it("never sends a reminder to an erased attendee", async () => {
    await saveLead(24);
    const soon = await makeEvent({ capacity: 5, start: inHours(2) });
    const b = await rsvp(soon);
    const row = await attendee(b.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, email: "", reminder: "due" });

    await remind();
    const emails = await host.inspect.email();
    expect(emails.some((m: any) => !m.to || m.to === "")).toBe(false);
    expect(await attendee(row.id)).toMatchObject({ reminder: "sent" });
  });
});

describe("0.2: admin overview from ledgers", () => {
  const block = (res: any, type: string) => res.blocks.filter((b: any) => b.type === type);
  const statValue = (res: any, label: string) =>
    block(res, "stats")[0].items.find((i: any) => i.label === label)?.value;

  it("narrows only the name list to one event, says so, and keeps the overview on all events", async () => {
    const eventId = await makeEvent({ title: "Climbing clinic", capacity: 2, allow_waitlist: true });
    const other = await makeEvent({ title: "Other event", capacity: 5 });
    const dates = ["2027-03-01T09:00:00.000Z", "2027-03-02T18:00:00.000Z"];
    await rsvp(eventId, { occurrenceStart: dates[0] });
    await rsvp(eventId, { occurrenceStart: dates[0] });
    await rsvp(eventId, { occurrenceStart: dates[0] }); // waitlisted
    await rsvp(eventId, { occurrenceStart: dates[1] });
    const outsider = await rsvp(other);

    const filtered = await host.admin.submit("/attendance", "apply-filter", { pool: eventId, occurrence: "" });
    // The overview always counts every event: a remembered filter must not hide one.
    expect(statValue(filtered, "Registered")).toBeGreaterThan(3);
    expect(block(filtered, "banner").map((b: any) => b.title)).toContain("Only showing: Climbing clinic");
    expect(JSON.stringify(filtered.blocks)).toContain("clear-filter");

    const [sessions, attendees] = block(filtered, "table").filter((t: any) => ["page-sessions", "page-attendees"].includes(t.page_action_id));
    const climbing = sessions.rows.filter((r: any) => r.label === "Climbing clinic");
    expect(climbing.map((r: any) => [r.taken, r.waiting])).toEqual([["2 / 2", 1], ["1 / 2", 0]]);
    expect(climbing.map((r: any) => r.used)).toEqual(["Full", "Places left"]);
    expect(climbing[0].view).toMatchObject({ action_id: "view-session" });
    expect(attendees.rows).toHaveLength(4);
    expect(JSON.stringify(attendees.rows)).not.toContain(outsider.email);

    const heatmap = block(filtered, "accordion").flatMap((a: any) => a.blocks).find((t: any) => t.block_id === "heatmap") as any;
    expect(heatmap.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: "Mon", starts: "09:00" }),
      expect.objectContaining({ day: "Tue", starts: "18:00" }),
    ]));

    // The filter survives a plain reload, still announced, and is cleared on request.
    const reloaded = await host.admin.loadPage("/attendance");
    expect(block(reloaded, "banner").map((b: any) => b.title)).toContain("Only showing: Climbing clinic");
    const cleared = await host.admin.act("/attendance", "clear-filter", {});
    expect(block(cleared, "banner").some((b: any) => String(b.title).startsWith("Only showing"))).toBe(false);
    const all = block(cleared, "table").find((t: any) => t.page_action_id === "page-attendees");
    expect(all.rows.length).toBeGreaterThan(4);
  });

  it("names upcoming ticketed events and links to Tickets → Orders", async () => {
    await makeEvent({ title: "Paid camp", inventory_mode: "tickets", start: "2027-07-06T07:00:00.000Z" });
    await makeEvent({ title: "Past paid camp", inventory_mode: "tickets", start: "2020-07-06T07:00:00.000Z" });
    await makeEvent({ title: "Draft paid camp", inventory_mode: "tickets" }, { status: "draft" });
    const res = await host.admin.loadPage("/attendance");
    const table = block(res, "table").find((t: any) => t.page_action_id === "page-ticketed");
    const labels = table.rows.map((r: any) => r.label);
    expect(labels).toContain("Paid camp");
    expect(labels).not.toContain("Past paid camp");
    expect(labels).not.toContain("Draft paid camp");
    expect(table.rows.find((r: any) => r.label === "Paid camp").date).toContain("2027");
    const link = block(res, "actions").flatMap((a: any) => a.elements).find((e: any) => e.type === "link" && e.label === "View orders");
    expect(link.target.url).toMatch(/\/_emdash\/admin\/plugins\/eventual-tickets\/orders$/);
  });

  it("shows a single event's own date instead of a placeholder", async () => {
    const eventId = await makeEvent({ title: "Dated camp", capacity: 5, start: "2027-06-07T07:30:00.000Z" });
    await rsvp(eventId, { displayName: "Dated Parent", email: "dated-parent@example.test" });
    await host.admin.submit("/attendance", "apply-filter", { pool: eventId, occurrence: "" });
    const res = await host.admin.loadPage("/attendance");
    const tables = block(res, "table");
    const row = tables.find((t: any) => t.page_action_id === "page-sessions").rows.find((r: any) => r.label === "Dated camp");
    expect(row.when).toContain("2027");
    const person = tables.find((t: any) => t.page_action_id === "page-attendees").rows.find((r: any) => r.email === "dated-parent@example.test");
    expect(person.occurrence).toContain("2027");
    await host.admin.act("/attendance", "clear-filter", {});
  });

  it("hides cancelled registrations until asked, and redraws the filter form for a new choice", async () => {
    const eventId = await makeEvent({ title: "Cancel camp", capacity: 5 });
    const kept = await rsvp(eventId, { displayName: "Still Coming", email: "still-coming@example.test" });
    const gone = await rsvp(eventId, { displayName: "Not Coming", email: "not-coming@example.test" });
    await host.admin.act("/attendance", "cancel-attendee", { value: gone.result.attendeeId });
    const res = await host.admin.submit("/attendance", "apply-filter", { pool: eventId, occurrence: "" });
    const emails = (r: any) => JSON.stringify(block(r, "table").find((t: any) => t.page_action_id === "page-attendees").rows);
    expect(emails(res)).toContain("still-coming@example.test");
    expect(emails(res)).not.toContain("not-coming@example.test");
    expect(block(res, "form").find((f: any) => String(f.block_id).startsWith("attendee-filter")).block_id).toContain(eventId);

    const shown = await host.admin.act("/attendance", "toggle-cancelled", {});
    expect(emails(shown)).toContain("not-coming@example.test");
    expect(JSON.stringify(shown.blocks)).toContain("Hide cancelled ones");
    const hidden = await host.admin.act("/attendance", "toggle-cancelled", {});
    expect(emails(hidden)).not.toContain("not-coming@example.test");
    expect(kept.result.ok).toBe(true);
    await host.admin.act("/attendance", "clear-filter", {});
  });

  it("narrows to one date and drops stale filter values", async () => {
    const eventId = await makeEvent({ title: "Evening run", capacity: 10 });
    await rsvp(eventId, { occurrenceStart: "2027-04-01T17:00:00.000Z" });
    await rsvp(eventId, { occurrenceStart: "2027-04-08T17:00:00.000Z" });
    const one = await host.admin.submit("/attendance", "apply-filter", { pool: eventId, occurrence: "2027-04-08T17:00:00.000Z" });
    expect(block(one, "table").find((t: any) => t.page_action_id === "page-attendees").rows).toHaveLength(1);
    expect(block(one, "banner").find((b: any) => String(b.title).startsWith("Only showing: Evening run · ")).title).toContain("Apr");

    const stale = await host.admin.submit("/attendance", "apply-filter", { pool: "no-such-pool", occurrence: "2027-04-08T17:00:00.000Z" });
    const form = stale.blocks.find((b: any) => String(b.block_id).startsWith("attendee-filter")) as any;
    expect(form.fields[0].initial_value).toBe("");
    await host.admin.act("/attendance", "clear-filter", {});
  });

  it("returns a light page after the maintenance button instead of overspending the budget", async () => {
    const res = await host.admin.act("/attendance", "run-maintenance", {});
    expect(res.toast?.message).toMatch(/Expired \d+ offer/);
    expect(JSON.stringify(res.blocks)).toContain("Open the page again");
  });
});

describe("0.2: registration questions", () => {
  const QUESTION_TEXT = [
    "T-shirt size | select | required | S, M, L",
    "Dietary needs | textarea",
    "I accept the club rules | checkbox | required",
  ].join("\n");
  const settings = (extra: Record<string, unknown> = {}) => ({
    enabled: true, capacity: 5, maxPerRegistration: 3, allowWaitlist: false, replyTo: "", questions: QUESTION_TEXT, ...extra,
  });
  const formDef = async (eventId: string) => {
    const res = await host.actions.routes.request("rsvp/form", {
      method: "GET",
      url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=${eventId}`,
    } as any);
    const json = (await res.json()) as any;
    return json.success ? json.data : json;
  };

  it("saves questions from the editor panel and publishes them to the form route", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const saved = await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", settings());
    expect(saved.toast?.type).toBe("success");
    expect(JSON.stringify(saved.blocks)).toContain("1. T-shirt size · Choice from a list · required");

    const def = await formDef(eventId);
    expect(def).toMatchObject({ ok: true, open: true, maxPerRegistration: 3, allowWaitlist: false });
    expect(def.questions.map((q: any) => [q.id, q.type, q.required])).toEqual([
      ["t_shirt_size", "select", true],
      ["dietary_needs", "textarea", false],
      ["i_accept_the_club_rules", "checkbox", true],
    ]);
  });

  it("edits questions one row at a time and keeps their ids", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const panel = (action: string, values: Record<string, unknown>) =>
      host.admin.submitEditorPanel("event-attendance", "events", eventId, action, values);
    const ids = async () => (await formDef(eventId)).questions.map((q: any) => `${q.id}:${q.type}:${q.required}:${(q.options ?? []).join("/")}`);

    // Adding works before any settings were saved, and doesn't close or open the event.
    expect((await panel("add-question", { label: "T-shirt size", type: "select", required: true, options: "S" + String.fromCharCode(10) + "M" + String.fromCharCode(10) + "L" })).toast?.type).toBe("success");
    expect((await panel("add-question", { label: "Dietary needs", type: "textarea", required: false })).toast?.type).toBe("success");
    expect((await panel("add-question", { label: "T-shirt size", type: "text" })).toast?.type).toBe("success");
    expect(await ids()).toEqual(["t_shirt_size:select:true:S/M/L", "dietary_needs:textarea:false:", "t_shirt_size_2:text:false:"]);
    expect((await formDef(eventId)).open).toBe(true);

    // Renaming keeps the id, so answers already given still match.
    const renamed = await panel("save-question:t_shirt_size", { label: "Shirt size", type: "select", required: false, options: "S, M" });
    expect(renamed.toast?.type).toBe("success");
    expect(JSON.stringify(renamed.blocks)).toContain("1. Shirt size · Choice from a list");
    expect((await ids())[0]).toBe("t_shirt_size:select:false:S/M");

    // A bad row is refused, explained without a line number, and shown again with what was typed.
    const bad = await panel("save-question:dietary_needs", { label: "Diet", type: "select", options: "" });
    expect(bad.toast?.type).toBe("error");
    expect(JSON.stringify(bad.blocks)).toContain("needs at least one choice");
    expect(JSON.stringify(bad.blocks)).not.toContain("Line 1");
    expect(JSON.stringify(bad.blocks)).toContain('"initial_value":"Diet"');
    expect((await ids())[1]).toBe("dietary_needs:textarea:false:");
    expect((await panel("add-question", { label: "  ", type: "text" })).toast?.type).toBe("error");

    const act = (action: string, value: string) =>
      host.admin.actEditorPanel("event-attendance", "events", eventId, action, { value });
    await act("move-question-up", "dietary_needs");
    expect((await ids()).map((q: string) => q.split(":")[0])).toEqual(["dietary_needs", "t_shirt_size", "t_shirt_size_2"]);
    await act("remove-question", "t_shirt_size_2");
    expect((await ids()).length).toBe(2);
    expect((await act("remove-question", "t_shirt_size_2")).toast?.type).toBe("error");

    // Saving the settings form (which sends no questions) keeps the questions.
    await panel("save-attendance-settings", { enabled: true, maxPerRegistration: 2 });
    expect((await ids()).length).toBe(2);
  });

  it("leaves capacity and the waitlist to the event form when the event has those fields", async () => {
    const eventId = await makeEvent({ capacity: 7, allow_waitlist: true });
    const pool = (await host.inspect.content.get("events", eventId))!.translationGroup || eventId;
    const loaded = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId));
    expect(loaded).not.toContain('"action_id":"capacity"');
    expect(loaded).not.toContain('"action_id":"allowWaitlist"');
    expect(loaded).toContain("7 places · waiting list on");

    // The panel's form sends neither; nothing is stored for them, so the event's fields apply.
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", { enabled: true, maxPerRegistration: 2 });
    const stored = (await host.inspect.storage.get("attendance_settings", pool)) as any;
    expect(stored.capacity).toBeUndefined();
    expect(stored.allowWaitlist).toBeUndefined();
    expect(await formDef(eventId)).toMatchObject({ open: true, maxPerRegistration: 2, allowWaitlist: true });

    // The way to the list is there before anyone has registered.
    expect(loaded).toContain('"action_id":"view-registrations"');

    // A value saved by a script still wins and is pointed out, but only when it differs. One
    // that matches the event's field is not kept, so a later change to the field applies.
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", { enabled: true, capacity: 7 });
    expect(JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId))).not.toContain("Older settings in this panel");
    expect(((await host.inspect.storage.get("attendance_settings", pool)) as any).capacity).toBeUndefined();
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", { enabled: true, capacity: 3 });
    expect(JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId))).toContain("Older settings in this panel");

    const nav = await host.admin.actEditorPanel("event-attendance", "events", eventId, "view-registrations");
    expect(nav.navigate).toEqual({ kind: "plugin-page", path: "/attendance" });
  });

  it("shows open state, places and waiting list read-only when the collection has the fields, even empty ones", async () => {
    // inventory_mode, capacity and allow_waitlist all empty: EmDash leaves them out of the data.
    const eventId = await makeEvent({ inventory_mode: null });
    const data = (await host.inspect.content.get("events", eventId))!.data as Record<string, unknown>;
    expect("capacity" in data || "allow_waitlist" in data || "inventory_mode" in data).toBe(false);

    const loaded = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId));
    expect(loaded).not.toContain('"action_id":"enabled"');
    expect(loaded).not.toContain('"action_id":"capacity"');
    expect(loaded).not.toContain('"action_id":"allowWaitlist"');
    expect(loaded).toContain("From the event form: Closed for registration · No limit on places · no waiting list.");
    expect(loaded).toContain("is set to “Rsvp”");
    // The settings without a field stay in the panel.
    expect(loaded).toContain('"action_id":"maxPerRegistration"');
    expect(loaded).toContain('"action_id":"requireApproval"');
    expect(loaded).toContain('"action_id":"replyTo"');
    expect(loaded).not.toContain("Older settings in this panel");
    const fr = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId, { locale: "fr" } as any));
    expect(fr).toContain("D’après le formulaire de l’événement : Inscriptions fermées · Places sans limite · pas de liste d’attente.");
    expect(fr).not.toContain('"action_id":"enabled"');

    // Saving the panel's own form (as the admin sends it) opens nothing and stores none of the three.
    const pool = (await host.inspect.content.get("events", eventId))!.translationGroup || eventId;
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", {
      maxPerRegistration: 2, requireApproval: false, approvalHours: 48, replyTo: "",
    });
    const stored = (await host.inspect.storage.get("attendance_settings", pool)) as any;
    expect(stored).toMatchObject({ maxPerRegistration: 2 });
    expect(stored.enabled).toBeUndefined();
    expect(stored.capacity).toBeUndefined();
    expect(stored.allowWaitlist).toBeUndefined();
    expect((await rsvp(eventId)).result).toMatchObject({ ok: false, error: "RSVP_DISABLED" });
  });

  it("points out values an older version stored, and drops them on request", async () => {
    const eventId = await makeEvent({ inventory_mode: null, capacity: 10 });
    const pool = (await host.inspect.content.get("events", eventId))!.translationGroup || eventId;
    // As the old panel saved them: its switch, places and waiting list, next to a setting it keeps.
    await host.fixtures.plugin.storage("attendance_settings", pool, {
      eventId: pool, enabled: true, capacity: 3, allowWaitlist: true, maxPerRegistration: 2, questions: [],
    });
    expect((await rsvp(eventId)).result).toMatchObject({ ok: true, status: "going" });

    const loaded = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId));
    expect(loaded).toContain("Older settings in this panel still apply");
    expect(loaded).toContain('"action_id":"use-event-fields"');
    // The status line shows what applies; the read-only line what the event's fields say.
    expect(loaded).toContain("Open for registration · 1 of 3 places taken");
    expect(loaded).toContain("From the event form: Closed for registration · 10 places · no waiting list.");

    const cleared = await host.admin.actEditorPanel("event-attendance", "events", eventId, "use-event-fields");
    expect(cleared.toast).toMatchObject({ type: "success", message: "The event's own fields apply again." });
    expect(JSON.stringify(cleared.blocks)).not.toContain("Older settings in this panel");
    const stored = (await host.inspect.storage.get("attendance_settings", pool)) as any;
    expect(stored).toMatchObject({ maxPerRegistration: 2 });
    expect(stored.enabled).toBeUndefined();
    expect(stored.capacity).toBeUndefined();
    expect(stored.allowWaitlist).toBeUndefined();
    expect((await rsvp(eventId)).result).toMatchObject({ ok: false, error: "RSVP_DISABLED" });
  });

  it("keeps older differing values when the panel's own form is saved", async () => {
    // Saving another setting must not quietly close (or reopen) registration: only the button drops them.
    const eventId = await makeEvent({ inventory_mode: null, capacity: 10 });
    const pool = (await host.inspect.content.get("events", eventId))!.translationGroup || eventId;
    await host.fixtures.plugin.storage("attendance_settings", pool, {
      eventId: pool, enabled: true, capacity: 3, allowWaitlist: false, maxPerRegistration: 2, questions: [],
    });
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", {
      maxPerRegistration: 3, requireApproval: false, approvalHours: 48, replyTo: "",
    });
    const stored = (await host.inspect.storage.get("attendance_settings", pool)) as any;
    expect(stored).toMatchObject({ enabled: true, capacity: 3, maxPerRegistration: 3 });
    // Equal to the event's field (no waiting list): not kept.
    expect(stored.allowWaitlist).toBeUndefined();
    expect((await rsvp(eventId)).result).toMatchObject({ ok: true, status: "going" });
    expect(JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId))).toContain("Older settings in this panel still apply");
  });

  it("keeps all three settings in the panel for a collection without the fields", async () => {
    await host.fixtures.collection({ slug: "meetups", label: "Meetups", fields: [
      { slug: "title", label: "Title", type: "string" }, { slug: "start", label: "Start", type: "datetime" },
    ] } as any);
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events, meetups", managePagePath: "/rsvp/manage" });
    try {
      const item = await host.fixtures.content("meetups", { data: { title: "Meetup" }, status: "published" } as any);
      const loaded = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "meetups", item.id));
      expect(loaded).toContain('"action_id":"enabled"');
      expect(loaded).toContain('"action_id":"capacity"');
      expect(loaded).toContain('"action_id":"allowWaitlist"');
      expect(loaded).not.toContain("From the event form");

      await host.admin.submitEditorPanel("event-attendance", "meetups", item.id, "save-attendance-settings", {
        enabled: true, capacity: 1, allowWaitlist: false, maxPerRegistration: 1,
      });
      expect((await rsvp(item.id, { collection: "meetups" })).result).toMatchObject({ ok: true, status: "going" });
      expect((await rsvp(item.id, { collection: "meetups" })).result).toMatchObject({ ok: false, status: "full" });
    } finally {
      await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage" });
    }
  });

  it("says one neutral line on pages and other content, and points only event collections to the settings", async () => {
    await host.fixtures.collection({ slug: "articles", label: "Articles", fields: [{ slug: "title", label: "Title", type: "string" }] } as any);
    const page = await host.fixtures.content("articles", { data: { title: "About" }, status: "published" } as any);
    const onPage = await host.admin.loadEditorPanel("event-attendance", "articles", page.id);
    expect(onPage.blocks).toEqual([{ type: "context", text: "Registrations are not used for this kind of content." }]);

    const fr = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "articles", page.id, { locale: "fr" } as any));
    expect(fr).not.toContain("Add this collection");
    expect(fr).not.toContain("Ajoutez cette collection");

    // An events collection the site builder hasn't listed yet still gets the pointer.
    await host.fixtures.collection({ slug: "workshops", label: "Workshops", fields: EVENT_FIELDS } as any);
    const workshop = await host.fixtures.content("workshops", { data: { title: "Workshop" }, status: "published" } as any);
    expect(JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "workshops", workshop.id))).toContain("Add this collection");
  });

  it("refuses bad question lines without saving anything", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", settings());
    const bad = await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings",
      settings({ capacity: 9, questions: "Size | select\nAge | integer" }));
    expect(bad.toast?.type).toBe("error");
    expect(JSON.stringify(bad.blocks)).toContain("Line 1: a choice from a list needs at least one choice");
    expect(JSON.stringify(bad.blocks)).toContain("Line 2:");
    const pool = (await host.inspect.content.get("events", eventId))!.translationGroup || eventId;
    // The first save stays: no capacity of its own (it matched the event's field), not the 9.
    const stored = (await host.inspect.storage.get("attendance_settings", pool)) as any;
    expect(stored).toMatchObject({ maxPerRegistration: 3 });
    expect(stored.capacity).toBeUndefined();
  });

  it("shows question parse errors in French when admin locale is fr", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const bad = await host.admin.submitEditorPanel(
      "event-attendance",
      "events",
      eventId,
      "save-attendance-settings",
      settings({ questions: "Taille | couleur" }),
      { locale: "fr" }
    );
    expect(bad.toast?.type).toBe("error");
    expect(JSON.stringify(bad.blocks)).toContain("n’est pas un type");
    expect(JSON.stringify(bad.blocks)).toContain("Ligne 1 :");
  });

  it("validates answers before reserving and stores them with label snapshots", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", settings());

    const missing = await rsvp(eventId, { answers: { t_shirt_size: "XXL" } });
    expect(missing.result).toEqual({
      ok: false,
      error: "INVALID_ANSWERS",
      fields: { t_shirt_size: "INVALID", i_accept_the_club_rules: "REQUIRED" },
    });
    expect(await host.inspect.kv.get(`ledger:${eventId}`)).toBeNull(); // nothing reserved

    const good = await rsvp(eventId, { answers: { t_shirt_size: "M", i_accept_the_club_rules: true, smuggled: "<b>x</b>" } });
    expect(good.result).toMatchObject({ ok: true, status: "going" });
    expect((await attendee(good.result.attendeeId)).answers).toEqual([
      { id: "t_shirt_size", label: "T-shirt size", value: "M" },
      { id: "i_accept_the_club_rules", label: "I accept the club rules", value: true },
    ]);

    // Answers appear in the admin list and the CSV roster.
    const page = await host.admin.submit("/attendance", "apply-filter", { pool: eventId, occurrence: "" });
    const attendees = page.blocks.find((b: any) => b.page_action_id === "page-attendees") as any;
    expect(attendees.rows[0].answers).toBe("T-shirt size: M; I accept the club rules: Yes");
    await host.admin.act("/attendance", "clear-filter", {});

    const prepared = await host.admin.act("/attendance/roster", "prepare-export-csv");
    const url = JSON.stringify(prepared.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)![0];
    const csv = await (await host.actions.routes.request("roster/download", { method: "GET", url } as any)).text();
    expect(csv.split("\r\n")[0].split(",")).toContain("Answers");
    expect(csv).toContain('"T-shirt size: M; I accept the club rules: Yes"');
  });

  it("tells the form when registration is closed, and refuses unknown or unpublished events", async () => {
    const closed = await makeEvent({ capacity: 5, inventory_mode: null });
    expect(await formDef(closed)).toMatchObject({ ok: true, open: false, questions: [] });
    const draft = await makeEvent({ capacity: 5 }, { status: "draft" });
    expect(await formDef(draft)).toMatchObject({ ok: false, error: "EVENT_NOT_FOUND" });
  });
});

describe("deleting events", () => {
  it("blocks trashing an event with an upcoming registration", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await rsvp(eventId);
    let res: any;
    if (typeof (host.actions as any)?.content?.trash === "function") {
      res = await (host.actions as any).content.trash("events", eventId);
      expect(res.success === false || res.error === "DELETE_BLOCKED" || res === false).toBe(true);
    } else {
      // host.actions.content.trash is not exposed on this test host; invoking hook directly via transport
      res = await host.transport.invokeHook("content:beforeDelete", { id: eventId, collection: "events", permanent: false });
      expect(res).toBe(false);
    }
    expect(await host.inspect.content.get("events", eventId)).toBeDefined();
  });

  it("allows trashing an event whose registrations are cancelled or in the past", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const a = await rsvp(eventId);
    await call("cancel", { token: await tokenFor(a.email, "cancel") });
    let res: any;
    if (typeof (host.actions as any)?.content?.trash === "function") {
      res = await (host.actions as any).content.trash("events", eventId);
      expect(res?.success !== false && res?.error !== "DELETE_BLOCKED").toBe(true);
    } else {
      // host.actions.content.trash is not exposed on this test host; invoking hook directly via transport
      res = await host.transport.invokeHook("content:beforeDelete", { id: eventId, collection: "events", permanent: false });
      expect(res).toBeUndefined();
    }
  });

  it("ignores other collections", async () => {
    await host.fixtures.collection({ slug: "pages", label: "Pages", fields: [{ slug: "title", label: "Title", type: "string" }] } as any);
    const page = await host.fixtures.content("pages", { data: { title: "About" }, status: "published" } as any);
    let res: any;
    if (typeof (host.actions as any)?.content?.trash === "function") {
      res = await (host.actions as any).content.trash("pages", page.id);
      expect(res?.success !== false).toBe(true);
    } else {
      // host.actions.content.trash is not exposed on this test host; invoking hook directly via transport
      res = await host.transport.invokeHook("content:beforeDelete", { id: page.id, collection: "pages", permanent: false });
      expect(res).toBeUndefined();
    }
  });
});

describe("queued mail", () => {
  it("normal RSVP answers email: 'sent' and has no mail field; cron with nothing queued sends nothing", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const res = await rsvp(eventId);
    expect(res.result).toMatchObject({ ok: true, email: "sent" });
    const record = await attendee(res.result.attendeeId);
    expect(record.mail).toBeUndefined();

    const emailsBefore = (await host.inspect.email()).length;
    await host.transport.invokeHook("cron", { name: "attendance-mail" });
    expect((await host.inspect.email()).length).toBe(emailsBefore);
  });

  it("does not mail a queued record that was cancelled before the tick", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    const a = await rsvp(eventId);
    const row = await attendee(a.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, mail: "queued" });

    await call("cancel", { token: await tokenFor(a.email, "cancel") });
    const emailsBefore = (await host.inspect.email()).length;
    await host.transport.invokeHook("cron", { name: "attendance-mail" });
    expect((await host.inspect.email()).length).toBe(emailsBefore);
  });
});

describe("privacy", () => {
  it("erases personal data of past events after the retention period", async () => {
    const pastDate = "2020-01-01T10:00:00.000Z";
    const eventId = await makeEvent({ capacity: 5, start: pastDate });
    const a = await rsvp(eventId, { occurrenceStart: pastDate });
    const row = await attendee(a.result.attendeeId);
    expect(row.retainFrom).toBeDefined();

    // Overwrite retainFrom to an old date
    await host.fixtures.plugin.storage("attendees", row.id, {
      ...row,
      occurrenceStart: pastDate,
      retainFrom: "2020-01-01T00:00:00.000Z",
    });

    const statusBefore = row.status;
    const takenBefore = (await host.inspect.kv.get<CapacityLedger>(`ledger:${eventId}:${pastDate}`))!.taken;

    await host.transport.invokeHook("cron", { name: "attendance-retention" });

    const erased = await attendee(row.id);
    expect(erased.displayName).toBe("");
    expect(erased.email).toBe("");
    expect(erased.retainFrom).toBe("~erased");
    expect(erased.status).toBe(statusBefore);
    expect(erased.erasedAt).toBeDefined();
    expect((await host.inspect.kv.get<CapacityLedger>(`ledger:${eventId}:${pastDate}`))!.taken).toBe(takenBefore);
  });

  it("retention keeps a live undated booking and moves it back", async () => {
    const eventId = await makeEvent({ capacity: 5 }); // without date
    const a = await rsvp(eventId);
    const row = await attendee(a.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, {
      ...row,
      retainFrom: "2020-01-01T00:00:00.000Z",
    });

    await host.transport.invokeHook("cron", { name: "attendance-retention" });

    const kept = await attendee(row.id);
    expect(kept.displayName).toBe(row.displayName);
    expect(kept.email).toBe(row.email);
    expect(kept.retainFrom).not.toBe("~erased");
    const diffMs = Math.abs(Date.now() - Date.parse(kept.retainFrom!));
    expect(diffMs).toBeLessThan(60_000);
  });

  it("retention doesn't get stuck behind live bookings", async () => {
    const liveEventId = await makeEvent({ capacity: 10 }); // undated
    const liveIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await rsvp(liveEventId);
      const row = await attendee(res.result.attendeeId);
      await host.fixtures.plugin.storage("attendees", row.id, {
        ...row,
        retainFrom: "2020-01-01T00:00:00.000Z",
      });
      liveIds.push(row.id);
    }

    const pastDate = "2020-01-01T10:00:00.000Z";
    const pastEventId = await makeEvent({ capacity: 5, start: pastDate });
    const erasable = await rsvp(pastEventId, { occurrenceStart: pastDate });
    await call("cancel", { token: await tokenFor(erasable.email, "cancel") });
    const erasableRow = await attendee(erasable.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", erasableRow.id, {
      ...erasableRow,
      occurrenceStart: pastDate,
      retainFrom: "2020-01-02T00:00:00.000Z",
    });

    // Run up to 2 retention ticks: tick 1 moves the 4 live bookings to now; tick 2 erases the erasable booking
    await host.transport.invokeHook("cron", { name: "attendance-retention" });
    await host.transport.invokeHook("cron", { name: "attendance-retention" });

    const erased = await attendee(erasableRow.id);
    expect(erased.retainFrom).toBe("~erased");
    expect(erased.email).toBe("");

    for (const id of liveIds) {
      const live = await attendee(id);
      expect(live.displayName).toBeTruthy();
      expect(live.email).toBeTruthy();
    }
  });

  it("keeps data of upcoming events", async () => {
    const futureDate = new Date(Date.now() + 86_400_000 * 30).toISOString();
    const eventId = await makeEvent({ capacity: 5, start: futureDate });
    const a = await rsvp(eventId, { occurrenceStart: futureDate });
    const row = await attendee(a.result.attendeeId);

    await host.transport.invokeHook("cron", { name: "attendance-retention" });

    const kept = await attendee(row.id);
    expect(kept.displayName).toBe(row.displayName);
    expect(kept.email).toBe(row.email);
    expect(kept.retainFrom).not.toBe("~erased");
  });

  it("erases on request, but not live registrations", async () => {
    const email = `privacy_${++personSeq}@example.test`;
    const pastDate = "2020-01-01T10:00:00.000Z";
    const futureDate = new Date(Date.now() + 86_400_000 * 30).toISOString();

    const pastEventId = await makeEvent({ capacity: 5, start: pastDate });
    const futureEventId = await makeEvent({ capacity: 5, start: futureDate });

    const pastRsvp = await call("rsvp", { eventId: pastEventId, email, displayName: "Past Person", quantity: 1, occurrenceStart: pastDate });
    const liveRsvp = await call("rsvp", { eventId: futureEventId, email, displayName: "Live Person", quantity: 1, occurrenceStart: futureDate });

    // Cancel the past RSVP via fixtures
    const pastRow = await attendee(pastRsvp.attendeeId);
    await host.fixtures.plugin.storage("attendees", pastRow.id, { ...pastRow, status: "cancelled", occurrenceStart: pastDate });

    // Find personal data
    const findRes = await host.admin.submit("/attendance", "find-personal-data", { eraseEmail: email });
    const findStr = JSON.stringify(findRes);
    expect(findStr).toContain(email);
    expect(findStr).toContain("erase-personal-data");

    // Erase personal data
    const eraseRes = await host.admin.act("/attendance", "erase-personal-data", { value: email });
    expect(JSON.stringify(eraseRes)).toContain("Personal data erased");

    const pastAfter = await attendee(pastRsvp.attendeeId);
    expect(pastAfter.displayName).toBe("");
    expect(pastAfter.email).toBe("");
    expect(pastAfter.retainFrom).toBe("~erased");

    const liveAfter = await attendee(liveRsvp.attendeeId);
    expect(liveAfter.displayName).toBe("Live Person");
    expect(liveAfter.email).toBe(email);
    expect(liveAfter.retainFrom).not.toBe("~erased");
  });

  it("an erased attendee shows as Erased without actions", async () => {
    const email = `erased_${++personSeq}@example.test`;
    const pastDate = "2020-01-01T10:00:00.000Z";
    const eventId = await makeEvent({ capacity: 5, start: pastDate });
    const booked = await call("rsvp", { eventId, email, displayName: "Erased Person", quantity: 1, occurrenceStart: pastDate });
    const row = await attendee(booked.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, status: "cancelled", occurrenceStart: pastDate });

    await host.admin.act("/attendance", "erase-personal-data", { value: email });

    await host.admin.loadPage("/attendance"); // warm the isolate so the page is not the light fallback
    const findErasedRow = async (locale?: string) => {
      let page = await host.admin.loadPage("/attendance", locale ? { locale } : undefined);
      for (let i = 0; i < 20; i++) {
        const table = page.blocks.find((b: any) => b.type === "table" && b.page_action_id === "page-attendees") as any;
        const found = table.rows.find((r: any) => r.status === "Erased" || r.status === "Effacée");
        if (found) return found;
        if (!table.next_cursor) return null;
        page = await host.admin.act("/attendance", "page-attendees", { ...(locale ? { locale } : {}), value: { cursor: table.next_cursor } });
      }
      return null;
    };

    const erasedRow = await findErasedRow();
    expect(erasedRow).toMatchObject({ displayName: "—", email: "—", answers: "" });
    expect(erasedRow.action).toBeUndefined();
    expect(erasedRow.cancelAction).toBeUndefined();

    const frRow = await findErasedRow("fr");
    expect(frRow.status).toBe("Effacée");
    expect(frRow.action).toBeUndefined();
    expect(frRow.cancelAction).toBeUndefined();

    for (const format of ["csv", "html"]) {
      const invoked = (await host.transport.invokeRoute("roster/export", {
        request: {
          url: `https://example.test/_emdash/api/plugins/eventual-attendance/roster/export?eventId=${eventId}&format=${format}`,
          method: "GET",
          headers: {},
        },
      } as any)) as any;
      expect(invoked.status).toBe(200);
      expect(invoked.body.value).toContain("Erased");
      expect(invoked.body.value).toContain("—");
    }

    // A stale action posted from an old page must be refused.
    const refused = await host.admin.act("/attendance", "checkin-attendee", { value: row.id });
    expect(refused.toast).toMatchObject({ type: "error", message: "Only confirmed registrations can be checked in." });
    expect((await attendee(row.id)).status).toBe("cancelled");
  });

  it("settings: saving retentionDays: 10 stores 30 (minimum)", async () => {
    await host.admin.submit("/attendance", "save-config", {
      eventCollection: "events",
      managePagePath: "/rsvp/manage",
      retentionDays: 10,
    });
    const cfg = await host.inspect.kv.get<any>("config:v1");
    expect(cfg.retentionDays).toBe(30);
  });
});

describe("per-IP rate limiting (suite D18)", () => {
  // plugin-test's actions.routes.request drops `meta` when constructing the synthetic Request;
  // transport.invokeRoute forwards `meta` into the sandbox isolate as `routeCtx.requestMeta`.
  const postFromIp = (body: unknown, ip: string) =>
    host.transport.invokeRoute("rsvp", body, {
      method: "POST",
      meta: { ip, userAgent: null, referer: null, geo: null },
    }) as Promise<any>;

  it("refuses the 11th booking from one IP within 10 minutes", async () => {
    const eventId = await makeEvent({ capacity: 50 });
    const ip = "203.0.113.7";
    for (let i = 0; i < 10; i++) {
      const res = await postFromIp({
        eventId,
        email: `ip7_${++personSeq}@example.test`,
        displayName: `Person ${personSeq}`,
        quantity: 1,
        firstAttempt: true,
      }, ip);
      expect(res).toMatchObject({ ok: true, status: "going" });
    }

    const eleventh = await postFromIp({
      eventId,
      email: `ip7_${++personSeq}@example.test`,
      displayName: `Person ${personSeq}`,
      quantity: 1,
      firstAttempt: true,
    }, ip);
    expect(eleventh).toMatchObject({ ok: false, error: "RATE_LIMITED" });

    const otherIp = await postFromIp({
      eventId,
      email: `ip8_${++personSeq}@example.test`,
      displayName: `Person ${personSeq}`,
      quantity: 1,
      firstAttempt: true,
    }, "203.0.113.8");
    expect(otherIp).toMatchObject({ ok: true, status: "going" });
  });

  it("skips the IP limit when Turnstile is on", async () => {
    const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    const SITE_KEY = "1x00000000000000000000AA";
    const SECRET = "1x0000000000000000000000000000000AA";
    const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
    await host.admin.submit("/attendance", "save-config", {
      eventCollection: "events",
      managePagePath: "/rsvp/manage",
      turnstileSiteKey: SITE_KEY,
      turnstileSecretKey: SECRET,
    });
    try {
      const eventId = await makeEvent({ capacity: 50 });
      const ip = "203.0.113.9";
      for (let i = 0; i < 11; i++) {
        await host.http.respond(VERIFY, new Response(JSON.stringify({ success: true }), { status: 200 }));
        const res = await postFromIp({
          eventId,
          email: `ip9_${++personSeq}@example.test`,
          displayName: `Person ${personSeq}`,
          quantity: 1,
          turnstileToken: TOKEN,
          firstAttempt: true,
        }, ip);
        expect(res).toMatchObject({ ok: true, status: "going" });
      }
    } finally {
      await host.admin.submit("/attendance", "save-config", {
        eventCollection: "events",
        managePagePath: "/rsvp/manage",
        turnstileSiteKey: "",
        turnstileSecretKey: "",
      });
    }
  });

  it("stores only a hash of the IP", async () => {
    const eventId = await makeEvent({ capacity: 10 });
    const rawIp = "203.0.113.42";
    const res = await postFromIp({
      eventId,
      email: `ip42_${++personSeq}@example.test`,
      displayName: `Person ${personSeq}`,
      quantity: 1,
      firstAttempt: true,
    }, rawIp);
    expect(res).toMatchObject({ ok: true, status: "going" });
    const row = await attendee(res.attendeeId);
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain(rawIp);
  });
});

describe("event time zone in admin and rosters", () => {
  it("formats Zurich sessions as local time in the overview and French CSV, and falls back to UTC", async () => {
    const zurichOcc = "2027-01-12T09:00:00.000Z"; // CET (+1) -> 10:00
    const zurichId = await makeEvent({
      title: "Zurich Morning",
      capacity: 10,
      timezone: "Europe/Zurich",
      start: zurichOcc,
    });
    const r1 = await rsvp(zurichId, { occurrenceStart: zurichOcc, displayName: "Zuri Guest" });
    expect(r1.result).toMatchObject({ ok: true, status: "going" });

    const utcOcc = "2027-01-13T09:00:00.000Z";
    const utcId = await makeEvent({
      title: "UTC Session",
      capacity: 10,
      start: utcOcc,
    });
    const r2 = await rsvp(utcId, { occurrenceStart: utcOcc, displayName: "Utc Guest" });
    expect(r2.result).toMatchObject({ ok: true, status: "going" });

    const zPage = await host.admin.submit("/attendance", "apply-filter", { pool: zurichId, occurrence: "" });
    const zSessions = zPage.blocks.find((b: any) => b.page_action_id === "page-sessions") as any;
    expect(zSessions.rows[0].when).toContain("10:00");
    const zAttendees = zPage.blocks.find((b: any) => b.page_action_id === "page-attendees") as any;
    expect(zAttendees.rows[0].occurrence).toContain("10:00");

    const frPrep = await host.admin.act("/attendance/roster", "prepare-export-csv", { locale: "fr" });
    const frUrl = JSON.stringify(frPrep.blocks).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)![0];
    const frCsv = await (await host.actions.routes.request("roster/download", { method: "GET", url: frUrl } as any)).text();
    const lines = frCsv.split("\r\n");
    expect(lines[0]).toContain("Heure locale");
    const zuriRow = lines.find((l) => l.includes("Zuri Guest"))!;
    expect(zuriRow).toContain(zurichOcc);
    expect(zuriRow).toContain("10:00");

    const uPage = await host.admin.submit("/attendance", "apply-filter", { pool: utcId, occurrence: "" });
    const uSessions = uPage.blocks.find((b: any) => b.page_action_id === "page-sessions") as any;
    expect(uSessions.rows[0].when).toContain("UTC");

    await host.admin.act("/attendance", "clear-filter", {});
  });

  it("uses the default time zone for events that have none, and UTC when it is empty", async () => {
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", defaultTimezone: "Europe/Zurich" });
    const occ = "2027-05-03T07:30:00.000Z"; // 09:30 in Zurich (summer time)
    const eventId = await makeEvent({ title: "Camp sans fuseau", capacity: 10, start: occ });
    const booked = await rsvp(eventId, { occurrenceStart: occ, displayName: "Zone Default", email: "zone-default@example.test" });
    expect(booked.result).toMatchObject({ ok: true, status: "going" });
    const row = (await host.inspect.storage.list<AttendeeRecord>("attendees")).find((r) => r.data.email === "zone-default@example.test")!;
    expect(row.data.timezone).toBe("Europe/Zurich");
    const page = await host.admin.loadPage("/attendance");
    const sessions = page.blocks.find((b: any) => b.page_action_id === "page-sessions") as any;
    const camp = sessions.rows.find((r: any) => r.label === "Camp sans fuseau");
    expect(camp.when).toContain("9:30");
    expect(camp.when).not.toContain("UTC");
    await host.admin.act("/attendance", "clear-filter", {});

    // An unknown zone is not stored; empty means UTC again.
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", defaultTimezone: "Mars/Olympus" });
    await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", defaultTimezone: "" });
    const other = await makeEvent({ title: "Second sans fuseau", capacity: 10, start: occ });
    await rsvp(other, { occurrenceStart: occ, displayName: "Zone None", email: "zone-none@example.test" });
    const utcRow = (await host.inspect.storage.list<AttendeeRecord>("attendees")).find((r) => r.data.email === "zone-none@example.test")!;
    expect(utcRow.data.timezone).toBeUndefined();
  });
});

describe("approval", () => {
  const enableApproval = (eventId: string, extra: Record<string, unknown> = {}) =>
    host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", {
      enabled: true,
      capacity: 2,
      maxPerRegistration: 2,
      allowWaitlist: false,
      requireApproval: true,
      approvalHours: 24,
      ...extra,
    });
  const formDef = async (eventId: string) => {
    const res = await host.actions.routes.request("rsvp/form", {
      method: "GET",
      url: `${SITE}/_emdash/api/plugins/eventual-attendance/rsvp/form?eventId=${eventId}`,
    } as any);
    const json = (await res.json()) as any;
    return json.success ? json.data : json;
  };
  const mailsTo = async (email: string) =>
    (await host.inspect.email()).filter((m) => JSON.stringify(m).includes(email));

  it("a request holds its seat as pending and gets a request email", async () => {
    const eventId = await makeEvent({ capacity: 2 });
    const saved = await enableApproval(eventId);
    expect(saved.toast?.type).toBe("success");

    expect(await formDef(eventId)).toMatchObject({ ok: true, open: true, requiresApproval: true });

    const r = await rsvp(eventId);
    expect(r.result).toMatchObject({ ok: true, status: "pending", approvalDueAt: expect.any(String), remaining: 1 });

    const row = await attendee(r.result.attendeeId);
    expect(row.status).toBe("pending");
    expect(row.approvalDueAt).toBe(r.result.approvalDueAt);
    expect(row.reminder).toBeUndefined();
    expect(await ledger(eventId)).toMatchObject({ taken: 1 });

    const mails = await mailsTo(r.email);
    expect(mails.some((m: any) => String(m.subject).includes("Request received"))).toBe(true);

    const overview = await host.admin.loadPage("/attendance");
    const stats = overview.blocks.find((b: any) => b.type === "stats") as any;
    expect(stats.items.find((i: any) => i.label === "To approve")?.value).toBeGreaterThanOrEqual(1);
  });

  it("approving confirms and sends the confirmation", async () => {
    const occ = "2027-06-15T10:00:00.000Z";
    const eventId = await makeEvent({ capacity: 3, start: occ, end: "2027-06-15T11:30:00.000Z" });
    await enableApproval(eventId, { capacity: 3 });

    const r = await rsvp(eventId, { occurrenceStart: occ });
    expect(r.result).toMatchObject({ ok: true, status: "pending" });

    const res = await host.admin.act("/attendance", "approve-attendee", { value: r.result.attendeeId });
    expect(res.toast?.type).toBe("success");

    const row = await attendee(r.result.attendeeId);
    expect(row.status).toBe("going");
    expect(row.reminder).toBe("due");
    expect(row.approvalDueAt).toBe("");

    const mails = await mailsTo(r.email);
    expect(mails.some((m: any) => String(m.subject).includes("RSVP confirmed"))).toBe(true);
  });

  it("declining releases the seat, emails, and offers it to the waitlist", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    await enableApproval(eventId, { capacity: 1, allowWaitlist: true });

    const a = await rsvp(eventId);
    const b = await rsvp(eventId);
    expect(a.result).toMatchObject({ ok: true, status: "pending" });
    expect(b.result).toMatchObject({ ok: true, status: "waitlist" });

    const res = await host.admin.act("/attendance", "decline-attendee", { value: a.result.attendeeId });
    expect(res.toast?.type).toBe("success");
    expect((await attendee(a.result.attendeeId)).status).toBe("cancelled");

    const aMails = await mailsTo(a.email);
    expect(aMails.some((m: any) => String(m.subject).includes("Request declined"))).toBe(true);

    await tickUntil(async () => (await entryFor(b.result.attendeeId)).status === "offered");
    expect((await entryFor(b.result.attendeeId)).status).toBe("offered");
    expect(await tokenFor(b.email, "claim")).toBeTruthy();
  });

  it("a request past its deadline lapses", async () => {
    const eventId = await makeEvent({ capacity: 2 });
    await enableApproval(eventId);
    const r = await rsvp(eventId);
    const row = await attendee(r.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, approvalDueAt: "2020-01-01T00:00:00.000Z" });

    await host.transport.invokeHook("cron", { name: "attendance-approvals" });

    expect((await attendee(row.id)).status).toBe("cancelled");
    expect((await ledger(eventId)).taken).toBe(0);
    const mails = await mailsTo(r.email);
    expect(mails.some((m: any) => String(m.text).includes("wasn't answered in time"))).toBe(true);
  });

  it("the organiser is told about a new request", async () => {
    await host.admin.submit("/attendance", "save-config", {
      eventCollection: "events",
      managePagePath: "/rsvp/manage",
      replyTo: "organiser@example.test",
    });
    try {
      const eventId = await makeEvent({ capacity: 2 });
      await enableApproval(eventId);
      const r = await rsvp(eventId);
      expect((await attendee(r.result.attendeeId)).organiserNotice).toBe("queued");

      await host.transport.invokeHook("cron", { name: "attendance-approvals" });

      expect((await attendee(r.result.attendeeId)).organiserNotice).toBe("sent");
      const sent = (await host.inspect.email()).filter(
        (m: any) => m.to === "organiser@example.test" && String(m.subject).includes("New request:") && JSON.stringify(m).includes(r.email)
      );
      expect(sent.length).toBeGreaterThanOrEqual(1);
    } finally {
      await host.admin.submit("/attendance", "save-config", {
        eventCollection: "events",
        managePagePath: "/rsvp/manage",
        replyTo: "",
      });
    }
  });

  it("reconcile counts pending requests as taken", async () => {
    const eventId = await makeEvent({ capacity: 5 });
    await enableApproval(eventId, { capacity: 5 });
    const r = await rsvp(eventId);

    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const curLedger = await ledger(eventId);
    await host.fixtures.plugin.kv(`ledger:${eventId}`, { ...curLedger, taken: 4, updatedAt: old });
    const row = await attendee(r.result.attendeeId);
    await host.fixtures.plugin.storage("attendees", row.id, { ...row, updatedAt: old });

    const maxTicks = (await host.inspect.kv.list()).length + 5;
    for (let n = 0; n < maxTicks && (await ledger(eventId)).taken !== 1; n++) {
      await host.transport.invokeHook("cron", { name: "ledger-reconcile" });
    }
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 0, waitlistCount: 0 });
  });

  it("a pending request can't be checked in, can be withdrawn by its cancel link, and blocks deleting the event", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    await enableApproval(eventId, { capacity: 3 });
    const r = await rsvp(eventId);

    const ci = await host.admin.act("/attendance", "checkin-attendee", { value: r.result.attendeeId });
    expect(ci.toast?.type).toBe("error");
    expect((await attendee(r.result.attendeeId)).status).toBe("pending");

    const checkDeleteBlocked = async () => {
      if (typeof (host.actions as any)?.content?.trash === "function") {
        const res = await (host.actions as any).content.trash("events", eventId);
        return res === false || res?.success === false || res?.error === "DELETE_BLOCKED";
      }
      // host.actions.content.trash is not exposed on this test host; invoking hook directly via transport
      return (await host.transport.invokeHook("content:beforeDelete", { id: eventId, collection: "events", permanent: false })) === false;
    };

    expect(await checkDeleteBlocked()).toBe(true);

    const tok = await tokenFor(r.email, "cancel");
    expect(await call("manage/lookup", { action: "cancel", token: tok })).toMatchObject({ ok: true, state: "pending" });
    expect(await call("cancel", { token: tok })).toMatchObject({ ok: true, status: "cancelled" });
    expect((await ledger(eventId)).taken).toBe(0);

    expect(await checkDeleteBlocked()).toBe(false);
  });

  it("a waitlist claim on an approval event becomes a request", async () => {
    const eventId = await makeEvent({ capacity: 1, allow_waitlist: true });
    await enableApproval(eventId, { capacity: 1, allowWaitlist: true });

    const a = await rsvp(eventId);
    const b = await rsvp(eventId);
    expect(a.result).toMatchObject({ ok: true, status: "pending" });
    expect(b.result).toMatchObject({ ok: true, status: "waitlist" });

    await call("cancel", { token: await tokenFor(a.email, "cancel") });
    await tickUntil(async () => (await entryFor(b.result.attendeeId)).status === "offered");

    const claimTok = await tokenFor(b.email, "claim");
    const claimed = await call("waitlist/claim", { token: claimTok });
    expect(claimed).toMatchObject({ ok: true, status: "pending", approvalDueAt: expect.any(String) });

    expect((await attendee(b.result.attendeeId)).status).toBe("pending");
    expect(await ledger(eventId)).toMatchObject({ taken: 1, held: 0 });
    expect((await mailsTo(b.email)).some((m: any) => String(m.subject).includes("Request received"))).toBe(true);
  });

  it("French panel shows the approval settings", async () => {
    const eventId = await makeEvent({ capacity: 3 });
    const panel = JSON.stringify(await host.admin.loadEditorPanel("event-attendance", "events", eventId, { locale: "fr" }));
    expect(panel).toContain("Valider chaque inscription");
    expect(panel).toContain("Délai pour décider, en heures (1–720)");
  });
});

describe("single events use the event's own start", () => {
  it("counts a booking without an occurrence as past once the event start has passed", async () => {
    const past = await makeEvent({ capacity: 5, start: "2020-01-02T10:00:00.000Z", timezone: "Europe/Zurich" });
    const booking = await rsvp(past);
    expect(booking.result).toMatchObject({ ok: true });
    expect((await attendee(booking.result.attendeeId)).startsAt).toBe("2020-01-02T10:00:00.000Z");

    const allowed = await host.transport.invokeHook("content:beforeDelete", { id: past, collection: "events", permanent: false });
    expect(allowed).toBeUndefined();
    await host.transport.invokeHook("cron", { name: "attendance-retention" });
    expect((await attendee(booking.result.attendeeId)).displayName).toBe("");

    const future = await makeEvent({ capacity: 5, start: "2099-01-02T10:00:00.000Z" });
    await rsvp(future);
    const blocked = await host.transport.invokeHook("content:beforeDelete", { id: future, collection: "events", permanent: false });
    expect(blocked).toBe(false);
  });
});

describe("round 10: organiser pages", () => {
  const texts = (res: any, type: string): string[] => res.blocks.filter((b: any) => b.type === type).map((b: any) => b.text);

  it("door list: checks in and undoes with one tap, finds a name, counts arrivals", async () => {
    const eventId = await makeEvent({ title: "Door test", capacity: 3, allow_waitlist: true });
    await rsvp(await makeEvent({ title: "Another door", capacity: 5 })); // two events: the page must ask which one
    const anna = await rsvp(eventId, { displayName: "Anna Door" });
    const ben = await rsvp(eventId, { displayName: "Ben Door", quantity: 2 });
    const queued = await rsvp(eventId, { displayName: "Wim Waiting" });

    const door = await host.admin.submit("/attendance/roster", "apply-filter", { pool: eventId });
    const rows = door.blocks.filter((b: any) => b.type === "section" && b.accessory);
    // Only people who can come in are listed; each row carries its own button (usable on a phone).
    expect(rows.map((r: any) => r.accessory.action_id)).toEqual(["checkin-attendee", "checkin-attendee"]);
    expect(JSON.stringify(rows)).toContain("Ben Door · 2 places");
    expect(JSON.stringify(door.blocks)).not.toContain("Wim Waiting");
    expect(texts(door, "header")).toContain("0 of 2 checked in");

    const inRes = await host.admin.act("/attendance/roster", "checkin-attendee", { value: anna.result.attendeeId });
    expect(texts(inRes, "header")).toContain("1 of 2 checked in");
    const annaRow = inRes.blocks.find((b: any) => b.type === "section" && String(b.text).includes("Anna Door")) as any;
    expect(annaRow.accessory.action_id).toBe("undo-checkin");
    expect(annaRow.text).toMatch(/✓ checked in \d\d:\d\d UTC/); // this event has no time zone

    const undone = await host.admin.act("/attendance/roster", "undo-checkin", { value: anna.result.attendeeId });
    expect(undone.toast?.type).toBe("success");
    expect(await attendee(anna.result.attendeeId)).toMatchObject({ status: "going", checkedInAt: "" });
    // Undo only applies to someone who is checked in.
    expect((await host.admin.act("/attendance/roster", "undo-checkin", { value: queued.result.attendeeId })).toast?.type).toBe("error");
    expect((await attendee(queued.result.attendeeId)).status).toBe("waitlist");

    const found = await host.admin.submit("/attendance/roster", "apply-filter", { pool: eventId, q: "ben" });
    const foundRows = found.blocks.filter((b: any) => b.type === "section" && b.accessory);
    expect(foundRows).toHaveLength(1);
    expect((foundRows[0] as any).accessory.value).toBe(ben.result.attendeeId);

    // Without a chosen event the page opens on the next dated one, says so, and saves nothing;
    // its files are of that event.
    await host.admin.act("/attendance/roster", "clear-filter", {});
    const opened = await host.admin.loadPage("/attendance/roster");
    expect(opened.blocks.some((b: any) => b.type === "empty" && b.title === "Choose an event")).toBe(false);
    const notice = texts(opened, "context").find((s) => s.startsWith("Showing the next event: "));
    expect(notice).toContain("To check people in for another one, choose it above.");
    expect(JSON.stringify(opened.blocks)).not.toContain("clear-filter");
    const csvButton = opened.blocks.flatMap((b: any) => b.elements ?? []).find((e: any) => e.action_id === "prepare-export-csv");
    // Single events have their date only in the content: it is read, so they count too.
    const [shownPool] = String(csvButton.value).split("\n");
    expect(shownPool).toBeTruthy();
    expect(notice).toMatch(/ · \S/);
    const saved = ((await host.inspect.kv.list()) as any[]).filter((e) => e.id.startsWith("state:admin-filter:"));
    expect(saved.map((e) => e.data)).toEqual([{}]);
    const prepared = await host.admin.act("/attendance/roster", "prepare-export-csv", { value: csvButton.value });
    expect(JSON.stringify(prepared.blocks)).toContain("roster/download?token=");

    // The same files are on the Registrations page, for the event chosen there.
    const regs = await host.admin.loadPage("/attendance");
    const regButtons = regs.blocks.flatMap((b: any) => b.elements ?? []).filter((e: any) => String(e.action_id).startsWith("prepare-export-"));
    expect(regButtons.map((e: any) => [e.action_id, e.value])).toEqual([["prepare-export-html", "\n"], ["prepare-export-csv", "\n"]]);
    expect(texts(regs, "context").join(" ")).toContain("cancelled ones included");
    const regFile = await host.admin.act("/attendance", "prepare-export-html", { value: "\n" });
    expect(JSON.stringify(regFile.blocks)).toContain("roster/download?token=");
    expect(texts(regFile, "header")).toContain("Upcoming events"); // the full page still renders
  });

  it("the dashboard widget lists the five newest registrations, with the way to Registrations", async () => {
    const eventId = await makeEvent({ title: "Widget test", capacity: 9 });
    for (const name of ["W One", "W Two", "W Three", "W Four", "W Five", "W Six"]) await rsvp(eventId, { displayName: name });
    // A cancelled registration is left out, as on the Registrations page.
    const gone = await rsvp(eventId, { displayName: "W Cancelled" });
    await host.fixtures.plugin.storage("attendees", gone.result.attendeeId, { ...(await attendee(gone.result.attendeeId)), status: "cancelled" });
    const widget = await host.admin.loadPage("widget:recent");
    const table = widget.blocks.find((b: any) => b.type === "table") as any;
    expect(table.rows.map((r: any) => r.name)).toEqual(["W Six", "W Five", "W Four", "W Three", "W Two"]);
    expect(table.rows[0]).toMatchObject({ event: "Widget test", status: "Confirmed" });
    expect(JSON.stringify(widget.blocks)).toContain('"path":"/attendance"');
  });

  it("registrations: search by name or email gives cards with buttons; View opens one event", async () => {
    const eventId = await makeEvent({ title: "Search test", capacity: 5 });
    const other = await makeEvent({ title: "Search other", capacity: 5 });
    const zoe = await rsvp(eventId, { displayName: "Zoe Findable" });
    await rsvp(eventId, { displayName: "Someone Else" });
    const elsewhere = await rsvp(other, { displayName: "Zoe Elsewhere" });

    const viewed = await host.admin.act("/attendance", "view-session", { value: `${eventId}\n` });
    const table = viewed.blocks.find((b: any) => b.page_action_id === "page-attendees") as any;
    expect(table.rows).toHaveLength(2);

    const byName = await host.admin.submit("/attendance", "apply-filter", { pool: eventId, q: "zoe" });
    expect(byName.blocks.some((b: any) => b.page_action_id === "page-attendees")).toBe(false);
    const cards = texts(byName, "section").filter((x) => x.includes("Zoe"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(`Zoe Findable · Confirmed · 1 place · Search test · ${zoe.email}`);
    const buttons = byName.blocks.filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements).map((e: any) => `${e.action_id}:${e.value ?? ""}`);
    expect(buttons).toContain(`checkin-attendee:${zoe.result.attendeeId}`);
    expect(buttons).toContain(`cancel-attendee:${zoe.result.attendeeId}`);

    // An email address is looked up directly, across events when none is selected.
    await host.admin.act("/attendance", "clear-filter", {});
    const byEmail = await host.admin.submit("/attendance", "apply-filter", { pool: "", q: elsewhere.email.toUpperCase() });
    expect(texts(byEmail, "section").filter((x) => x.includes("Zoe Elsewhere"))).toHaveLength(1);
    const nobody = await host.admin.submit("/attendance", "apply-filter", { pool: "", q: "nobody-by-this-name-xyz" });
    expect(JSON.stringify(nobody.blocks)).toContain("Nobody found");
  });

  it("requests to approve come first, with their own buttons and deadline", async () => {
    const eventId = await makeEvent({ title: "Approval first", capacity: 5 });
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", { enabled: true, requireApproval: true, approvalHours: 24 });
    const asked = await rsvp(eventId, { displayName: "Ask Approval" });
    expect(asked.result.status).toBe("pending");

    const page = await host.admin.loadPage("/attendance");
    const banner = page.blocks.findIndex((b: any) => b.type === "banner" && String(b.title).startsWith("Waiting for your decision"));
    const stats = page.blocks.findIndex((b: any) => b.type === "stats");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(stats);
    const top = page.blocks.slice(banner, stats);
    expect(JSON.stringify(top)).toContain("Ask Approval · decide by ");
    const ids = top.filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements).filter((e: any) => e.value === asked.result.attendeeId).map((e: any) => e.action_id);
    expect(ids).toEqual(["approve-attendee", "decline-attendee"]);
    await host.admin.act("/attendance", "decline-attendee", { value: asked.result.attendeeId });
  });

  it("settings live on their own page, and each form saves only its own fields", async () => {
    const overview = JSON.stringify(await host.admin.loadPage("/attendance"));
    expect(overview).not.toContain("save-config");
    expect(overview).not.toContain("eraseEmail");

    const settings = await host.admin.loadPage("/attendance/settings");
    const forms = settings.blocks.filter((b: any) => b.type === "form").map((f: any) => f.block_id);
    expect(forms).toEqual(["config", "personal-data"]);
    const setup = settings.blocks.find((b: any) => b.type === "accordion") as any;
    expect(setup.blocks.find((b: any) => b.type === "form").fields.map((f: any) => f.action_id)).toEqual(["eventCollection", "managePagePath", "turnstileSiteKey", "turnstileSecretKey"]);

    // The organiser's form must not wipe what the site-setup form holds, and the other way round.
    const saved = await host.admin.submit("/attendance/settings", "save-config", { replyTo: "club@example.test", reminderLeadHours: 12, retentionDays: 400, defaultLocale: "en" });
    expect(saved.toast).toMatchObject({ type: "success", message: "Settings saved." });
    const after = JSON.stringify(saved.blocks);
    expect(after).toContain('"initial_value":"events"');
    expect(after).toContain('"initial_value":"/rsvp/manage"');
    const again = JSON.stringify((await host.admin.submit("/attendance/settings", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage" })).blocks);
    expect(again).toContain('"initial_value":"club@example.test"');
    expect(again).toContain('"initial_value":400');
    await host.admin.submit("/attendance/settings", "save-config", { replyTo: "", reminderLeadHours: 24, retentionDays: 365 });
  });
});
