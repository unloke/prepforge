import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const phone = readFileSync(new URL("./phone.css", import.meta.url), "utf8");

describe("shared chrome type", () => {
  it("keeps the rail group labels readable", () => {
    const size = parseFloat(/\.nav-group-label \{[^}]*font-size:\s*([\d.]+)px/.exec(css)[1]);
    expect(size).toBeGreaterThanOrEqual(11.5);
  });

  it("keeps the phone tab bar labels readable", () => {
    const base = parseFloat(/\.tabbar-item \{[^}]*font-size:\s*([\d.]+)px/.exec(css)[1]);
    const phoneSize = parseFloat(/\.tabbar \.tabbar-item \{[^}]*font-size:\s*([\d.]+)px/.exec(phone)[1]);
    expect(base).toBeGreaterThanOrEqual(12);
    expect(phoneSize).toBe(base);
  });

  it("keeps the note under the ⓘ at the body size", () => {
    // The note is read, not glimpsed, so it sits at the same floor as the
    // page's other running text.
    const pop = parseFloat(/\.pf-info-pop \{[^}]*font-size:\s*([\d.]+)px/.exec(css)[1]);
    const inline = parseFloat(/\.pf-info-inline \{[^}]*font-size:\s*([\d.]+)px/.exec(css)[1]);
    expect(pop).toBeGreaterThanOrEqual(13);
    expect(inline).toBeGreaterThanOrEqual(13);
  });
});
