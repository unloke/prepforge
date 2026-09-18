import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");

const REQUIRED_TOKENS = [
  "--bg",
  "--panel",
  "--panel-soft",
  "--line",
  "--line-soft",
  "--line-strong",
  "--text",
  "--muted",
  "--label",
  "--surface-hover",
  "--accent",
  "--accent-soft",
  "--accent-line",
  "--accent-strong",
  "--danger",
  "--warn",
  "--good",
  "--radius",
  "--radius-card",
  "--control-h",
  "--hover",
  "--btn-hover",
  "--on-accent",
  "--board-frame",
  "--danger-soft",
];

const CHROME_SELECTORS = [
  ".btn",
  ".card",
  ".card-head",
  ".board-bar",
  ".empty-state",
  ".hint",
  ".tab",
  ".engine-banner",
  ".palette",
  ".san-buffer",
];

const VIEWS = [
  "dashboard",
  "analyze",
  "build",
  "train",
  "replay",
  "teams",
  "settings",
];

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  return match ? match[1] : "";
}

describe("visual system tokens", () => {
  it("declares the shared token set on :root", () => {
    expect(css.startsWith(":root")).toBe(true);
    for (const token of REQUIRED_TOKENS) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("chrome classes consume tokens instead of one-off hex", () => {
    for (const selector of CHROME_SELECTORS) {
      const body = ruleBody(selector);
      expect(body, `${selector} should exist`).not.toBe("");
      expect(body, `${selector} should use var(--*)`).toMatch(/var\(--/);
      expect(body, `${selector} should not hard-code hex`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it("locks the Train banner height so Maia copy cannot shove the board", () => {
    const banner = ruleBody(".train-banner");
    expect(banner).toMatch(/max-height:\s*72px/);
    expect(banner).toMatch(/overflow:\s*hidden/);
    const sub = ruleBody(".train-banner-sub");
    expect(sub).toMatch(/-webkit-line-clamp:\s*2/);
    const blitzHidden = ruleBody(".train-blitz-bar[hidden]");
    expect(blitzHidden).toMatch(/visibility:\s*hidden/);
    expect(blitzHidden).toMatch(/display:\s*block/);
    const badgeHidden = ruleBody(".train-turn-badge[hidden]");
    expect(badgeHidden).toMatch(/display:\s*none/);
    const ibHidden = ruleBody(".ib[hidden]");
    expect(ibHidden).toMatch(/display:\s*none/);
    const syncHidden = ruleBody(".build-sync[hidden]");
    expect(syncHidden).toMatch(/display:\s*none/);
    const engineHidden = ruleBody(".engine-banner[hidden]");
    expect(engineHidden).toMatch(/display:\s*none/);
    const todayHidden = ruleBody(".today-card[hidden]");
    expect(todayHidden).toMatch(/display:\s*none/);
    const coverage = ruleBody(".coverage-gaps");
    expect(coverage).toMatch(/max-height:\s*240px/);
  });
});

describe("seven views share chrome families", () => {
  it("every workspace view is present", () => {
    for (const view of VIEWS) {
      expect(html).toContain(`id="view-${view}"`);
      expect(html).toContain(`data-view="${view}"`);
    }
  });

  it("study tabs use the same board-bar + sidebar rhythm", () => {
    for (const view of ["analyze", "build", "train"]) {
      const start = html.indexOf(`id="view-${view}"`);
      const next = VIEWS.indexOf(view) + 1;
      const end =
        next < VIEWS.length ? html.indexOf(`id="view-${VIEWS[next]}"`) : html.length;
      const slice = html.slice(start, end);
      expect(slice).toContain('class="study"');
      expect(slice).toContain('class="board-bar"');
      expect(slice).toContain("sidebar");
      expect(slice).toContain("san-buffer");
    }
  });

  it("list tabs use the same card / card-head / hint pattern", () => {
    for (const view of ["dashboard", "replay", "teams", "settings"]) {
      const start = html.indexOf(`id="view-${view}"`);
      const next = VIEWS.indexOf(view) + 1;
      const end =
        next < VIEWS.length ? html.indexOf(`id="view-${VIEWS[next]}"`) : html.length;
      const slice = html.slice(start, end);
      expect(slice).toMatch(/class="[^"]*\bcard\b/);
      expect(slice).toContain("card-head");
      expect(slice).toMatch(/class="[^"]*hint/);
    }
  });

  it("ships the engine banner, command palette, and SAN buffers", () => {
    expect(html).toContain('id="analyze-engine-banner"');
    expect(html).toContain('id="build-engine-banner"');
    expect(html).toContain('id="command-palette"');
    expect(html).toContain('id="open-palette"');
    expect(html).toContain('id="analysis-san"');
    expect(html).toContain('id="build-san"');
    expect(html).toContain('id="train-san"');
    expect(html).toContain('id="train-fresh"');
    expect(html).toContain('id="start-play"');
    expect(html).toContain('id="feeling-lucky"');
    expect(html).toContain("I'm Feeling Lucky");
    expect(html).toContain("Lichess explorer");
    expect(html).toContain('id="train-play-color"');
    expect(html).toContain('id="play-takeback"');
    expect(html).toContain('id="play-resign"');
    expect(html).toContain('id="play-analyze"');
    expect(html).toContain("My repertoire");
  });

  it("keeps the Train setup order: modes, repertoire picker, blitz, SRS start", () => {
    const setup = html.slice(html.indexOf('id="train-modes"'));
    const modes = setup.indexOf('id="train-modes"');
    const picker = setup.indexOf('id="train-srs-picker"');
    const blitz = setup.indexOf('id="train-blitz-row"');
    const srs = setup.indexOf('id="train-srs-start"');
    expect(modes).toBeGreaterThanOrEqual(0);
    expect(picker).toBeGreaterThan(modes);
    expect(blitz).toBeGreaterThan(picker);
    expect(srs).toBeGreaterThan(blitz);
    const pickerBody = setup.slice(picker, blitz);
    expect(pickerBody).toContain('id="train-repertoire-select"');
    expect(ruleBody("#train-srs-picker")).toMatch(/display:\s*grid/);
    expect(ruleBody("#train-srs-picker[hidden]")).toMatch(/display:\s*none/);
  });

  it("keeps Play setup order: opponent book, repertoires, then your color", () => {
    const setup = html.slice(html.indexOf('id="train-play-setup"'));
    const book = setup.indexOf('id="train-play-book"');
    const reps = setup.indexOf('id="train-play-repertoire-picker"');
    const color = setup.indexOf('id="train-play-color-label"');
    expect(book).toBeGreaterThanOrEqual(0);
    expect(reps).toBeGreaterThan(book);
    expect(color).toBeGreaterThan(reps);
    expect(setup).toContain('id="train-repertoire-select-all"');
    expect(setup).toContain('id="train-repertoire-options"');
  });
});

describe("status semantics", () => {
  it("uses explicit severity at error boundaries instead of message matching", () => {
    expect(app).toContain('function setStatus(message, { severity = "info" } = {})');
    expect(app).toContain('function setStatusError(message)');
    expect(app).toContain('setStatus(message, { severity: "error" })');
    expect(app).not.toContain("const isError = /(?:error|failed|unavailable");
    expect(html).toContain('data-severity="info"');
  });
});
