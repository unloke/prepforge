import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appSource } from "./test-app-source.js";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = appSource();

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
  ".promotion-picker",
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

  it("locks the Train coach height so Maia copy cannot shove the board", () => {
    expect(css).toContain(".train-coach");
    expect(ruleBody(".train-coach")).toMatch(/display:\s*grid/);
    expect(ruleBody(".train-coach-title")).toMatch(/-webkit-line-clamp:\s*1/);
    const sub = ruleBody(".train-coach-sub");
    expect(sub).toMatch(/-webkit-line-clamp:\s*2/);
    // The blitz clock is absolutely positioned over the board's edge: hiding it never reflows.
    expect(ruleBody(".blitz-bar")).toMatch(/position:\s*absolute/);
    expect(ruleBody(".blitz-bar[hidden]")).toMatch(/display:\s*none/);
    const badgeHidden = ruleBody(".train-turn-badge[hidden]");
    expect(badgeHidden).toMatch(/display:\s*none/);
    const ibHidden = ruleBody(".ib[hidden]");
    expect(ibHidden).toMatch(/display:\s*none/);
    const syncHidden = ruleBody(".build-sync[hidden]");
    expect(syncHidden).toMatch(/display:\s*none/);
    const engineHidden = ruleBody(".engine-banner[hidden]");
    expect(engineHidden).toMatch(/display:\s*none/);
    const todayHidden = ruleBody(".today[hidden]");
    expect(todayHidden).toMatch(/display:\s*none/);
    const coverage = ruleBody(".coverage-gaps");
    expect(coverage).not.toMatch(/overflow-y/);
    expect(coverage).not.toMatch(/max-height/);
    expect(ruleBody(".dock-body")).toMatch(/overflow:\s*auto/);
  });
});

