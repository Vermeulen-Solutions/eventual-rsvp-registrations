# Changelog

## 0.1.1 (2026-11-14)

### Changed

- Registry page: screenshots, installation and changelog tabs, and the source link to the public repository (github.com/Vermeulen-Solutions/eventual-rsvp-registrations). No code or permission changes.

## 0.1.0 (2026-11-14)

### Added

- Free registrations for single and recurring events, with per-event capacity. Seat counts use a compare-and-set ledger, so a place is never sold twice.
- **Registrations page:** requests waiting for a decision first, totals, upcoming events with places taken and their dates (single events too, in the site's default time zone when the event has none), busiest weekday and start slots, name or email search, and the registration list with actions. Choosing an event narrows only the list, with a notice and a way back; cancelled registrations are hidden until shown with a button. Events sold through Tickets are listed with a link to Tickets → Orders.
- **Door list page:** check in and undo, an arrivals count, name search, and printable HTML and CSV files. The files follow the event and date shown on the page and name the event. With no event chosen, it opens on today's or the next dated event and says so. The same files can be made from the Registrations page.
- **Dashboard widget "Recent registrations":** the five newest registrations with their event, date and status, and a link to Registrations.
- **Registration settings page:** the organiser's settings and personal-data deletion; the site builder's settings are folded under "Site setup".
- Registration questions as rows in the event panel: one small form per question (question of up to 400 characters, enough for consent wording; kind of answer in words; choices only for "Choice from a list"; must be answered), with save, remove and move up. A question keeps its id when it is renamed.
- Optional approval for each registration, with a decision window of 1–720 hours, approve and decline buttons, request and decision emails, and a background task that lapses unanswered requests.
- A first-in, first-out waiting list. Freed places are offered to the next person for 2 hours, claimed atomically, with a background sweep and round-robin promotion across events.
- Email reminders with a configurable lead time, sent at most once per confirmed attendee.
- A default time zone setting for events that have none (a collection without a `timezone` field, such as camps with only a start date-time): their times show in it instead of UTC. Empty keeps UTC. On the Registration settings page.
- Opt-in Cloudflare Turnstile on the booking form. When Turnstile is off and the visitor's IP is known, each keyed `ipHash` is limited to 10 bookings in 10 minutes.
- Personal-data retention (30–3650 days, default 365) with an hourly sweep, and erasure on request from the admin with live-registration protection.
- Delete guard: an event with upcoming or undated live registrations cannot be moved to the trash.
- Confirmation, waiting-list, offer and claim emails; an `.ics` calendar file per occurrence; an organiser reply-to address (site default and per-event override); and queued confirmation mail when the call budget leaves no room to send it inline.
- 21 languages: English, French, German, Dutch, Spanish, Italian, Portuguese (Portugal and Brazil), Polish, Czech, Swedish, Danish, Norwegian Bokmål, Finnish, Japanese, Simplified Chinese, Korean, Turkish, Ukrainian, Arabic and Hebrew, with right-to-left layout for Arabic and Hebrew, in the forms, emails, management pages and the admin, which follows the EmDash UI language. Admin and email translations are language packs downloaded from `cdn.jsdelivr.net` and checked against hashes built into the release; English is built in.
- The confirmation always offers a "Manage or cancel this registration" link to the same signed page as the email, even when no email is sent.
- Background tasks re-create themselves from the admin page and the public availability route.

### For site builders

- One npm package, `@vermeulen.solutions/eventual-attendance`, with the site components under `./astro`: `RsvpForm.astro` and `RsvpManage.astro`. The form's card width follows `--eventual-card-max-width`, so a page can let it fill its column; on dark sites the manage page's booking details use `--eventual-field-bg`.
- Three ways to install: npm sandboxed, npm native, and the EmDash registry once published. A registry install has an ID like `r_…`; the plugin page shows the exact paths to pass as `apiEndpoint` and `apiBase`.
- Settings on the Registration settings page: event collections, self-service page path, email language, reminder hours, retention days, reply-to and Turnstile keys. Capacity and the waiting-list switch live on the event form when the collection has those fields.
- The outbound hosts are `challenges.cloudflare.com` (only when Turnstile is on) and `cdn.jsdelivr.net` (language packs).
- The site components need `@vermeulen.solutions/eventual-locales`, installed with the package.
- `trust-contract.json` records capabilities, hosts, hooks, public routes and storage indexes; `npm test` fails when the build changes it.
- `npm run release:check` checks that the package is ready to publish, one line per step.

### Limits

- Tested on EmDash's runtime test host, in the local browser test site on Node, and run on Cloudflare (sandboxed under the Worker Loader) on a preview site. Its emails are not yet proven on a deployed site; payments and tickets are not part of this plugin.
- Roster exports and reconcile work in pages: about 700 rows per roster file and about 500 records per reconcile pass. The README's "Large events" section says what to do past those.
- Admin sidebar labels come from the English manifest, so they stay English in every admin language; the pages themselves are translated.
- Until a language pack has been downloaded (about five minutes after installing or updating), that language's emails and admin pages are in English.
- The forms need JavaScript (suite D14).
- A permanent delete of an entry that is already in the trash does not call the delete guard.
