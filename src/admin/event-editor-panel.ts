import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import type { EventAttendanceConfig } from "../domain/types";
import {
  isTicketManaged,
  LEDGER_PREFIX,
  normalizeEmail,
  normalizeLedger,
  parseQuestionLines,
  poolKeyOfEvent,
  QUESTION_LIMITS,
  QUESTION_TYPES,
  RpcBudget,
  type EventContent,
  type QuestionDefinition,
  type QuestionIssue,
} from "@vermeulen.solutions/eventual-capacity";
import { getPluginConfig, eventCollections } from "../domain/config";
import { DEFAULT_APPROVAL_HOURS, DEFAULT_MAX_PER_REGISTRATION, resolveAttendance } from "../domain/event-settings";
import { attendanceCtx } from "../domain/waitlist";
import { eventFieldsOf, type EventFields } from "../domain/event-fields";
import { adminText, type AdminText } from "./i18n";
import { languagePack } from "../i18n";
import { resolveLocale } from "../locales/index.mjs";

type Blocks = BlockResponse["blocks"];
type Values = Record<string, unknown>;

function safeInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function toCapacity(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** What an organiser typed into one question row. */
interface QuestionDraft {
  /** Id of the question being edited; "" for a new one. */
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string;
}

function draftOf(id: string, vals: Values): QuestionDraft {
  return {
    id,
    label: text(vals.label, 400).trim(),
    type: text(vals.type, 20) || "text",
    required: vals.required === true,
    options: text(vals.options, 4000),
  };
}

/**
 * Checks one question row with the library's own parser (same rules as the text format), so the
 * row editor and scripts can't drift apart. A label can't contain the column separator.
 */
function checkQuestion(draft: QuestionDraft): { question?: QuestionDefinition; issue?: QuestionIssue } {
  const label = draft.label.replace(/\|/g, "/").replace(/^#+\s*/, "");
  if (!label) return { issue: { line: null, code: "NO_LABEL" } };
  const options = draft.type === "select"
    ? draft.options.split(/[\n,]/).map((o) => o.replace(/\|/g, "/").trim()).filter(Boolean).join(", ")
    : "";
  const parsed = parseQuestionLines([label, draft.type, draft.required ? "required" : "optional", options].join(" | "));
  if (parsed.issues[0]) return { issue: { ...parsed.issues[0], line: null } };
  return { question: parsed.questions[0] };
}

function questionForm(t: AdminText, draft: QuestionDraft, isNew: boolean): Blocks[number] {
  return {
    type: "form",
    block_id: isNew ? "question-new" : `question-${draft.id}`,
    fields: [
      { type: "text_input", action_id: "label", label: t.qLabel, placeholder: isNew ? t.qLabelPlaceholder : undefined, initial_value: draft.label },
      {
        type: "select",
        action_id: "type",
        label: t.qType,
        options: QUESTION_TYPES.map((value) => ({ label: t.qTypes[value], value })),
        initial_value: draft.type,
      },
      {
        type: "text_input",
        action_id: "options",
        label: t.qOptions,
        placeholder: "S\nM\nL",
        multiline: true,
        initial_value: draft.options,
        condition: { field: "type", eq: "select" },
      },
      { type: "toggle", action_id: "required", label: t.qRequired, initial_value: draft.required },
    ],
    submit: isNew
      ? { action_id: "add-question", label: t.qAdd }
      : { action_id: `save-question:${draft.id}`, label: t.qSave },
  } as Blocks[number];
}

/**
 * Per-event registration panel. Settings are stored once per translation group (pool), so every
 * language version of an event shares capacity, limits and the waitlist. ≤ 8 calls.
 *
 * Capacity, the waitlist switch and the open/closed state have one home: when the event's
 * collection carries the capacity field pack (`capacity`, `allow_waitlist`, `inventory_mode`),
 * they are edited in the event form and only shown here, whatever the entry's values. The panel
 * then stores no value for them, so the event's fields apply. A field the collection lacks is set
 * here instead. Values stored before (older version, script) still win; the panel says so and
 * offers to drop them.
 */
export async function handleEventEditorPanel(
  routeCtx: SandboxedRouteContext,
  ctx: PluginContext
): Promise<BlockResponse> {
  const budget = new RpcBudget();
  const t = adminText(await languagePack(ctx, budget, routeCtx.ui?.locale), resolveLocale(routeCtx.ui?.locale));
  const entry = routeCtx.ui?.entry;
  if (!entry?.id) {
    return { blocks: [{ type: "context", text: t.openEvent }] };
  }

  const actx = attendanceCtx(ctx);
  const config = await getPluginConfig(actx, budget);
  if (!eventCollections(config).includes(entry.collection)) {
    // Pages and other content: one neutral line, so nobody is invited to make them bookable.
    // Only a collection that carries the capacity fields (an events collection the site builder
    // has not listed yet) gets the pointer to the settings.
    const other = (await budget.call(() => ctx.content!.get(entry.collection, entry.id))) as EventContent | null;
    const found = await eventFieldsOf(ctx as any, budget, entry.collection, (other?.data ?? {}) as Record<string, unknown>);
    const looksLikeEvents = found.mode || found.capacity || found.waitlist;
    return {
      blocks: [{
        type: "context",
        text: looksLikeEvents ? t.notConfigured(config.eventCollection) : t.notEventContent,
      }],
    };
  }

  const event = (await budget.call(() => ctx.content!.get(entry.collection, entry.id))) as EventContent | null;
  if (!event) return { blocks: [{ type: "context", text: t.saveFirst }] };

  const poolKey = poolKeyOfEvent(event);
  const settings = (ctx.storage as any).attendance_settings;
  const request = routeCtx.input && typeof routeCtx.input === "object" && !Array.isArray(routeCtx.input)
    ? (routeCtx.input as Record<string, unknown>)
    : {};
  const action = typeof request.action_id === "string" ? request.action_id : "";
  const vals: Values | null = request.values && typeof request.values === "object" ? (request.values as Values) : null;

  const resolved = await resolveAttendance(settings, budget, event);
  let current = resolved.config;
  let stored: Partial<EventAttendanceConfig> = { ...(resolved.stored ?? {}) };
  let toast: BlockResponse["toast"] | undefined;
  let errors: string[] = [];
  /** A question row that failed its check: shown again, open, with what was typed. */
  let rejected: QuestionDraft | null = null;

  const data = (event.data ?? {}) as Record<string, unknown>;
  // The event form owns these when the collection has the fields, filled in or not.
  const fields: EventFields = await eventFieldsOf(ctx as any, budget, entry.collection, data);
  const fieldOpen = data.inventory_mode === "rsvp";
  const fieldCapacity = toCapacity(data.capacity);
  const fieldWaitlist = Boolean(data.allow_waitlist);

  /** Which stored values of field-owned settings differ from the event's fields. */
  const overrides = (rec: Partial<EventAttendanceConfig>) => ({
    enabled: fields.mode && typeof rec.enabled === "boolean" && rec.enabled !== fieldOpen,
    capacity: fields.capacity && rec.capacity != null && toCapacity(rec.capacity) !== fieldCapacity,
    waitlist: fields.waitlist && rec.allowWaitlist != null && Boolean(rec.allowWaitlist) !== fieldWaitlist,
  });

  const save = async (next: Partial<EventAttendanceConfig>, message: string) => {
    // A stored copy of a field-owned setting that matches the field changes nothing today but
    // would hide a later change to the field: drop it. A differing one stays (shown below).
    next = { ...next };
    const differs = overrides(next);
    if (fields.mode && !differs.enabled) delete next.enabled;
    if (fields.capacity && !differs.capacity) delete next.capacity;
    if (fields.waitlist && !differs.waitlist) delete next.allowWaitlist;
    // Keyed by pool: one record for every translation of this event.
    await budget.call(() => settings.put(poolKey, { ...next, eventId: poolKey }));
    stored = next;
    const again = await resolveAttendance({ get: async () => next }, new RpcBudget(), event);
    current = again.config;
    toast = { message, type: "success" };
  };

  if (action === "save-attendance-settings" && vals) {
    // `questions` as text is the scripting format (one per line); the panel's own form never sends it.
    let questions = current.questions ?? [];
    if (typeof vals.questions === "string") {
      const parsed = parseQuestionLines(vals.questions.slice(0, 20_000));
      errors = parsed.issues.map(t.questionIssue);
      questions = parsed.questions;
    }
    if (errors.length === 0) {
      await save({
        // The panel's form leaves out what the event form owns; scripts may still send it. Not
        // sent: keep what was stored, so saving another setting never quietly opens or closes
        // registration. `save` drops a copy equal to the field; a differing one stays until
        // "Use the event's fields".
        enabled: "enabled" in vals || !fields.mode ? vals.enabled === true : stored.enabled,
        capacity: "capacity" in vals ? safeInt(vals.capacity, 0, 100_000, current.capacity) : fields.capacity ? stored.capacity : undefined,
        maxPerRegistration: safeInt(vals.maxPerRegistration, 1, 20, DEFAULT_MAX_PER_REGISTRATION),
        allowWaitlist: "allowWaitlist" in vals ? vals.allowWaitlist === true : fields.waitlist ? stored.allowWaitlist : undefined,
        requireApproval: vals.requireApproval === true,
        approvalHours: safeInt(vals.approvalHours, 1, 720, current.approvalHours ?? DEFAULT_APPROVAL_HOURS),
        replyTo: normalizeEmail(vals.replyTo),
        questions,
      }, t.panelSaved);
    }
  } else if ((action === "add-question" || action.startsWith("save-question:")) && vals) {
    const id = action === "add-question" ? "" : action.slice("save-question:".length);
    const list = [...(current.questions ?? [])];
    const index = list.findIndex((q) => q.id === id);
    const draft = draftOf(id, vals);
    const checked = checkQuestion(draft);
    if (id && index < 0) {
      errors = [t.qGone];
    } else if (!id && list.length >= QUESTION_LIMITS.questions) {
      errors = [t.questionIssue({ line: null, code: "TOO_MANY_QUESTIONS", limit: QUESTION_LIMITS.questions })];
    } else if (!checked.question) {
      errors = [t.questionIssue(checked.issue!)];
      rejected = draft;
    } else if (id) {
      // The id stays, so answers already given keep matching this question.
      list[index] = { ...checked.question, id };
      await save({ ...stored, questions: list }, t.qSaved);
    } else {
      const taken = new Set(list.map((q) => q.id));
      let newId = checked.question.id;
      for (let n = 2; taken.has(newId); n++) newId = `${checked.question.id}_${n}`;
      list.push({ ...checked.question, id: newId });
      await save({ ...stored, questions: list }, t.qAdded);
    }
  } else if (action === "remove-question" || action === "move-question-up") {
    const list = [...(current.questions ?? [])];
    const index = list.findIndex((q) => q.id === request.value);
    if (index < 0) {
      errors = [t.qGone];
    } else if (action === "remove-question") {
      list.splice(index, 1);
      await save({ ...stored, questions: list }, t.qRemoved);
    } else if (index > 0) {
      [list[index - 1], list[index]] = [list[index]!, list[index - 1]!];
      await save({ ...stored, questions: list }, t.qMoved);
    }
  } else if (action === "use-event-fields") {
    // Drop the stored copies of field-owned settings, so the event's own fields apply again.
    const next = { ...stored };
    if (fields.mode) delete next.enabled;
    if (fields.capacity) delete next.capacity;
    if (fields.waitlist) delete next.allowWaitlist;
    await save(next, t.usingEventFields);
  } else if (action === "view-registrations") {
    // Open the registrations page already narrowed to this event.
    await budget.call(() => ctx.kv.set(`state:admin-filter:${routeCtx.user?.id ?? "shared"}`, { pool: poolKey }));
    return { blocks: [], navigate: { kind: "plugin-page", path: "/attendance" } };
  }

  if (errors.length) toast = { message: rejected || !vals || !("questions" in vals) ? errors[0]! : t.panelNotSaved, type: "error" };

  // Seat totals across every occurrence of this pool, read from the ledgers (1 call).
  const base = `${LEDGER_PREFIX}${poolKey}`;
  const ledgers = (await budget.call(() => actx.kv.list(base)))
    .filter((l) => l.key === base || l.key.startsWith(`${base}:`))
    .map((l) => normalizeLedger(l.value as any))
    .filter((l): l is NonNullable<typeof l> => !!l);
  const taken = ledgers.reduce((sum, l) => sum + l.taken, 0);
  const held = ledgers.reduce((sum, l) => sum + l.held, 0);
  const waiting = ledgers.reduce((sum, l) => sum + l.waitlistCount, 0);
  const any = taken + held + waiting > 0;

  // No header: the editor already shows the panel's title.
  const blocks: Blocks = [];
  if (errors.length) {
    blocks.push({ type: "banner", title: rejected ? t.qNotSaved : t.questionsNeedFixing, description: errors.slice(0, 10).join(" "), variant: "error" });
  }

  const viewButton = { type: "button", action_id: "view-registrations", label: t.viewRegistrations } as const;
  const counts = [
    ledgers.length > 1
      ? t.placesTakenAllDates(taken)
      : current.capacity > 0 ? t.placesTakenOf(taken, current.capacity) : t.placesTaken(taken),
    held ? t.placesOffered(held) : "",
    waiting ? t.peopleWaiting(waiting) : "",
  ].filter(Boolean).join(" · ");

  if (isTicketManaged(event)) {
    blocks.push({ type: "banner", title: t.ticketedTitle, description: t.ticketedBody, variant: "alert" });
    if (any) blocks.push({ type: "section", text: counts, accessory: viewButton });
    return { blocks, toast };
  }

  blocks.push({
    type: "section",
    text: `${current.enabled ? t.statusOpen : t.statusClosed} · ${counts}`,
    accessory: viewButton,
  });

  const inputs: any[] = [];
  if (!fields.mode) {
    inputs.push({ type: "toggle", action_id: "enabled", label: t.enable, description: t.enableHelp, initial_value: current.enabled });
  }
  if (!fields.capacity) {
    inputs.push({ type: "number_input", action_id: "capacity", label: t.capacityLimit, min: 0, max: 100000, initial_value: current.capacity });
  }
  if (!fields.waitlist) {
    inputs.push({ type: "toggle", action_id: "allowWaitlist", label: t.allowWaitlist, description: t.allowWaitlistHelp, initial_value: current.allowWaitlist });
  }
  inputs.push(
    { type: "number_input", action_id: "maxPerRegistration", label: t.maxPerBooking, min: 1, max: 20, initial_value: current.maxPerRegistration },
    { type: "toggle", action_id: "requireApproval", label: t.requireApproval, description: t.requireApprovalHelp, initial_value: current.requireApproval },
    {
      type: "number_input",
      action_id: "approvalHours",
      label: t.approvalHours,
      min: 1,
      max: 720,
      initial_value: current.approvalHours,
      condition: { field: "requireApproval", eq: true },
    },
    { type: "text_input", action_id: "replyTo", label: t.eventReplyTo, placeholder: config.replyTo || undefined, initial_value: current.replyTo ?? "" }
  );

  if (fields.mode || fields.capacity || fields.waitlist) {
    // Read-only: what the event's own fields say. The status line above shows what applies.
    const parts: string[] = [];
    if (fields.mode) parts.push(fieldOpen ? t.statusOpen : t.statusClosed);
    if (fields.capacity) parts.push(fieldCapacity > 0 ? t.fromEventPlaces(fieldCapacity) : t.fromEventNoLimit);
    if (fields.waitlist) parts.push(fieldWaitlist ? t.fromEventWaitlistOn : t.fromEventWaitlistOff);
    const hints = [fields.capacity || fields.waitlist ? t.fromEventHint : "", fields.mode ? t.fromEventOpenHint : ""].filter(Boolean);
    blocks.push({ type: "context", text: `${t.fromEventLead} ${parts.join(" · ")}. ${hints.join(" ")}` });
    // Values saved here before the event form owned them still win. That is only worth a word
    // when they differ from the event's fields: the same values change nothing (and the next
    // save drops them).
    const differs = overrides(stored);
    if (differs.enabled || differs.capacity || differs.waitlist) {
      blocks.push(
        { type: "banner", title: t.fieldsOverriddenTitle, description: t.fieldsOverridden, variant: "alert" },
        { type: "actions", elements: [{ type: "button", action_id: "use-event-fields", label: t.useEventFields, style: "primary" }] }
      );
    }
  }

  blocks.push(
    { type: "form", block_id: "attendance-settings", fields: inputs, submit: { action_id: "save-attendance-settings", label: t.savePanel } },
    { type: "context", text: t.savedSeparately },
    { type: "divider" },
    { type: "section", text: t.qHeader },
    { type: "context", text: t.qIntro }
  );

  const questions = current.questions ?? [];
  questions.forEach((q, index) => {
    const isRejected = rejected?.id === q.id;
    const draft: QuestionDraft = isRejected
      ? rejected!
      : { id: q.id, label: q.label, type: q.type, required: q.required, options: (q.options ?? []).join("\n") };
    const elements: any[] = [];
    if (index > 0) elements.push({ type: "button", action_id: "move-question-up", label: t.qMoveUp, value: q.id });
    elements.push({
      type: "button",
      action_id: "remove-question",
      label: t.qRemove,
      style: "danger",
      value: q.id,
      confirm: { title: t.qRemoveTitle(q.label), text: t.qRemoveText, confirm: t.qRemove, deny: t.keep },
    });
    blocks.push({
      type: "accordion",
      label: `${index + 1}. ${q.label} · ${t.qTypes[q.type]}${q.required ? ` · ${t.required}` : ""}`,
      default_open: isRejected,
      blocks: [questionForm(t, draft, false), { type: "actions", elements }],
    } as Blocks[number]);
  });

  if (questions.length < QUESTION_LIMITS.questions) {
    const draft = rejected && !rejected.id ? rejected : { id: "", label: "", type: "text", required: false, options: "" };
    blocks.push({
      type: "accordion",
      label: t.qAddHeader,
      default_open: questions.length === 0 || (!!rejected && !rejected.id),
      blocks: [questionForm(t, draft, true)],
    } as Blocks[number]);
  }

  return { blocks, toast };
}
