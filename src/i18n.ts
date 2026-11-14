/**
 * Language packs for Attendance. English is built in; the other languages (admin texts under
 * "admin.", guest emails under "email.") are one pack per language from eventual-locales,
 * pinned by hash in src/locales/manifest.ts. Requests only ever read KV (1 call, then cached in the
 * isolate); the language-packs cron downloads missing packs every minute, so no request waits on
 * the CDN and no request's call budget is spent on a download.
 */
import type { Budget } from "@vermeulen.solutions/eventual-capacity";
import { loadPack, resolveLocale, warmPacks, type Catalog } from "./locales/index.mjs";
import pack from "./locales/manifest";

export const LANGUAGE_PACKS_TASK = "attendance-language-packs";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
type Http = { fetch(url: string, init?: unknown): Promise<{ ok: boolean; text(): Promise<string> }> };
export type PackHost = { kv?: unknown; http?: unknown };

/** The host's KV and HTTP with every call counted against the invocation budget. */
function counted(host: PackHost, budget: Budget) {
  const kv = host.kv as Kv | undefined;
  const http = host.http as Http | undefined;
  return {
    kv: kv && { get: (key: string) => budget.call(() => kv.get(key)), set: (key: string, value: unknown) => budget.call(() => kv.set(key, value)) },
    http: http && { fetch: (url: string) => budget.call(() => http.fetch(url)) },
  };
}

/**
 * The pack for `locale`, or null for English, a missing pack, or no call to spare beyond
 * `reserve`. Never downloads (the cron does), so it costs at most one call.
 */
export async function languagePack(host: PackHost, budget: Budget, locale: unknown, reserve = 0): Promise<Catalog | null> {
  if (resolveLocale(locale) === "en" || !host.kv) return null;
  const { kv } = counted(host, budget);
  return loadPack({ kv }, pack, locale, () => Math.min(budget.remaining - reserve, 1));
}

// Set once every pack of this version is stored: later runs in this isolate cost no call at all.
let complete = false;

/**
 * Cron, every minute: download packs not yet stored, the site language first (≤ 4 per run), so a
 * new install or a new pack version has every language within about five minutes. Until then a
 * buyer's email or an admin page in that language falls back to English.
 */
export async function warmLanguagePacks(host: PackHost & { site?: { locale?: string } }, budget: Budget) {
  if (complete) return { added: 0, missing: 0 };
  const result = await warmPacks(counted(host, budget), pack, host.site?.locale, () => budget.remaining);
  complete = result.missing === 0 && Object.keys(pack.hashes).length > 0;
  return result;
}
