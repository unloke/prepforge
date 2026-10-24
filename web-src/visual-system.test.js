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
  "--surface-3",
  "--dur-fast",
  "--dur",
  "--dur-slow",
  "--ease-out",
  "--ease-emphasis",
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

  // Every control the app draws shares one radius. Selects and the segmented
  // control used to carry their own (4px in a dialog, 7px on the track, 5px on
  // its option), so the same control read as three different shapes.
  it("draws every control on the shared control radius", () => {
    expect(ruleBody(".btn")).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(ruleBody(".seg")).toMatch(/border-radius:\s*calc\(var\(--radius\) \+ 2px\)/);
    expect(ruleBody(".seg-btn")).toMatch(/border-radius:\s*var\(--radius\)/);
    // One field rule gives every select, text input and textarea the app's box;
    // the select only adds its own chevron and cursor on top of it.
    const fieldRule = css.match(/(?:^|\n)select,\ninput:not\([^)]*\),\ntextarea \{([^}]+)\}/)?.[1] || "";
    expect(fieldRule).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(fieldRule).toMatch(/height:\s*var\(--control-h\)/);
    expect(fieldRule).toMatch(/appearance:\s*none/);
    const selectRule = css.match(/(?:^|\n)select \{\n  padding-right:[^}]+\}/)?.[0] || "";
    expect(selectRule).toMatch(/background-image:\s*var\(--select-chevron\)/);
  });

  // The keyboard ring marks the focused control; it must not reshape it.
  it("the focus ring leaves the control's own radius alone", () => {
    const ring = css.match(/(?:^|\n):focus-visible \{([^}]+)\}/)?.[1] || "";
    expect(ring).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(ring).not.toMatch(/border-radius/);
  });

  // A row's action is the shared button at the shared height. Train's rows set
  // their own 34px and "I'm Feeling Lucky" sat as bare text beside an outlined
  // Play: a text button next to a boxed one reads as a caption, not a control.
  it("puts a row's primary on the shared button height", () => {
    const train = readFileSync(join(root, "train-shell.css"), "utf8");
    const go = /(?:^|\n)\.train-row-go \{([^}]+)\}/.exec(train)?.[1] || "";
    expect(go).not.toMatch(/height:/);
    expect(go).toMatch(/min-width:\s*92px/);
  });

  // phone.css hides `.page-head` at every width; only its own media query brings
  // it back. Library and Teams were therefore nameless on a wide screen, and the
  // inspector failed them for having no h1 at 1440.
  it("names every page on a wide screen, not just the ones with a local rule", () => {
    const desktop = css.match(
      /@media \(min-width: 761px\) \{([^}]*\{[^}]*\}[^}]*)*?\n\}/,
    )?.[0] || "";
    const head = /\.workspace \.page-head \{([^}]+)\}/.exec(desktop)?.[1] || "";
    expect(head).toMatch(/display:\s*flex/);
    const title = /\.workspace \.page-head h1 \{([^}]+)\}/.exec(desktop)?.[1] || "";
    expect(title).toMatch(/font-size:\s*26px/);
    // The head's icon mirrors a control the desktop card head already shows in
    // words: it would be a second "New repertoire" on the same screen.
    expect(desktop).toMatch(/\.page-head \.page-head-btn \{ display: none; \}/);
    for (const view of ["dashboard", "teams"]) {
      const slice = html.slice(html.indexOf(`id="view-${view}"`));
      expect(slice.slice(0, slice.indexOf("</section>"))).toContain('class="page-head"');
    }
  });

  // A button answers the pointer with contrast, not weight: the edge steps to
  // the muted ink as the fill steps to the page tone. The ghost has no edge to
  // darken, so it must keep its border transparent instead of growing one.
  it("answers a hover with a darker edge, and a ghost with none", () => {
    const hover = /\.btn:hover:not\(:disabled, \.is-coming-soon\) \{([^}]+)\}/.exec(css)?.[1] || "";
    expect(hover).toMatch(/border-color:\s*var\(--muted\)/);
    expect(hover).toMatch(/background:\s*var\(--surface-3\)/);
    const ghost = /\.btn\.ghost:hover:not\(:disabled, \.is-coming-soon\) \{([^}]+)\}/.exec(css)?.[1] || "";
    expect(ghost).toMatch(/border-color:\s*transparent/);
  });

  it("locks the Train coach height so Maia copy cannot shove the board", () => {
    expect(css).toContain(".train-coach");
    expect(ruleBody(".train-coach")).toMatch(/display:\s*grid/);
    expect(ruleBody(".train-coach-title")).toMatch(/-webkit-line-clamp:\s*1/);
    const sub = ruleBody(".train-coach-sub");
    expect(sub).toMatch(/-webkit-line-clamp:\s*2/);
    // The blitz clock is absolutely positioned over the board's edge: hiding it never reflows.
    expect(ruleBody(".blitz-bar")).toMatch(/position:\s*absolute/);
    // Hidden chrome (blitz clock, turn badge, sync chip…) relies on the global [hidden] rule.
    expect(css).toMatch(/\[hidden\] \{ display: none !important; \}/);
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
    expect(html).toContain('id="start-play"');
    expect(html).toContain('id="feeling-lucky"');
    expect(html).toContain("I'm Feeling Lucky");
    expect(html).toContain('id="train-play-color"');
    expect(html).toContain('id="play-takeback"');
    expect(html).toContain('id="play-resign"');
    expect(html).toContain('id="play-analyze"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="palette-results"');
    expect(html).toContain('aria-label="Notifications"');
    // Dialogs are native: showModal does the inert page and the focus trap.
    expect(app).toContain("dialog.showModal()");
    expect(app).not.toContain("child.inert = true");
  });

  it("Train Home is three rows in the order of the daily job: Due queue, Rehearse, Practice", () => {
    const home = html.slice(html.indexOf('id="train-home"'), html.indexOf('id="train-progress-panel"'));
    const rows = [...home.matchAll(/<section class="train-row" data-row="([a-z_]+)">/g)].map((m) => m[1]);
    expect(rows).toEqual(["smart", "all_lines", "play"]);
    // One primary on Home: the due queue's Start leads; Rehearse and Practice
    // keep the same place at the card's top right as outlined actions.
    expect(home.match(/class="btn primary/g)).toHaveLength(1);
    expect(home).toMatch(/class="btn primary train-row-go" id="start-train"/);
    expect(home).toMatch(/class="btn train-row-go" id="start-rehearse"/);
    expect(home).toMatch(/class="btn train-row-go" id="start-play"/);
    // No mode tabs, no second History.
    expect(html).not.toContain('id="train-modes"');
    expect(html.match(/data-train-history/g)).toHaveLength(1);
  });

  it("keeps the Practice row's order: opponent, its repertoires, then your color", () => {
    const row = html.slice(html.indexOf('data-row="play"'), html.indexOf('id="train-progress-panel"'));
    const book = row.indexOf('id="train-play-book"');
    const reps = row.indexOf('id="train-play-reps"');
    const color = row.indexOf('id="train-play-color"');
    expect(book).toBeGreaterThanOrEqual(0);
    expect(reps).toBeGreaterThan(book);
    expect(color).toBeGreaterThan(reps);
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
  // The board colour themes are overrides chosen by a pref, not the default
  // palette, so they stay out of the dark block this test reads.
  const dark = tokensOf(css.slice(darkStart, css.indexOf("/* ---- Board colour themes")));

  const TEXT_TOKENS = ["--label", "--warn-text", "--good-text", "--brilliant-text", "--accent-text"];

  for (const [themeName, tokens] of [["light", light], ["dark", dark]]) {
    it(`${themeName} explorer labels meet small-text contrast`, () => {
      for (const side of ["white", "draw", "black"]) {
        const ink = side === "black" ? "--on-accent" : `--explorer-${side}-ink`;
        expect(contrast(tokens[ink], tokens[`--explorer-${side}`])).toBeGreaterThanOrEqual(4.5);
      }
    });
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

describe("accent presets meet WCAG AA in both themes", () => {
  // The user picks the accent (product.md). A preset may not weaken the
  // contrast the default blue already guarantees: its text-safe token clears
  // 4.5:1 on every surface it can sit on, and the ink on its fill does too.
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
  function block(selector) {
    const start = css.indexOf(selector);
    expect(start, `${selector} must exist`).toBeGreaterThan(-1);
    const open = css.indexOf("{", start);
    const out = {};
    for (const m of css.slice(open, css.indexOf("}", open)).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
      out[m[1]] = m[2];
    }
    return out;
  }
  // The base surfaces of a theme: the :root block above the dark one for
  // light, the dark block itself for dark.
  function baseTokens(theme) {
    const darkStart = css.indexOf(':root[data-theme="dark"]');
    return theme === "dark" ? block(':root[data-theme="dark"]') : block(":root");
  }

  const presets = [...css.matchAll(/:root(\[data-accent="([a-z]+)"\])/g)].map((m) => m[2]);
  // Blue is the default and declares no override: it is the light/dark base
  // tokens, checked by the guards above.
  expect([...new Set(presets)]).toEqual(["orange"]);

  for (const name of [...new Set(presets)]) {
    for (const [theme, selector] of [
      ["light", `:root[data-accent="${name}"]`],
      ["dark", `:root[data-theme="dark"][data-accent="${name}"]`],
    ]) {
      it(`${theme} ${name}: the accent text token clears 4.5:1 on every surface`, () => {
        const accent = block(selector);
        const base = baseTokens(theme);
        for (const token of ["--accent", "--accent-soft", "--accent-line", "--accent-strong", "--accent-text", "--accent-ink"]) {
          expect(accent[token], `${selector} must declare ${token}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
        for (const bgName of ["--panel", "--panel-soft", "--bg", "--accent-soft"]) {
          const bg = bgName === "--accent-soft" ? accent[bgName] : base[bgName];
          expect(contrast(accent["--accent-text"], bg), `${theme} ${name} --accent-text on ${bgName}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(accent["--accent-ink"], accent["--accent"]), `${theme} ${name} ink on accent`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("status semantics", () => {
  it("uses explicit severity at error boundaries instead of message matching", () => {
    expect(app).toContain('function setStatus(message, { severity = "info" } = {})');
    expect(app).toContain('function setStatusError(message)');
    expect(app).toContain('setStatus(message, { severity: "error" })');
    expect(app).not.toContain("const isError = /(?:error|failed|unavailable");
    expect(app).toContain("notices.status(text === \"Ready\" ? \"\" : text, { tone: severity })");
    expect(css).toContain('.notice[data-tone="success"]');
    expect(css).toContain('.notice[data-tone="warning"]');
    expect(css).toContain('.notice[data-tone="error"]');
  });
});

describe("accessible names", () => {
  it("gives every icon-only button a name, and matches the label to the placeholder", () => {
    for (const tag of html.match(/<button\b[^>]*>/g) || []) {
      if (!/\bicon\b/.test(tag) || />[^<]*[A-Za-z]/.test(tag)) continue;
      expect(tag, `icon-only button without a name: ${tag}`).toMatch(/aria-label="/);
    }
    // The Teams search's accessible name must be what the placeholder says, so a
    // screen-reader user and a sighted user search for the same thing.
    const search = /<input id="teams-search"[^>]*>/.exec(html)[0];
    expect(/aria-label="([^"]*)"/.exec(search)[1]).toBe(
      /placeholder="([^"]*)"/.exec(search)[1],
    );
  });
});
