# Eventual RSVP – Registrations

Free registration for [Eventual RSVP](https://github.com/Vermeulen-Solutions/eventual-rsvp-core) events in EmDash CMS: places that never overbook, a fair waiting list that offers freed places by email, optional approval, reminders, and a door list to check people in.

**Website:** [eventual.rsvp/registrations](https://eventual.rsvp/registrations/), with the [documentation](https://eventual.rsvp/docs/#attendance), [install guide](https://eventual.rsvp/install/) and [support](https://eventual.rsvp/support/).

**Version 0.1.0.** Registrations, the waiting list, approval, reminders, Turnstile, door check-in and personal-data erasure work and are tested on EmDash's runtime test host, in the local browser test site on Node, and on a Cloudflare preview (its emails are not yet proven there).

## What it does

- **RSVPs per occurrence.** Attendees register for one date of a recurring series; each date has its own capacity.
- **No overselling.** Seats are reserved with revision-checked compare-and-set on the plugin's KV ledger, so two people can never get the last seat.
- **Fair waitlist.** When a session is full, visitors join a first-come, first-served queue. A freed seat is *held* for the person at the front and offered by email for 2 hours; nobody can register past the queue. Unclaimed offers move to the next person automatically.
- **Zero-login cancel and claim.** Email links open a page on your site where the attendee confirms. Only hashes of the tokens are stored, and the signing key never leaves the plugin's private storage.
- **Registration questions.** Add questions per event in the editor panel, such as T-shirt size, dietary needs or a rules checkbox. The form shows them, the server checks the answers, and they appear in the attendee list, roster and CSV.
- **No double bookings from retries.** A double-click or network retry returns the original registration instead of booking seats twice.
- **Shared room for translations.** All language versions of an event share one capacity, one queue and one set of settings.
- **Door tools.** Check-in from the admin attendee list, and single-use links for a CSV roster or a printable roster you open and print locally.
- **Self-healing counts.** A background job compares seat counts with attendee records every 10 minutes and corrects drift left by failed requests.

## Installation

```bash
# In your EmDash site
npm install @vermeulen.solutions/eventual-attendance
```

Add it to the EmDash integration in `astro.config.mjs`. Attendance is built to run **sandboxed**, in its own isolate with only the permissions it declares:

```js
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import eventualAttendance from "@vermeulen.solutions/eventual-attendance";

export default defineConfig({
  integrations: [
    emdash({
      // …database, storage, your other plugins
      sandboxed: [eventualAttendance],
      sandboxRunner: "@emdash-cms/cloudflare/sandbox", // on Cloudflare; see below
    }),
  ],
});
```

### Three ways to install

**1. From the EmDash registry** (admin → Plugins → Registry).

- **Run:** install Eventual RSVP – Registrations from the registry, and add the npm package to your site for the components: `npm install @vermeulen.solutions/eventual-attendance`.
- **Config:** the registry install is sandboxed; nothing else goes in `astro.config.mjs`. Import the components from the npm package.
- **Pages:** the self-service page (below) with `RsvpManage`, and `RsvpForm` on each event page.
- **Check it worked:** open **Attendance** in the admin. The **Site setup** section shows the `apiEndpoint` and `apiBase` paths for this install; pass them to `RsvpForm` and `RsvpManage`. Register once on a test event and confirm the message appears. *(Not yet tested by us on a registry install.)*

**2. From npm, sandboxed.**

- **Run:** `npm install @vermeulen.solutions/eventual-attendance`, then add it to `astro.config.mjs` as in the example above.
- **Config:** `sandboxed: [eventualAttendance]` plus a `sandboxRunner` (`@emdash-cms/cloudflare/sandbox` on Cloudflare, `@emdash-cms/sandbox-workerd/sandbox` on Node), as in the example above.
- **Pages:** the self-service page with `RsvpManage`, and `RsvpForm` on the event page.
- **Check it worked:** open **Attendance** in the admin; it must name the event collection it reads. Register once on a published test event.

**3. From npm, native.**

- **Run:** `npm install @vermeulen.solutions/eventual-attendance`.
- **Config:** `plugins: [eventualAttendance]`. This runs in the site's own process, without the sandbox's limits or isolation; only on hosts you trust.
- **Pages:** the self-service page with `RsvpManage`, and `RsvpForm` on the event page.
- **Check it worked:** as for the sandboxed npm install. Tested on Node in the local test site (`EVENTUAL_PLUGIN_MODE=native`, `npm run test:integration:suite` and `npm run test:e2e`).

### Permissions and why

| Permission | Why |
| :--- | :--- |
| `content:read` | Read the event (title, dates, published or not) a booking is for |
| `email:send` | Confirmations, waitlist offers, approval notices, reminders |
| `network:request` to `challenges.cloudflare.com` | Check Cloudflare Turnstile tokens, only when you turn Turnstile on |
| `network:request` to `cdn.jsdelivr.net` | Download the admin and email translations (language packs from `@vermeulen.solutions/eventual-locales`); each file is checked against a hash built into the plugin |

#### Public routes

The plugin declares the following public routes (listed in `trust-contract.json`):

| Route | Method | Purpose |
| :--- | :--- | :--- |
| `rsvp` | POST | Submit an RSVP or waitlist join request (idempotent command) |
| `rsvp/form` | GET | Event capacity, Turnstile status, and registration questions for the booking form |
| `cancel` | POST | Cancel a booking or waitlist entry via a signed HMAC token |
| `manage/lookup` | POST | Read booking details for the self-serve manage page using a signed token before confirmation |
| `waitlist/claim` | POST | Claim a held seat from a waitlist offer email via a signed HMAC token |
| `calendar` | GET | Download an `.ics` calendar file for a booking |
| `roster/download` | GET | Single-use download link for event rosters (CSV or HTML doorlist) generated by the admin panel |

**Installed from the registry?** The plugin then has an ID like `r_…` instead of its name. The plugin's admin page shows the exact paths; pass them to the site components (`apiEndpoint` / `apiBase`).

**Emails** (confirmations, waitlist offers, approval notices, reminders) go through EmDash's email system, so the site needs an email provider plugin. Without one, bookings still work but nobody is emailed, and waitlist offers can't be claimed.

### Running sandboxed on Cloudflare

Sandboxed plugins on Cloudflare run in a Worker Loader isolate:

1. **Workers Paid plan.** The Worker Loader binding isn't available on the free plan.
2. **The binding**, in `wrangler.jsonc`:
   ```jsonc
   "worker_loaders": [{ "binding": "LOADER" }]
   ```
3. **`sandboxRunner: "@emdash-cms/cloudflare/sandbox"`** in the EmDash integration, as above.
4. **Re-export the bridge** from your Worker entry (the file `main` points to in `wrangler.jsonc`), so the sandbox can reach EmDash:
   ```ts
   export { PluginBridge } from "@emdash-cms/cloudflare/worker";
   ```

The background tasks need the site's cron trigger (EmDash's scheduled handler). Attendance schedules its own tasks the first time the booking form is loaded.

## Site setup

### 0. Nothing to configure for keys

Attendance creates the key that signs cancellation and waitlist links itself, the first time it needs one, and keeps it in its own private storage. You don't need `EMDASH_ENCRYPTION_KEY` for Attendance. Treat database backups as sensitive: someone holding a copy could create working cancel links for existing bookings.

### Spam protection (optional): Cloudflare Turnstile

Every form has a hidden honeypot and a timing check. When Turnstile is off, Attendance also refuses more than **10 bookings from one IP address in 10 minutes** (keeping only a 32-hex keyed hash `ipHash`, never the raw IP). Off Cloudflare, EmDash knows the visitor's IP only when its trusted proxy headers are configured; without an IP there is no limit. When Turnstile is on, Cloudflare's challenge does that job and the IP check is skipped.

For stronger protection, turn on Cloudflare Turnstile:

1. In the Cloudflare dashboard, open **Turnstile**, add a widget for your site's domain and copy its **site key** and **secret key**.
2. On the **Registration settings** page, under **Site setup**, paste both keys and save.

The booking form then shows Cloudflare's check, and bookings without a valid token are refused. If Cloudflare can't be reached, bookings go through rather than closing every form. No `EMDASH_ENCRYPTION_KEY` is needed. To try it locally, use Cloudflare's test keys: site key `1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA` always pass.

If your site sends a Content Security Policy, allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`.

### Several collections

**Content collections that hold events**, under **Site setup** on the Registration settings page, takes a comma-separated list, for example `camps, school_series`; the first is the default. Pass `collection="school_series"` to `RsvpForm` for events outside the default collection. Only listed collections are ever read.

### Styling

The components' CSS sits in the `eventual` cascade layer. Unlayered site CSS overrides it; if your site uses layers (Tailwind 4 does), list `eventual` before your components layer, for example `@layer theme, base, eventual, components, utilities;`. The reliable way to theme them is with variables, which work whatever your layers: set the `--eventual-*` variables on the component or any wrapper. Colours: `--eventual-primary`, `--eventual-primary-hover`, `--eventual-on-primary`, `--eventual-bg`, `--eventual-field-bg` (inputs, dropdowns and the booking details on the manage page; default white), `--eventual-border`, `--eventual-text`, `--eventual-text-muted`, `--eventual-danger`, `--eventual-success(-bg)`, `--eventual-warning(-bg)`, `--eventual-error(-bg)`. Shapes and focus: `--eventual-radius` (cards), `--eventual-card-max-width` (the form card; default 440px, `none` fills the column), `--eventual-control-radius` (fields, messages), `--eventual-button-radius`, `--eventual-focus`, `--eventual-focus-ring`. Set the text and field colours together for a dark theme: the components set a field's text and background as a pair, so light text needs `--eventual-field-bg` too.

### Availability

When the form loads it fires a bubbling `eventual:availability` event with `{ full, seatsLeft, allowWaitlist }`, so a page can mark sessions as full in a list. A full event without a waitlist shows its "full" message and disables the form.

### Languages

Attendance speaks English (built in), French, German, Dutch, Spanish, Italian, Portuguese (Portugal and Brazil), Polish, Czech, Swedish, Danish, Norwegian Bokmål, Finnish, Japanese, Simplified Chinese, Korean, Turkish, Ukrainian, Arabic and Hebrew. Arabic and Hebrew are laid out right to left.

`RsvpForm` and `RsvpManage` take a `locale` such as `"fr"`, `"de"` or `"pt-BR"` (default `"en"`); an unknown language falls back to the closest one, then English. The form sends its language with the booking, and every email for that booking (confirmation, waitlist, offer, reminder) is written in it. Set the **Language of emails when the form doesn't say** setting on the Registration settings page for bookings that don't carry one. The components' texts come from the `@vermeulen.solutions/eventual-locales` npm package, installed with Attendance; each language is its own chunk.

The admin pages, the editor panel and the roster files follow EmDash's admin language. The admin and email texts are not in the plugin bundle: English is built in, and the other languages are language packs the plugin downloads from `cdn.jsdelivr.net` (the public npm CDN) and keeps in its storage. A background task fetches them, the site's own language first, within about five minutes of installing or updating; until a language has arrived, its emails and admin pages are in English. Each pack is checked against a hash built into this release. The plugin's sidebar entries ("Registrations", "Door list", "Registration settings") and the editor panel's title ("Registrations") come from the English plugin manifest and stay English even when the admin is French; the pages themselves are translated.

### 1. Event collection and fields

Attendance reads events from the collection you connected in **Event settings** (Eventual RSVP – Core) (default `events`). If you use another name, set **Content collections that hold events** under **Site setup** on the Registration settings page.

Add these optional fields to that collection, using the same reviewed, additive schema workflow as Eventual RSVP's [collection setup](https://github.com/Vermeulen-Solutions/eventual-rsvp-core/blob/main/docs/collection-setup.md):

| Field slug | Type | Meaning |
| :--- | :--- | :--- |
| `inventory_mode` | select: `rsvp`, `tickets` | `rsvp` opens RSVPs for the event; `tickets` hands it to Eventual RSVP – Tickets. Empty means RSVP-managed but closed until enabled |
| `capacity` | integer | Seats per occurrence; `0` or empty = unlimited |
| `allow_waitlist` | boolean | Queue visitors once the session is full |

The `eventual-capacity` exporter writes these fields for you. It merges them into the schema file Core's exporter produces (new sites), or prints just the three fields to review against an existing schema. It never touches a database or overwrites a file:

```bash
node node_modules/@vermeulen.solutions/eventual-capacity/scripts/export-capacity-fields.mjs --merge eventual-schema.json --output eventual-schema-with-capacity.json
```

The fields are optional. **Capacity and the waitlist switch have one home:** when the event collection has these fields, they are edited in the event form and the **Registrations** panel of the event editor only reports them; a collection without them gets both settings in the panel instead. (A value saved in the panel by a script or an older version still wins until the panel is saved again; the panel says so.) **Registration is closed by default.** An event accepts registrations only when it is published *and* either its `inventory_mode` is `rsvp` or **Open for registration** is on in the panel. Turning that switch off closes registration without touching existing bookings.

### 2. Registration form

```astro
---
import RsvpForm from "@vermeulen.solutions/eventual-attendance/astro/RsvpForm.astro";
---

<RsvpForm
  eventId={event.id}
  occurrenceStart="2026-11-15T10:00:00Z"
  maxQuantity={4}
  title="Reserve your spot"
/>
```

The confirmation and waitlist messages mention an email only when the server actually sent or queued one (`email: "sent" | "queued"`); on a site without an email provider (`"none"`), they confirm the reservation or waitlist position without promising an email.

Every success (going, waitlist or pending approval) also shows **"Manage or cancel this registration"** / **"Gérer ou annuler cette inscription"**, linking to the same manage page the email carries (`manageUrl` in the answer, with the token in the fragment). The visitor can cancel straight away even when no email arrives; nothing extra is called to build the link. A replayed submission does not repeat it.

Other props: `apiEndpoint` (default `/_emdash/api/plugins/eventual-attendance/rsvp`; use the path the admin page shows on a registry install), `formEndpoint` (default `${apiEndpoint}/form`), `allowWaitlist` (default `true`; the server's setting still decides), `nameLabel` and `emailLabel` (replace "Full name" and "Email address"), and `locale` (`en` or `fr`). `RsvpManage` takes `apiBase` (default `/_emdash/api/plugins/eventual-attendance`) and `locale`.

### Self-service page (required)

Cancellation and waitlist-claim emails link to a page on your site. Create it at `/rsvp/manage`, or at the path set under **Site setup** on the Registration settings page:

```astro
---
// src/pages/rsvp/manage.astro
import RsvpManage from "@vermeulen.solutions/eventual-attendance/astro/RsvpManage.astro";
---

<RsvpManage />
```

The token travels in the link's `#fragment`, so it never reaches your server logs. Nothing changes until the visitor presses the button, so email link scanners can't cancel bookings.

### Approval (optional per event)

Turn on **Approve each registration yourself** in the event editor's **Registrations** panel to review bookings before confirming them. Waiting requests are the first thing on the Registrations page, each with its own Approve and Decline buttons and the time by which to decide:

- Visitors submit a **request** instead of an immediate RSVP (`Send request` / `Envoyer la demande` on `RsvpForm`), holding their seats as `Awaiting approval` (`pending`) so the session still cannot oversell or accept new people past them into a waitlist.
- Each request gets a deadline (`Decide within`, 1–720 hours, default 48, capped at the session start when known).
- **Organiser notification:** when a reply-to address is configured on the event or Attendance settings page, the `attendance-approvals` cron task (every 5 minutes) emails the organiser a notice (`New request: …`) in the site's default email language.
- On the **Attendance** overview page, click **Approve** (moves to `going`, enables reminders, and emails the calendar confirmation) or **Decline** (cancels, releases seats, offers them to the waitlist, and notifies the visitor). Waitlist claims on approval events also start as `pending` requests.
- Unanswered requests past their deadline are declined automatically every 5 minutes by `attendance-approvals`, releasing their seats and notifying the visitor.

### Deleting events

An event with upcoming registrations can't be moved to the trash. Cancel them first, or unpublish the event to stop new bookings.

## Personal data

Attendee names, email addresses and answers are personal data. Under privacy frameworks like the Swiss FADP and EU GDPR, organisers are expected to retain personal details only as long as necessary and erase them on request.

- **Automated retention:** The `attendance-retention` task runs hourly (at minute 17) and erases attendee details and waitlist entries whose event passed more than `retentionDays` ago (configurable on the Registration settings page, default 365 days, 30–3650). Bookings for an event without a date are kept while they're live; the period starts again each time the sweep finds one. Erasing clears names, emails and question answers, but preserves seat counts and statuses for historical attendance figures.
- **Erasure on request:** On the Registration settings page, use **Delete someone's personal data** to look up all registrations and waitlist entries for an email address. One click erases personal details across past and cancelled records. Active/upcoming registrations are protected from erasure until cancelled. Erased registrations stay in the lists as "Erased" (`—` for name and email, no actions) so the seat counts add up.
- **Starting point, not legal advice:** Retention periods and privacy requirements vary by jurisdiction, event category, and organisation. Review your own privacy policy and legal requirements.

## Background tasks and throughput

Six scheduled tasks run automatically. Opening any of the plugin's admin pages re-creates them if an update left them missing.

| Task | Schedule | Work per run |
| :--- | :--- | :--- |
| `waitlist-maintenance` | every minute | expires up to 2 lapsed offers and sends about 1 new offer |
| `ledger-reconcile` | every 10 minutes | checks one seat ledger against its records |
| `attendance-reminders` | every minute | emails up to 3 confirmed attendees whose date is within the reminder lead time (default 24 hours, set on the admin page; 0 turns reminders off) |
| `attendance-mail` | every minute | sends confirmation emails for bookings whose inline send was skipped due to call budget |
| `attendance-approvals` | every 5 minutes | declines unanswered approval requests past their deadline (up to 2) and sends queued organiser notices |
| `attendance-retention` | hourly (17 * * * *) | erases personal details (names, email addresses, answers) for past bookings after the retention period |

Sandboxed plugins are limited to 10 host calls per invocation by default, so waitlist promotion runs at about **one offer per minute** and reminders at about **180 per hour** across the site. That suits small and medium events; for a large event, reminders go out over the first hour of the lead window. An operator can raise the sandbox `subrequests` limit for more headroom, but the plugin does not require it. Waitlist maintenance and the reconcile check can also be run from the admin page.

## Large events

These are the limits of one background task or download, given the sandbox's 10 host calls. Past a limit the plugin skips the work or truncates the file rather than failing.

| What | Limit | What happens past it | What to do |
| :--- | :--- | :--- | :--- |
| Reconcile one occurrence | ≈ 500 attendee + waitlist records | The occurrence is skipped (`TOO_LARGE`) and tried again on a later tick; its seat count is not corrected automatically | Split the event by date, so each occurrence has its own pool; each is reconciled on its own |
| Roster download | 700 rows | The file is truncated with a note at the top | Filter by event and date and download each date separately |
| Waitlist offers | About 1 per minute per site | The queue drains over the following minutes; the maintenance task round-robins between events | None needed, but a large queue takes time |
| Reminder emails | 3 per minute (≈ 180/hour) | Reminders spread over the hour before the lead time | Set the reminder lead time earlier |
| Queued confirmation emails | 3 per minute | Confirmations wait for the next minute | None needed |

## Troubleshooting

- **Nobody gets an email:** EmDash needs an email provider plugin. Without one, a booking still works; the page says `email: "none"` and shows the reference/manage link instead. With a provider, check the site's from-address and the spam folder.
- **Reminders or waitlist offers never arrive:** the background tasks must be registered. Open the Registrations page once (it schedules them); the tasks run every minute and every hour, and **Site setup** on the Registration settings page has buttons to run them now.
- **A link answers "Route not found":** the plugin is installed under a different ID (registry installs get an ID like `r_…`). Use the `apiEndpoint`/`apiBase` printed under **Site setup** on the Registration settings page, not the folder name.
- **The booking form shows Cloudflare's check but nobody can book:** the Turnstile secret or the site key is wrong, or the domain is not in the widget's hostnames. **Site setup** on the Registration settings page says whether Turnstile is on; with Cloudflare's test keys use `1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`.
- **A public route answers `TRY_AGAIN`:** an unexpected host or database error was caught (it is logged, never shown). Check the EmDash log; often the event collection is not set up yet on a new site.
- **A buyer cannot find their booking:** the confirmation shows the order reference and, when built, the manage link; otherwise use the link in the confirmation email. A site without an email provider still shows both on the page.

## Architecture & specifications

- [Registrations specification](docs/SPECIFICATION.md): ledger invariants, waitlist states, tokens, routes and their call budgets.
- [Documentation and install guide](https://eventual.rsvp/docs/#attendance) on eventual.rsvp.

## License

MIT © 2026 Jaap Vermeulen / Vermeulen Solutions
