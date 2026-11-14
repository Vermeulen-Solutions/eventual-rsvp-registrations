/**
 * Call budget, measured (suite P1, P2). Every public route, cron task and admin page of Attendance
 * runs through the eventual-capacity harness, which counts the bridge calls each sandbox
 * invocation really makes (log lines included) and fails above 10. The test host doesn't enforce
 * the limit, so without this the counts in docs/SPECIFICATION.md §8 were reviewed by hand only.
 *
 * Cold paths matter most: `host.restart()` gives the plugin a fresh isolate, so the config and
 * signing key are read again (2 calls) instead of coming from the per-isolate cache.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { expectWithinBudget, withBudget, type BudgetedHost, type BudgetResult } from "@vermeulen.solutions/eventual-capacity/testing";

const SITE = "https://example.test";
const API = `${SITE}/_emdash/api/plugins/eventual-attendance`;
const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
let host: PluginRuntimeTestHost;
let budget: BudgetedHost;
let seq = 0;
const counts: Record<string, number> = {};

beforeAll(async () => {
  host = await createPluginRuntimeTestHost({ site: { url: SITE } });
  budget = withBudget(host);
  await host.fixtures.collection({
    slug: "events",
    label: "Events",
    fields: [
      { slug: "title", label: "Title", type: "string" },
      { slug: "capacity", label: "Capacity", type: "integer" },
      { slug: "allow_waitlist", label: "Allow waitlist", type: "boolean" },
      { slug: "inventory_mode", label: "Inventory mode", type: "string" },
      { slug: "start", label: "Start", type: "datetime" },
      { slug: "end", label: "End", type: "datetime" },
    ],
  } as any);
});

afterAll(async () => {
  // eslint-disable-next-line no-console
  console.info("Bridge calls per invocation (max):", counts);
  await host?.dispose();
});

/** Measures fn, asserts every invocation stayed within 10 calls, records the highest count. */
async function measured<T>(label: string, fn: () => Promise<T>): Promise<BudgetResult<T>> {
  const result = await budget.measure(label, fn);
  expect(result.invocations.length, `${label}: no sandbox invocation was measured`).toBeGreaterThan(0);
  expectWithinBudget(result);
  counts[label] = Math.max(counts[label] ?? 0, ...result.invocations.map((u) => u.calls.length));
  return result;
}

const unwrap = async (res: Response) => {
  const json = (await res.json()) as any;
  return json.success ? json.data : { ok: false, error: json.error?.code };
};
const post = (route: string, body: unknown) => host.actions.routes.request(route, { method: "POST", body } as any).then(unwrap);
const get = (route: string, query: string) => host.actions.routes.request(route, { method: "GET", url: `${API}/${route}?${query}` } as any);

async function tokenFor(email: string, action: "cancel" | "claim"): Promise<string> {
  for (const mail of (await host.inspect.email()).reverse()) {
    const text = JSON.stringify(mail);
    const match = text.includes(email) && text.match(new RegExp(`#action=${action}&token=([0-9a-f]{64})`));
    if (match) return match[1];
  }
  throw new Error(`No ${action} token for ${email}`);
}

const event = async (data: Record<string, unknown>) =>
  (await host.fixtures.content("events", { data: { title: `Budget ${++seq}`, inventory_mode: "rsvp", ...data }, status: "published" } as any)).id as string;
