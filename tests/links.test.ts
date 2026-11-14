import { describe, expect, it } from "vitest";
import { calendarLink } from "../src/domain/calendar";

describe("links use the plugin's real ID", () => {
  it("builds the calendar link with a registry ID", () => {
    const url = calendarLink("https://site.test", "evt1", "", "", "r_abc123");
    expect(url).toContain("/_emdash/api/plugins/r_abc123/calendar?");
  });
});
