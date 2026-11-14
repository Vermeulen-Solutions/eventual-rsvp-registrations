/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { RSVP_EN, rsvpText } from "../astro/rsvp-i18n";
import { adminText } from "../src/admin/i18n";
import { messageSet, normalizeLocale, languageName, LOCALES } from "../src/domain/messages";
import { messageArguments } from "../src/locales/index.mjs";
import english from "@vermeulen.solutions/eventual-locales/catalogs/attendance/en.json";
import french from "@vermeulen.solutions/eventual-locales/catalogs/attendance/fr.json";
import formEnglish from "@vermeulen.solutions/eventual-locales/catalogs/attendance-form/en.json";

const packs = import.meta.glob("../node_modules/@vermeulen.solutions/eventual-locales/catalogs/attendance/*.json", { eager: true, import: "default" }) as Record<string, Record<string, string>>;
const forms = import.meta.glob("../node_modules/@vermeulen.solutions/eventual-locales/catalogs/attendance-form/*.json", { eager: true, import: "default" }) as Record<string, Record<string, string>>;
const lang = (path: string) => path.slice(path.lastIndexOf("/") + 1, -5);

describe("RsvpForm and RsvpManage translations", () => {
  it("keeps the email and no-email variants distinct in every language", async () => {
    for (const locale of LOCALES) {
      const client = (await rsvpText(locale)).client;
      for (const key of ["successBody", "successBodyNoEmail", "pendingTitle", "pendingBody", "pendingBodyNoEmail", "submitRequest"] as const) {
        expect(client[key], `${locale} ${key}`).toBeTruthy();
      }
      expect(client.waitlistBody).toContain("{n}");
      expect(client.waitlistBodyNoEmail).toContain("{n}");
    }
    const fr = (await rsvpText("fr-CH")).client;
    expect(fr.successBody.toLowerCase()).toMatch(/e-?mail/);
    expect(fr.successBodyNoEmail.toLowerCase()).not.toMatch(/e-?mail/);
    expect(RSVP_EN.client.successBody.toLowerCase()).toMatch(/e-?mail/);
    expect(RSVP_EN.client.successBodyNoEmail.toLowerCase()).not.toMatch(/e-?mail/);
  });

  it("falls back to English and covers the manage page", async () => {
    expect((await rsvpText("xx")).title).toBe(RSVP_EN.title);
    expect((await rsvpText("fr")).manage.client.claimButton).not.toBe(RSVP_EN.manage.client.claimButton);
  });

  it("ships form catalogs with plain placeholders only (the client uses String.replace)", () => {
    expect(Object.keys(formEnglish).length).toBeGreaterThan(70);
    for (const [path, catalog] of Object.entries(forms)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(key in formEnglish, `${lang(path)} has unknown key ${key}`).toBe(true);
        expect(value.trim(), `${lang(path)} ${key}`).not.toBe("");
        expect(value, `${lang(path)} ${key}`).not.toMatch(/\{\w+, (plural|select)/);
      }
    }
  });
});

describe("Attendance admin texts and emails", () => {
  it("uses English without a pack and the pack's language with one", () => {
    expect(adminText().navOverview).toBe("Registrations");
    const fr = adminText(french, "fr");
    expect(fr.navOverview).not.toBe("Registrations");
    expect(fr.places(1)).toBe("1 place");
    expect(fr.places(3)).toBe("3 places");
    expect(fr.days[0]).toBe("Lun");
    expect(Object.values(fr.csvHeaders)).toHaveLength(10);
    expect(fr.questionIssue({ line: 3, code: "NO_LABEL" })).toBe("Ligne 3 : écrivez d’abord la question.");
    expect(adminText().questionIssue({ line: null, code: "TOO_MANY_QUESTIONS", limit: 20 })).toBe("At most 20 questions per event.");
    expect(adminText().placesTaken(1)).toBe("1 place taken");
    expect(adminText().doorCount(3, 40, true)).toBe("3 of 40+ checked in");
  });

  it("renders guest emails with optional parts and plurals", () => {
    const en = messageSet(null, "en");
    const confirmed = en.rsvpConfirmed({ name: "Ann", title: "Gala", cancelUrl: "https://x/c" });
    expect(confirmed.subject).toBe("RSVP confirmed: Gala");
    expect(confirmed.text).not.toContain("calendar");
    expect(en.reminder({ name: "Ann", title: "Gala", when: "today", quantity: 1, calendarUrl: "c", cancelUrl: "u" }).text).toContain("coming up: today.");
    expect(en.reminder({ name: "Ann", title: "Gala", when: "today", quantity: 2, calendarUrl: "c", cancelUrl: "u" }).text).toContain("today (2 seats).");
    const fr = messageSet(french, "fr");
    expect(fr.rsvpConfirmed({ name: "Ann", title: "Gala", calendarUrl: "https://x/cal", cancelUrl: "https://x/c" }).text).toContain("Ajoutez-la à votre agenda :\nhttps://x/cal");
    expect(fr.organiserNewRequest({ name: "Ann", title: "Gala", email: "a@x", quantity: 2, date: "d", deadline: "e" }).text).toContain("a demandé 2 places");
  });

  it("normalizes guest languages and names them in their own language", () => {
    expect(normalizeLocale("fr-CH")).toBe("fr");
    expect(normalizeLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeLocale("xx", "de")).toBe("de");
    expect(normalizeLocale("en-GB", "de")).toBe("en");
    expect(normalizeLocale("", "fr")).toBe("fr");
    expect(languageName("de")).toBe("Deutsch");
    expect(LOCALES).toHaveLength(21);
  });

  it("has a valid catalog for every shipped language, with the same placeholders as English", () => {
    for (const [path, catalog] of Object.entries(packs)) {
      if (lang(path) === "en") continue;
      for (const [key, value] of Object.entries(catalog)) {
        expect(key in english, `${lang(path)} has unknown key ${key}`).toBe(true);
        const allowed = messageArguments((english as Record<string, string>)[key]!);
        for (const name of messageArguments(value)) expect(allowed.has(name), `${lang(path)} ${key} uses unknown {${name}}`).toBe(true);
      }
    }
  });
});
