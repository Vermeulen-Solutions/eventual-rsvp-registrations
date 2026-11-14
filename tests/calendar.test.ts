import { describe, expect, it } from "vitest";
import { eventTiming, formatWhen } from "../src/domain/calendar";

describe("event timing", () => {
  it("reads Core's start/end", () => {
    expect(eventTiming({ start: "2027-01-14T17:30:00.000Z", end: "2027-01-14T19:00:00.000Z" })).toMatchObject({
      startsAt: "2027-01-14T17:30:00.000Z", allDay: false, end: "2027-01-14T19:00:00.000Z",
    });
  });

  it("falls back to start_date/end_date for collections without Core's fields (camps, school series)", () => {
    expect(eventTiming({ start_date: "2027-07-05T08:30:00.000Z", end_date: "2027-07-09T16:00:00.000Z" })).toMatchObject({
      startsAt: "2027-07-05T08:30:00.000Z", allDay: false,
    });
    // A bare date is an all-day event.
    expect(eventTiming({ start_date: "2027-07-05", end_date: "2027-07-09" })).toMatchObject({
      startsAt: "2027-07-05T00:00:00.000Z", allDay: true, startDate: "2027-07-05", end: "2027-07-09",
    });
    expect(eventTiming({ title: "No date" })).toBeNull();
  });

  it("formats dates in French or English", () => {
    const timing = { startsAt: "2027-07-05T08:30:00.000Z", allDay: false, timezone: "Europe/Zurich" };
    expect(formatWhen(timing, "fr")).toMatch(/lundi,? 5 juillet 2027 à 10:30/);
    expect(formatWhen(timing, "en")).toMatch(/Monday/);
    // A reminder must say which zone the time is in (task 43: no bare local time).
    expect(formatWhen(timing, "en")).toMatch(/GMT[+-]\d|UTC\+\d|CET|CEST/);
    expect(formatWhen(timing, "fr")).toMatch(/GMT[+-]\d|UTC\+\d|CET|CEST/);
  });
});
