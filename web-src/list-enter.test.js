import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { staggerRows } from "./list-enter.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("list entry", () => {
  it("numbers rows and caps the stagger so a long list never drags", () => {
    const seen = [];
    const container = {
      children: Array.from({ length: 40 }, (_, i) => ({
        style: { setProperty: (name, value) => seen.push([name, value]) },
      })),
    };
    staggerRows(container);
    expect(seen).toHaveLength(40);
    expect(seen[0]).toEqual(["--i", "0"]);
    expect(seen[8]).toEqual(["--i", "8"]);
    // Capped: rows 9..39 all share the last step, so the tail never drags.
    expect(seen[39]).toEqual(["--i", "8"]);
  });

  it("animates opacity and transform only", () => {
    const body = /\.list-enter > \* \{([^}]*)\}/.exec(css)[1];
    expect(body).toContain("animation:");
    expect(body).toContain("calc(min(var(--i, 0), 8) * 25ms)");
    const frames = /@keyframes row-enter \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
  });

  it("gives every pressable control the same scale-down", () => {
    for (const selector of [".mtree-move:active", ".row-menu-btn:active", ".sum-chip:active", ".tabbar-item:active"]) {
      expect(css).toContain(`${selector} {`);
    }
  });
});
