import { normalizeLocale, type Locale } from "./messages";
import {
  fragmentLink,
  loadSigningSecret,
  normalizeCollectionSlug,
  normalizeEmail,
  normalizeRootPath,
  normalizeTurnstileKey,
  validTimeZone,
  type Budget,
  type SettingsLike,
  type VersionedKv,
} from "@vermeulen.solutions/eventual-capacity";

/**
 * Attendance's plugin-wide configuration.
 *
 * - **Signing key**: the library's `loadSigningSecret` on plugin KV (`state:signing-key`),
 *   generated on first use. No encrypted setting, so the site needs no EMDASH_ENCRYPTION_KEY.
 * - **Editable fields**: manage-page path and event collection in KV (`config:v1`), changed only
 *   through the validated admin form.
 *
 * Both are cached per isolate for CACHE_TTL_MS so admin edits reach every isolate within a minute.
 * A cold read costs 2 calls (config + key); creating the key costs 1–2 more, once per site.
 */
export const CONFIG_KEY = "config:v1";
export const DEFAULT_MANAGE_PAGE_PATH = "/rsvp/manage";
export const DEFAULT_EVENT_COLLECTION = "events";
const CACHE_TTL_MS = 60_000;

export type { SettingsLike };

export interface PluginConfig {
  hmacSecret: string;
  managePagePath: string;
  eventCollection: string;
  /** Site-wide reply-to for attendee emails ("" = none). Events can override it. */
  replyTo: string;
  /** Hours before an occurrence to send reminders; 0 turns reminders off. */
  reminderLeadHours: number;
  /** Email language for bookings that don't carry one (forms send their own). */
  defaultLocale: Locale;
  /** Days after an event (or occurrence) to keep personal attendee details (30–3650). */
  retentionDays: number;
  /**
   * IANA time zone for events that have none (a collection without a `timezone` field): emails,
   * reminders and admin pages show their times in it instead of UTC. Empty: UTC. EmDash's own
   * site time zone is not readable from a sandboxed plugin.
   */
  defaultTimezone: string;
  /**
   * Cloudflare Turnstile (suite D13): on when both keys are set. The secret only authorises
   * siteverify calls, so it is kept here with the other settings (no EMDASH_ENCRYPTION_KEY) and
   * never leaves the server.
   */
  turnstileSiteKey: string;
  turnstileSecretKey: string;
}

type EditableFields = Pick<
  PluginConfig,
  "managePagePath" | "eventCollection" | "replyTo" | "reminderLeadHours" | "defaultLocale" | "retentionDays" | "defaultTimezone" | "turnstileSiteKey" | "turnstileSecretKey"
>;
export const DEFAULT_REMINDER_LEAD_HOURS = 24;
export const DEFAULT_RETENTION_DAYS = 365;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export type EditableConfig = Partial<EditableFields>;

export interface ConfigHost {
  kv: VersionedKv;
}

let cached: { config: PluginConfig; at: number } | null = null;

/**
 * `eventCollection` may list several collections ("camps, school_series"); the first is the
 * default. Forms say which one their event lives in, and only listed collections are read.
 */
function normalizeCollectionList(value: unknown): string {
  const slugs = String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => normalizeCollectionSlug(s, "")).filter(Boolean);
  const unique = [...new Set(slugs)].slice(0, 10);
  return unique.length ? unique.join(", ") : DEFAULT_EVENT_COLLECTION;
}

