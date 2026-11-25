import { afterEach, describe, expect, it } from "vitest";
import { RpcBudget } from "@vermeulen.solutions/eventual-capacity";
import { CONFIG_KEY, getFreshPluginConfig, getPluginConfig, resetConfigCache, updatePluginConfig } from "../src/domain/config";

/** Plugin KV shared by "isolates": the module cache plays one isolate, direct writes play another. */
function memoryKv() {
  const rows = new Map<string, { value: unknown; revision: number }>();
  let reads = 0;
  return {
    rows,
    get reads() { return reads; },
    async getVersioned<T>(key: string) { reads++; const row = rows.get(key); return row ? { value: row.value as T, revision: String(row.revision) } : null; },
    async compareAndSet(key: string, expected: string | null, value: unknown) {
      const row = rows.get(key);
      if ((row ? String(row.revision) : null) !== expected) return { applied: false };
      rows.set(key, { value, revision: (row?.revision ?? 0) + 1 });
      return { applied: true };
    },
    async get(key: string) { return rows.get(key)?.value ?? null; },
    async set(key: string, value: unknown) { rows.set(key, { value, revision: (rows.get(key)?.revision ?? 0) + 1 }); },
  };
}
/** What another isolate or server instance does when an administrator saves there. */
const saveElsewhere = (kv: ReturnType<typeof memoryKv>, eventCollection: string) => {
  const row = kv.rows.get(CONFIG_KEY);
  kv.rows.set(CONFIG_KEY, { value: { ...(row?.value as object), eventCollection }, revision: (row?.revision ?? 0) + 1 });
};

afterEach(() => resetConfigCache());

describe("settings shown to the administrator", () => {
  it("are re-read when another isolate saved after this one cached them", async () => {
    const kv = memoryKv();
    const host = { kv } as never;
    const cachedAt = Date.now();
    expect((await getPluginConfig(host, new RpcBudget(), cachedAt)).eventCollection).toBe("events");
    saveElsewhere(kv, "camps");
    // Requests that only use the settings may keep this isolate's copy for up to a minute.
    expect((await getPluginConfig(host, new RpcBudget(), cachedAt + 1000)).eventCollection).toBe("events");
    // The settings page shows what is stored, and refreshes this isolate's copy for everything else.
    const budget = new RpcBudget();
    const fresh = await getFreshPluginConfig(host, budget, cachedAt + 2000, cachedAt + 2000);
    expect(fresh.eventCollection).toBe("camps");
    expect(budget.limit - budget.remaining).toBe(1);
    expect((await getPluginConfig(host, new RpcBudget(), cachedAt + 3000)).eventCollection).toBe("camps");
  });

  it("keep the signing key, which never changes once created", async () => {
    const kv = memoryKv();
    const host = { kv } as never;
    const first = await getPluginConfig(host, new RpcBudget(), 1000);
    saveElsewhere(kv, "camps");
    expect((await getFreshPluginConfig(host, new RpcBudget(), 2000, 2000)).hmacSecret).toBe(first.hmacSecret);
  });

  it("cost nothing more right after a save in the same request", async () => {
    const kv = memoryKv();
    const host = { kv } as never;
    const requestStart = Date.now();
    await updatePluginConfig(host, new RpcBudget(), { eventCollection: "camps" });
    const budget = new RpcBudget();
    expect((await getFreshPluginConfig(host, budget, requestStart)).eventCollection).toBe("camps");
    expect(budget.limit - budget.remaining).toBe(0);
  });
});