describe("seven views share chrome families", () => {
  it("every workspace view is present", () => {
    for (const view of VIEWS) {
      expect(html).toContain(`id="view-${view}"`);
      if (view !== "settings") expect(html).toContain(`data-view="${view}"`);
    }
    expect(readFileSync(join(root, "controllers", "account.js"), "utf8"))
      .toContain('data-action="settings"');
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
      expect(slice).toContain("board-label");
    }
  });

  // UI copy contract (ui-comfort-audit-2026-09-26): each view keeps at most one
  // short hint line under its heading; long explainers live behind info/help
  // interactions, and empty states carry their own CTA instead of prose.
  it("list tabs keep a card, a heading, and at most one short hint", () => {
    for (const view of ["dashboard", "teams", "settings"]) {
      const start = html.indexOf(`id="view-${view}"`);
      const next = VIEWS.indexOf(view) + 1;
      const end =
        next < VIEWS.length ? html.indexOf(`id="view-${VIEWS[next]}"`) : html.length;
      const slice = html.slice(start, end);
      expect(slice).toMatch(/class="[^"]*\bcard\b/);
      // Settings cards carry their heading directly (h2), the others a .card-head.
      expect(slice).toContain(view === "settings" ? "<h2>" : "card-head");
      const hints = slice.match(/<p class="[^"]*\bhint\b[^"]*"[^>]*>[\s\S]*?<\/p>/g) || [];
      expect(hints.length).toBeLessThanOrEqual(1);
      for (const hint of hints) {
        const text = hint
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-zA-Z]+;|&#\d+;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        expect(text.length).toBeLessThan(90);
      }
    }
    const replay = html.slice(html.indexOf('id="view-replay"'), html.indexOf('id="view-teams"'));
    // Games and Scout are the flat prototype toolbar (no page card / heading) over their workspace.
    const games = replay.slice(replay.indexOf('<section class="games-panel"'), replay.indexOf('<section class="replay-card-scout'));
    expect(games).toContain('class="toolbar"');
    expect(games).not.toContain("research-heading");
    expect(games.indexOf('class="toolbar"')).toBeLessThan(games.indexOf('id="replay-results"'));
    const scout = replay.slice(replay.indexOf('<section class="replay-card-scout'));
    expect(scout).toContain('class="toolbar"');
    expect(scout).not.toContain("research-heading");
    expect(scout).not.toContain("research-controls");
    // Toolbar → grid (main column: profile, results; side: line detail).
    expect(scout.indexOf('class="toolbar"')).toBeLessThan(scout.indexOf('class="scout-grid"'));
    expect(scout.indexOf('id="scout-profile"')).toBeLessThan(scout.indexOf('id="scout-results"'));
    expect(scout.indexOf('id="scout-results"')).toBeLessThan(scout.indexOf('id="scout-side"'));
  });

  it("ships the engine banner, command palette, and promotion picker styles", () => {
    expect(html).toContain('id="analyze-engine-banner"');
    expect(html).toContain('id="build-engine-banner"');
    expect(html).toContain('id="command-palette"');
    expect(html).toContain('id="open-palette"');
    expect(app).toContain("showPromotionPicker");
    expect(app).toContain("PROMOTION_PIECES");
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
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="palette-results"');
    expect(html).toContain('aria-label="Notifications"');
    expect(app).toContain("function activateModal");
    expect(app).toContain("child.inert = true");
    expect(app).toContain('event.key !== "Tab"');
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
    expect(css).toContain(".tcard .field[hidden]");
    expect(ruleBody(".tcard .field")).toMatch(/gap:\s*4px/);
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

describe("axe baseline contrast guard", () => {
  // The E2E axe run (tests/e2e/axe_baseline.mjs) is the full-page check; this
  // pins the first-party token pairs it caught so a theme tweak cannot regress
  // them without turning this red. Ratios are WCAG AA for normal text (4.5:1).
  function luminance(hex) {
    const c = hex.replace("#", "");
    const f = (i) => {
      const v = parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
  }
  function contrast(a, b) {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function tokenValue(name) {
    const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    expect(match, `${name} must be a hex token`).not.toBeNull();
    return match[1];
  }

  it("keeps small caps labels readable on panel surfaces", () => {
    expect(contrast(tokenValue("--muted"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the active tab label readable on its tint", () => {
    expect(contrast(tokenValue("--accent-strong"), tokenValue("--accent-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps primary buttons readable (accent-ink on the one accent)", () => {
    expect(contrast(tokenValue("--accent-ink"), tokenValue("--accent"))).toBeGreaterThanOrEqual(4.5);
    expect(ruleBody(".btn.primary")).toMatch(/background:\s*var\(--accent\)/);
    expect(ruleBody(".btn.primary")).toMatch(/color:\s*var\(--accent-ink\)/);
  });

  it("keeps palette hints readable", () => {
    expect(ruleBody(".palette-item-hint")).toMatch(/color:\s*var\(--muted\)/);
  });
});

describe("semantic text colors meet WCAG AA", () => {
  // The semantic colours are mixed-use: --warn/--good/--brilliant/--accent fill
  // charts, dots, badges, and borders AND paint text. Text uses the *-text
  // variants (AA 4.5:1); fills keep the original hues. This guard pins the text
  // variants against every surface they actually sit on — panel family plus each
  // colour's own tinted badge/banner background — in BOTH themes.
  function luminance(hex) {
    const c = hex.replace("#", "");
    const f = (i) => {
      const v = parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
  }
  function contrast(a, b) {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // Equivalent of `color-mix(in srgb, FGA, BGA)` used by the badge/banner rules.
  function mix(fg, bg, alpha) {
    const h = fg.replace("#", "");
    const b = bg.replace("#", "");
    let out = "#";
    for (let i = 0; i < 3; i += 1) {
      const a = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      const c = parseInt(b.slice(i * 2, i * 2 + 2), 16);
      out += Math.round(a * alpha + c * (1 - alpha)).toString(16).padStart(2, "0");
    }
    return out;
  }
  const darkStart = css.indexOf(':root[data-theme="dark"]');
  expect(darkStart).toBeGreaterThan(0);
  function tokensOf(block) {
    const out = {};
    for (const m of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
      out[m[1]] = m[2];
    }
    return out;
  }
  const light = tokensOf(css.slice(0, darkStart));
  const dark = tokensOf(css.slice(darkStart));

  const TEXT_TOKENS = ["--label", "--warn-text", "--good-text", "--brilliant-text", "--accent-text"];

  for (const [themeName, tokens] of [["light", light], ["dark", dark]]) {
    it(`${themeName} board coordinates meet small-text contrast`, () => {
      for (const square of ["light", "dark"]) {
        expect(contrast(tokens[`--coord-on-${square}`], tokens[`--square-${square}`])).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${themeName} theme: text tokens clear 4.5:1 on panel-family surfaces`, () => {
      for (const name of TEXT_TOKENS) {
        const fg = tokens[name];
        expect(fg, `${themeName} ${name} must exist as a hex token`).toBeTruthy();
        for (const bgName of ["--panel", "--panel-soft", "--bg"]) {
          expect(
            contrast(fg, tokens[bgName]),
            `${themeName} ${name} on ${bgName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${themeName} theme: text tokens clear 4.5:1 on their tinted backgrounds`, () => {
      const panel = tokens["--panel"];
      // Tinted surfaces mirror the badge/banner rules (color-mix 8-12%).
      const tinted = {
        "--warn-text": mix(tokens["--warn"], panel, 0.12),
        "--good-text": mix(tokens["--good"], panel, 0.12),
        "--brilliant-text": mix(tokens["--brilliant"], panel, 0.12),
        "--accent-text": tokens["--accent-soft"],
      };
      for (const [name, bg] of Object.entries(tinted)) {
        expect(
          contrast(tokens[name], bg),
          `${themeName} ${name} on its tinted background`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("text rules use the text variants, never the fill tokens", () => {
    // Fills/borders/backgrounds legitimately use the base tokens; only the
    // text property is constrained. `[^-]` keeps border-color,
    // background-color, text-decoration-color, and accent-color out of it.
    expect(css).not.toMatch(
      /[^-]color:\s*var\(--(warn|good|brilliant|accent)\)/,
    );
  });
});

describe("status semantics", () => {
  it("uses explicit severity at error boundaries instead of message matching", () => {
    expect(app).toContain('function setStatus(message, { severity = "info" } = {})');
    expect(app).toContain('function setStatusError(message)');
    expect(app).toContain('setStatus(message, { severity: "error" })');
    expect(app).not.toContain("const isError = /(?:error|failed|unavailable");
    expect(html).toContain('data-severity="info"');
    expect(css).toContain('.status[data-severity="success"]');
    expect(css).toContain('.status[data-severity="warning"]');
  });
});