export function eventCollections(config: Pick<PluginConfig, "eventCollection">): string[] {
  return config.eventCollection.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The collection a request asks for, if Attendance is configured to read it; else the default. Null when it isn't allowed. */
export function resolveCollection(config: Pick<PluginConfig, "eventCollection">, requested: unknown): string | null {
  const list = eventCollections(config);
  const wanted = typeof requested === "string" ? requested.trim() : "";
  if (!wanted) return list[0] ?? null;
  return list.includes(wanted) ? wanted : null;
}

/** Test hook: isolates may be reused, tests must not see another host's secret. */
export function resetConfigCache(): void {
  cached = null;
}

function normalizeEditable(value: unknown): EditableFields {
  const v = (value && typeof value === "object" ? value : {}) as Partial<EditableFields>;
  return {
    managePagePath: normalizeRootPath(v.managePagePath, DEFAULT_MANAGE_PAGE_PATH),
    eventCollection: normalizeCollectionList(v.eventCollection),
    replyTo: normalizeEmail(v.replyTo),
    reminderLeadHours: normalizeLeadHours(v.reminderLeadHours),
    defaultLocale: normalizeLocale(v.defaultLocale, "en"),
    retentionDays: normalizeRetentionDays(v.retentionDays),
    defaultTimezone: validTimeZone(v.defaultTimezone) ?? "",
    turnstileSiteKey: normalizeTurnstileKey(v.turnstileSiteKey),
    turnstileSecretKey: normalizeTurnstileKey(v.turnstileSecretKey),
  };
}

/** Turnstile is on only when both keys are set. */
export function turnstileEnabled(config: Pick<PluginConfig, "turnstileSiteKey" | "turnstileSecretKey">): boolean {
  return !!config.turnstileSiteKey && !!config.turnstileSecretKey;
}

function normalizeLeadHours(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 168 ? n : DEFAULT_REMINDER_LEAD_HOURS;
}

function normalizeRetentionDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  const int = Math.round(n);
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, int));
}

/** The editable fields alone (1 call, no secret): for routes that must work without one. */
export async function getEditableConfig(host: ConfigHost, budget: Budget): Promise<Omit<PluginConfig, "hmacSecret">> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const { hmacSecret: _secret, ...editable } = cached.config;
    return editable;
  }
  const stored = await budget.call(() => host.kv.getVersioned<EditableFields>(CONFIG_KEY));
  return normalizeEditable(stored?.value);
}

export async function getPluginConfig(host: ConfigHost, budget: Budget, nowMs = Date.now()): Promise<PluginConfig> {
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.config;
  const stored = await budget.call(() => host.kv.getVersioned<EditableFields>(CONFIG_KEY));
  const hmacSecret = await loadSigningSecret(host.kv, budget);
  cached = { config: { hmacSecret, ...normalizeEditable(stored?.value) }, at: nowMs };
  return cached.config;
}

/**
 * The stored settings, never an older copy: for pages that show settings to the administrator.
 * Another isolate or server instance may have saved since this isolate cached them, and a page
 * showing the old values reads as a save that did not stick. Reuses what was read or saved
 * since `sinceMs` (the start of the request); otherwise re-reads the editable fields (1 call)
 * and refreshes this isolate's cache. The signing key never changes once created.
 */
export async function getFreshPluginConfig(host: ConfigHost, budget: Budget, sinceMs: number, nowMs = Date.now()): Promise<PluginConfig> {
  if (cached && cached.at >= sinceMs) return cached.config;
  if (!cached) return getPluginConfig(host, budget, nowMs);
  const stored = await budget.call(() => host.kv.getVersioned<EditableFields>(CONFIG_KEY));
  cached = { config: { hmacSecret: cached.config.hmacSecret, ...normalizeEditable(stored?.value) }, at: nowMs };
  return cached.config;
}

/** Updates the admin-editable fields. The secret is never changed here. */
export async function updatePluginConfig(host: ConfigHost, budget: Budget, patch: EditableConfig): Promise<PluginConfig> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await budget.call(() => host.kv.getVersioned<EditableFields>(CONFIG_KEY));
    const next = normalizeEditable({ ...normalizeEditable(existing?.value), ...patch });
    const res = await budget.call(() => host.kv.compareAndSet(CONFIG_KEY, existing?.revision ?? null, next));
    if (res.applied) {
      cached = null; // re-read with the secret on next use
      return getPluginConfig(host, budget);
    }
  }
  throw new Error("Unable to save configuration.");
}

/** Self-service link with the token in the URL fragment (never sent to the server). */
export function manageLink(siteUrl: string, config: PluginConfig, action: "cancel" | "claim", token: string): string {
  return fragmentLink(siteUrl, config.managePagePath, { action, token });
}
