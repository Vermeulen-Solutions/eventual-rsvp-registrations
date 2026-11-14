import { normalizeEmail, normalizeQuestions, poolKeyOfEvent, type Budget, type EventContent } from "@vermeulen.solutions/eventual-capacity";
import type { EventAttendanceConfig } from './types';

// Inventory mode and pool keys come from the shared library (suite D2): `isTicketManaged`,
// `isRsvpManaged`, `poolKeyOfEvent`, `EventContent`.

export const DEFAULT_MAX_PER_REGISTRATION = 4;
export const DEFAULT_APPROVAL_HOURS = 48;

export interface ResolvedAttendance {
  config: EventAttendanceConfig;
  /** Where `enabled` came from — shown in the editor panel so organisers understand the state. */
  source: 'panel' | 'event-field' | 'default';
  /** The record as saved (pool-keyed), so partial saves keep what they don't touch. */
  stored: Partial<EventAttendanceConfig> | null;
}

function toCapacity(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Resolves the effective attendance configuration for an event.
 *
 * Precedence: settings saved in the editor panel (keyed by pool) → field-pack values on the
 * event → safe defaults. RSVPs are **closed by default**:
 * without panel settings an event only accepts RSVPs when its `inventory_mode` is explicitly
 * "rsvp".
 *
 * Costs 1 call.
 */
export async function resolveAttendance(
  settings: { get(id: string): Promise<unknown> },
  budget: Budget,
  event: EventContent
): Promise<ResolvedAttendance> {
  const stored = unwrap(await budget.call(() => settings.get(poolKeyOfEvent(event))));

  const data = event.data ?? {};
  const fieldEnabled = data.inventory_mode === 'rsvp';
  const config: EventAttendanceConfig = {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : fieldEnabled,
    capacity: toCapacity(stored?.capacity ?? data.capacity),
    maxPerRegistration: clampMax(stored?.maxPerRegistration),
    allowWaitlist: Boolean(stored?.allowWaitlist ?? data.allow_waitlist ?? false),
    requireApproval: Boolean(stored?.requireApproval ?? false),
    approvalHours: clampApprovalHours(stored?.approvalHours),
    replyTo: normalizeEmail(stored?.replyTo),
    questions: normalizeQuestions(stored?.questions),
  };
  const source: ResolvedAttendance['source'] =
    typeof stored?.enabled === 'boolean' ? 'panel' : fieldEnabled ? 'event-field' : 'default';
  return { config, source, stored };
}

function clampMax(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(20, n) : DEFAULT_MAX_PER_REGISTRATION;
}

function clampApprovalHours(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return DEFAULT_APPROVAL_HOURS;
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(1, Math.min(720, n)) : DEFAULT_APPROVAL_HOURS;
}

/** Earlier of `nowMs + approvalHours` and the occurrence start (if known). */
export function approvalDeadline(nowMs: number, approvalHours: number, startsAt?: string): string {
  const byHours = nowMs + approvalHours * 3_600_000;
  const startMs = startsAt ? Date.parse(startsAt) : Number.NaN;
  const dueMs = Number.isFinite(startMs) ? Math.min(byHours, startMs) : byHours;
  return new Date(dueMs).toISOString();
}

function unwrap(value: unknown): Partial<EventAttendanceConfig> | null {
  if (!value || typeof value !== 'object') return null;
  const inner = (value as { data?: unknown }).data;
  return (inner && typeof inner === 'object' ? inner : value) as Partial<EventAttendanceConfig>;
}
