# Eventual RSVP – Registrations 0.1.1

Requires EmDash **>=1.2.0 <2.0.0** and [Eventual RSVP – Core](https://eventual.rsvp/docs/#core) for the events.

In **Plugins → Registry**, find **Eventual RSVP – Registrations** by **vermeulen.solutions**, review the permissions and install. It reads your event content, sends booking emails, and may call two hosts: `challenges.cloudflare.com` (optional Turnstile spam protection) and `cdn.jsdelivr.net` (hash-checked admin language packs).

Then:

1. Open **Registration settings → Site setup** and check the event collection (the one chosen in Core's **Event settings**).
2. In an event, set **Registrations** to open, with a number of places and an optional waiting list, approval and registration questions.
3. Your site builder adds the registration form and the self-service page to the event pages, from the npm package `@vermeulen.solutions/eventual-attendance` at the same version. On a registry install, use the plugin path shown under **Site setup**.

Visitors register on your pages; the list stays in your own database. The **Door list** works on a phone for check-in.

[Install guide](https://eventual.rsvp/install/) · [Documentation](https://eventual.rsvp/docs/#attendance)
