import { signToken, type Budget } from "@vermeulen.solutions/eventual-capacity";

export const IP_RATE_LIMIT = 10;
export const IP_WINDOW_MS = 10 * 60_000;

/**
 * First 32 hex chars of HMAC-SHA256(signingKey, "ip:" + ip).
 * Stored instead of the visitor's raw IP address so entries cannot be reversed without the site key.
 */
export async function hashVisitorIp(signingKey: string, ip: string): Promise<string> {
  return (await signToken(signingKey, "ip", [ip])).slice(0, 32);
}

/**
 * Refuses more than IP_RATE_LIMIT bookings per IP hash within IP_WINDOW_MS (1 call).
 * Uses the plugin's own ["ipHash", "createdAt"] storage index.
 */
export async function isIpRateLimited(
  storage: { query(opts: unknown): Promise<{ items: Array<unknown> }> },
  budget: Budget,
  ipHash: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const recent = await budget.call(() =>
    storage.query({
      where: { ipHash, createdAt: { gt: new Date(nowMs - IP_WINDOW_MS).toISOString() } },
      limit: IP_RATE_LIMIT,
    })
  );
  return recent.items.length >= IP_RATE_LIMIT;
}
