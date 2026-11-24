import type { Budget } from "@vermeulen.solutions/eventual-capacity";

/** Which of the capacity field pack's fields (suite D2) the event's collection has. */
export interface EventFields {
  /** `inventory_mode`: "rsvp" opens registration, empty keeps it closed. */
  mode: boolean;
  /** `capacity`: places per date. */
  capacity: boolean;
  /** `allow_waitlist`: the waiting-list switch. */
  waitlist: boolean;
}

type SchemaHost = {
  schema?: { getCollection(slug: string): Promise<{ fields?: Array<{ slug: string }> } | null> };
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { fields: EventFields; at: number }>();

const fromSlugs = (slugs: Set<string>): EventFields => ({
  mode: slugs.has("inventory_mode"),
  capacity: slugs.has("capacity"),
  waitlist: slugs.has("allow_waitlist"),
});

/**
 * The field-pack fields of `collection`. EmDash leaves empty fields out of an entry's `data`, so
 * an entry whose fields were never filled in looks like one from a collection without them. The
 * collection's schema (`schema:read`) settles it: 0 calls when the entry already shows all three
 * fields, otherwise 1 call per collection per isolate per minute.
 *
 * Without schema access (an older host, or the call refused), a field the entry shows means the
 * pack is there, and the exporter always adds the three together.
 */
export async function eventFieldsOf(
  host: SchemaHost,
  budget: Budget,
  collection: string,
  data: Record<string, unknown>
): Promise<EventFields> {
  const seen = new Set(["inventory_mode", "capacity", "allow_waitlist"].filter((slug) => slug in data));
  if (seen.size === 3) return fromSlugs(seen);

  const hit = cache.get(collection);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.fields;

  const schema = host.schema;
  if (schema && budget.has(1)) {
    try {
      const info = await budget.call(() => schema.getCollection(collection));
      const slugs = new Set([...seen, ...(info?.fields ?? []).map((f) => f.slug)]);
      const fields = fromSlugs(slugs);
      cache.set(collection, { fields, at: Date.now() });
      return fields;
    } catch {
      // Fall through to what the entry shows.
    }
  }
  const any = seen.size > 0;
  return { mode: any, capacity: any, waitlist: any };
}