const person = () => ({ email: `b${++seq}@example.test`, displayName: `Budget ${seq}` });
const command = () => `${(++seq).toString(16).padStart(8, "0")}${"0".repeat(24)}`;
const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("call budget: every path stays within 10 bridge calls", () => {
  it("a visitor's journey: form, book, retry, waitlist, look up, cancel, offer, claim, calendar", async () => {
    const eventId = await event({ capacity: 1, allow_waitlist: true, start: soon(48), end: soon(49) });
    await host.restart(); // cold isolate for the first calls

    const firstForm = await measured("rsvp/form (cold, schedules once)", () => get("rsvp/form", `eventId=${eventId}`));
    const firstData = await unwrap(firstForm.value);
    expect(firstData.ok).toBe(true);
    expect(typeof firstData.seatsLeft).toBe("number");

    for (let i = 0; i < 4; i++) {
      const stored = await host.inspect.kv.get("state:schedules");
      if (typeof stored === "string") break;
      await host.restart();
      const nextForm = await get("rsvp/form", `eventId=${eventId}`);
      const nextData = await unwrap(nextForm);
      expect(nextData.ok).toBe(true);
      expect(typeof nextData.seatsLeft).toBe("number");
    }
    expect(typeof (await host.inspect.kv.get("state:schedules"))).toBe("string");
    const a = person();
    const aCommand = command();
    const booked = await measured("rsvp first submission (cold)", () =>
      post("rsvp", { eventId, ...a, commandId: aCommand, firstAttempt: true }));
    expect(booked.value).toMatchObject({ ok: true, status: "going" });
    await measured("rsvp retry (replay)", () => post("rsvp", { eventId, ...a, commandId: aCommand }));

    const b = person();
    await host.restart();
    const waiting = await measured("rsvp to the waitlist (cold)", () => post("rsvp", { eventId, ...b, commandId: command(), firstAttempt: true }));
    expect(waiting.value).toMatchObject({ ok: true, status: "waitlist" });

    const aCancel = await tokenFor(a.email, "cancel");
    await measured("manage/lookup", () => post("manage/lookup", { action: "cancel", token: aCancel }));
    await host.restart();
    const cancelled = await measured("cancel with promotion (cold)", () => post("cancel", { token: aCancel }));
    expect(cancelled.value).toMatchObject({ ok: true });
    // Cold: the inline promotion can't afford the offer email, so it leaves the offer to cron.
    expect(cancelled.calls.filter((c) => c.kind === "storage" && c.method === "updateIf" && c.collection === "waitlist_entries")).toHaveLength(0);
    await measured("cron waitlist-maintenance (makes the offer)", () => host.transport.invokeHook("cron", { name: "waitlist-maintenance" }));

    const bClaim = await tokenFor(b.email, "claim");
    await measured("manage/lookup (claim)", () => post("manage/lookup", { action: "claim", token: bClaim }));
    await host.restart();
    const claimed = await measured("waitlist/claim (cold)", () => post("waitlist/claim", { token: bClaim }));
    expect(claimed.value).toMatchObject({ ok: true, status: "going" });

    await measured("calendar", () => get("calendar", `eventId=${eventId}`));
  });

  it("with Turnstile on: a cold first submission that joins the waitlist (the longest booking path)", async () => {
    await host.admin.submit("/attendance", "save-config", {
      eventCollection: "events", managePagePath: "/rsvp/manage",
      turnstileSiteKey: "1x00000000000000000000AA", turnstileSecretKey: "1x0000000000000000000000000000000AA",
    });
    try {
      const eventId = await event({ capacity: 1, allow_waitlist: true });
      await host.http.respond(VERIFY, new Response(JSON.stringify({ success: true }), { status: 200 }));
      await post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });
      await host.http.respond(VERIFY, new Response(JSON.stringify({ success: true }), { status: 200 }));
      await host.restart();
      const result = await measured("rsvp + Turnstile to the waitlist (cold)", () =>
        post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }));
      expect(result.value).toMatchObject({ ok: true, status: "waitlist" });
      expect(result.calls.filter((c) => c.kind === "email")).toHaveLength(1); // the confirmation still fits

      await host.http.respond(VERIFY, new Response(JSON.stringify({ success: true }), { status: 200 }));
      await host.restart();
      const retryPerson = person();
      const retryResult = await measured("rsvp + Turnstile retry, not landed (cold)", () =>
        post("rsvp", { eventId, ...retryPerson, commandId: command(), turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }));
      expect(retryResult.value).toMatchObject({ ok: true, status: "waitlist", email: "queued" });
      const attendeeId = (retryResult.value as any).attendeeId;

      await measured("cron attendance-mail", () =>
        host.transport.invokeHook("cron", { name: "attendance-mail" }));

      const emails = (await host.inspect.email()).filter((m: any) => JSON.stringify(m).includes(retryPerson.email));
      expect(emails.some((m: any) => JSON.stringify(m).includes("Waitlist"))).toBe(true);
      expect(await host.inspect.storage.get("attendees", attendeeId)).toMatchObject({ mail: "sent" });
    } finally {
      await host.admin.submit("/attendance", "save-config", { eventCollection: "events", managePagePath: "/rsvp/manage", turnstileSiteKey: "", turnstileSecretKey: "" });
    }
  });

  it("cron tasks and admin pages", async () => {
    const eventId = await event({ capacity: 5, start: soon(3), end: soon(4) });
    const p = person();
    const booked = await post("rsvp", { eventId, ...p, commandId: command(), firstAttempt: true });
    // Overwrite retainFrom to past date for retention measurement
    const attId = booked.attendeeId;
    const attRow = await host.inspect.storage.get("attendees", attId);
    await host.fixtures.plugin.storage("attendees", attId, { ...(attRow as any), status: "cancelled", occurrenceStart: "2020-01-01T00:00:00.000Z", retainFrom: "2020-01-01T00:00:00.000Z" });

    await host.restart();
    await measured("cron attendance-reminders (cold)", () => host.transport.invokeHook("cron", { name: "attendance-reminders" }));
    await measured("cron ledger-reconcile", () => host.transport.invokeHook("cron", { name: "ledger-reconcile" }));
    await measured("cron attendance-retention", () => host.transport.invokeHook("cron", { name: "attendance-retention" }));
    await host.restart();
    await measured("admin overview (cold)", () => host.admin.loadPage("/attendance"));
    await measured("admin roster", () => host.admin.loadPage("/attendance/roster"));
    await measured("event panel", () => host.admin.loadEditorPanel("event-attendance", "events", eventId));
    const prepared = await measured("roster: prepare CSV link", () => host.admin.act("/attendance/roster", "prepare-export-csv"));
    const url = JSON.stringify(prepared.value).match(/https:\/\/example\.test[^"]*roster\/download\?token=[0-9a-f]{64}/)?.[0];
    await measured("roster/download", () => host.actions.routes.request("roster/download", { method: "GET", url } as any));
    await measured("admin: run waitlist maintenance", () => host.admin.act("/attendance", "run-maintenance"));
    await measured("admin: check next ledger", () => host.admin.act("/attendance", "run-reconcile"));
    await measured("admin: find personal data", () => host.admin.submit("/attendance", "find-personal-data", { eraseEmail: p.email }));
    await measured("admin: erase personal data", () => host.admin.act("/attendance", "erase-personal-data", { value: p.email }));
  });

  it("per-IP rate limit (cold submission with IP and 11th refusal)", async () => {
    const eventId = await event({ capacity: 50 });
    const postIp = (ip: string) =>
      host.transport.invokeRoute("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true }, {
        method: "POST",
        meta: { ip, userAgent: null, referer: null, geo: null },
      }) as Promise<any>;

    await host.restart();
    const first = await measured("rsvp with IP (cold)", () => postIp("198.51.100.1"));
    expect(first.value).toMatchObject({ ok: true, status: "going" });

    for (let i = 1; i < 10; i++) {
      const ok = await postIp("198.51.100.1");
      expect(ok).toMatchObject({ ok: true, status: "going" });
    }
    const refused = await measured("rsvp per-IP refused (11th)", () => postIp("198.51.100.1"));
    expect(refused.value).toMatchObject({ ok: false, error: "RATE_LIMITED" });
  });

  it("approval workflow: cold request, approve, decline, and approval cron", async () => {
    const eventId = await event({ capacity: 10, start: soon(48), end: soon(49) });
    await host.admin.submitEditorPanel("event-attendance", "events", eventId, "save-attendance-settings", {
      enabled: true,
      capacity: 10,
      maxPerRegistration: 4,
      allowWaitlist: false,
      requireApproval: true,
      approvalHours: 24,
      replyTo: "org-budget@example.test",
    });

    await host.restart();
    const p1 = person();
    const req1 = await measured("rsvp pending (cold)", () =>
      post("rsvp", { eventId, ...p1, commandId: command(), firstAttempt: true })
    );
    expect(req1.value).toMatchObject({ ok: true, status: "pending" });

    const approved = await measured("approve-attendee", () =>
      host.admin.act("/attendance", "approve-attendee", { value: req1.value.attendeeId })
    );
    expect(approved.value.toast?.type).toBe("success");
    expect(await host.inspect.storage.get("attendees", req1.value.attendeeId)).toMatchObject({ status: "going" });

    const req2 = await post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true });
    const req3 = await post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true });
    const declinedWarm = await measured("decline-attendee (warm)", () =>
      host.admin.act("/attendance", "decline-attendee", { value: req2.attendeeId })
    );
    expect(declinedWarm.value.toast?.type).toBe("success");

    await host.restart();
    const declinedCold = await measured("decline-attendee (cold)", () =>
      host.admin.act("/attendance", "decline-attendee", { value: req3.attendeeId })
    );
    expect(declinedCold.value.toast?.type).toBe("success");

    // 1 lapsed request + 1 queued organiser notice together in one cold cron tick
    const req4 = await post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true });
    const req5 = await post("rsvp", { eventId, ...person(), commandId: command(), firstAttempt: true });
    const row4 = (await host.inspect.storage.get("attendees", req4.attendeeId)) as any;
    await host.fixtures.plugin.storage("attendees", req4.attendeeId, { ...row4, approvalDueAt: "2020-01-01T00:00:00.000Z" });

    await host.restart();
    await measured("cron attendance-approvals (cold)", () =>
      host.transport.invokeHook("cron", { name: "attendance-approvals" })
    );
    expect(await host.inspect.storage.get("attendees", req4.attendeeId)).toMatchObject({ status: "cancelled" });
    expect(await host.inspect.storage.get("attendees", req5.attendeeId)).toMatchObject({ organiserNotice: "sent" });
  });
});
