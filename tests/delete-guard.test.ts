import { describe, expect, it } from "vitest";
import { isLiveOccurrence } from "../src/domain/delete-guard";

describe("isLiveOccurrence", () => {
  it("treats undated events as live", () => {
    expect(isLiveOccurrence("")).toBe(true);
  });

  it("treats future dates as live", () => {
    const now = Date.now();
    const future = new Date(now + 24 * 3_600_000).toISOString();
    expect(isLiveOccurrence(future, now)).toBe(true);
  });

  it("treats occurrences within 12 hours past as live", () => {
    const now = Date.now();
    const recent = new Date(now - 6 * 3_600_000).toISOString();
    expect(isLiveOccurrence(recent, now)).toBe(true);
  });

  it("treats occurrences older than 12 hours as not live", () => {
    const now = Date.now();
    const old = new Date(now - 13 * 3_600_000).toISOString();
    expect(isLiveOccurrence(old, now)).toBe(false);
  });
});
