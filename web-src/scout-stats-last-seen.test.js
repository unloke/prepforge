import { describe, expect, it } from "vitest";

import { formatLastSeenLabel } from "./scout-stats.js";

describe("formatLastSeenLabel", () => {
  it("adds the year to a month outside the current year", () => {
    const thisYear = new Date().getFullYear();
    const old = Date.UTC(2014, 9, 15);
    expect(formatLastSeenLabel({ lastDatestamp: old, daysAgo: 4000 })).toBe("not since October 2014");
    const recent = new Date(thisYear, 0, 15, 12).getTime();
    const days = Math.round((Date.now() - recent) / 86400000);
    if (days >= 14) expect(formatLastSeenLabel({ lastDatestamp: recent, daysAgo: days })).toBe("not since January");
  });
});
