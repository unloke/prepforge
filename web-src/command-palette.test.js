import { describe, it, expect } from "vitest";

import {
  PALETTE_ACTIONS,
  PALETTE_VIEWS,
  buildPaletteItems,
  filterPaletteItems,
  renderPaletteItems,
  scorePaletteItem,
} from "./command-palette.js";

const reps = [
  { id: "r1", name: "Sicilian Najdorf", color: "black" },
  { id: "r2", name: "Italian Game", color: "white" },
];

describe("command palette filter", () => {
  const items = buildPaletteItems({ repertoires: reps });

  it("includes every workspace view, user repertoires, and the three named actions", () => {
    const labels = items.map((item) => item.label);
    for (const view of PALETTE_VIEWS) {
      expect(labels).toContain(view.label);
    }
    for (const action of PALETTE_ACTIONS) {
      expect(labels).toContain(action.label);
    }
    expect(labels).toContain("Sicilian Najdorf");
    expect(labels).toContain("Italian Game");
    expect(PALETTE_ACTIONS.map((a) => a.label)).toEqual([
      "New repertoire",
      "Start training",
      "Play vs human",
      "I'm Feeling Lucky",
      "Analyze",
      "Toggle light / dark theme",
    ]);
  });

  it("finds the theme switch by the words people type", async () => {
    const { filterPaletteItems } = await import("./command-palette.js");
    for (const q of ["theme", "dark"]) {
      expect(filterPaletteItems(items, q).map((i) => i.label)).toContain("Toggle light / dark theme");
    }
  });

  it("lists views in the same order as the rail", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const rail = html.slice(html.indexOf('<nav class="rail"'), html.indexOf("</nav>"));
    const railOrder = [...rail.matchAll(/class="tab nav-item[^"]*" data-view="([^"]+)"(?: data-replay-section="([^"]+)")?/g)]
      .map((m) => (m[2] ? `${m[1]}:${m[2]}` : m[1]));
    const paletteOrder = PALETTE_VIEWS.map((v) => (v.section ? `${v.id}:${v.section}` : v.id));
    expect(railOrder.slice(0, 3)).toEqual(["dashboard", "build", "analyze"]);
    expect(paletteOrder).toEqual(railOrder);
    // Empty query keeps the rail order too.
    const views = filterPaletteItems(items, "").filter((item) => item.kind === "view");
    expect(views.map((item) => item.label).slice(0, 3)).toEqual(["Library", "Repertoire", "Analyze"]);
  });

  it("empty query keeps views, repertoires, and the three actions", () => {
    const filtered = filterPaletteItems(items, "");
    expect(filtered).toHaveLength(items.length);
    expect(filtered.some((item) => item.action === "new-repertoire")).toBe(true);
    expect(filtered.some((item) => item.action === "start-training")).toBe(true);
    expect(filtered.some((item) => item.action === "analyze")).toBe(true);
  });

  it("ranks Analyze above unrelated views for 'anal'", () => {
    const filtered = filterPaletteItems(items, "anal");
    expect(filtered[0].label).toBe("Analyze");
    expect(filtered.some((item) => item.view === "analyze" || item.action === "analyze")).toBe(
      true,
    );
    expect(filtered.some((item) => item.label === "Dashboard")).toBe(false);
  });

  it("ranks New repertoire first for 'new'", () => {
    const filtered = filterPaletteItems(items, "new");
    expect(filtered[0].label).toBe("New repertoire");
    expect(scorePaletteItem(filtered[0], "new")).toBeGreaterThan(
      scorePaletteItem(items.find((item) => item.view === "dashboard"), "new"),
    );
  });

  it("ranks Start training for 'start'", () => {
    const filtered = filterPaletteItems(items, "start");
    expect(filtered[0].label).toBe("Start training");
  });

  it("finds a repertoire by name", () => {
    const filtered = filterPaletteItems(items, "najdorf");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].kind).toBe("repertoire");
    expect(filtered[0].repertoireId).toBe("r1");
  });

  it("renders listbox options with one selected active descendant target", () => {
    const rendered = renderPaletteItems(items.slice(0, 2), 1);
    expect(rendered).toContain('role="option"');
    expect(rendered).toContain('id="palette-option-1"');
    expect(rendered).toContain('aria-selected="true"');
    expect(rendered.match(/aria-selected="true"/g)).toHaveLength(1);
  });
});
