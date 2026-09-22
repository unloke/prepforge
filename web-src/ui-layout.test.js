import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const account = readFileSync(join(root, "controllers", "account.js"), "utf8");
const replayView = readFileSync(join(root, "views", "replay.js"), "utf8");
const settingsView = readFileSync(join(root, "views", "settings.js"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  return match ? match[1] : "";
}

describe("workspace chrome layout", () => {
  it("offers skip-to-content as the first keyboard entry into the workspace", () => {
    const bodyStart = html.indexOf("<body>");
    const skip = html.indexOf('data-testid="skip-link"');
    const header = html.indexOf('<header class="topbar">');
    expect(skip).toBeGreaterThan(bodyStart);
    expect(skip).toBeLessThan(header);
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('href="#workspace-main"');
    expect(html).toContain('id="workspace-main"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Skip to main content");
    expect(css).toContain(".skip-link");
    expect(css).toContain(".skip-link:focus-visible");
    const link = ruleBody(".skip-link");
    expect(link).toMatch(/position:\s*absolute/);
    expect(link).toMatch(/top:\s*-48px/);
    const focused = css.match(/\.skip-link:focus-visible\s*\{([^}]+)\}/)?.[1] || "";
    expect(focused).toMatch(/top:\s*8px/);
  });

  it("uses Settings as the only theme entry point", () => {
    expect(html).not.toContain('id="theme-toggle"');
    const settingsStart = html.indexOf('id="view-settings"');
    const settings = html.slice(settingsStart);
    expect(settings).toContain('id="settings-theme"');
    expect(app).not.toContain("theme-toggle");
    expect(app).not.toContain("nextTheme");
    expect(app).not.toContain("themeLabel");
  });

  it("keeps Teams in primary navigation and removes More", () => {
    expect(ruleBody(".tab")).toMatch(/display:\s*inline-flex/);
    expect(ruleBody(".tab")).toMatch(/align-items:\s*center/);
    expect(html).toContain('data-testid="nav-teams"');
    expect(html).not.toContain('id="more-nav"');
    expect(html).not.toContain('data-testid="nav-settings"');
    expect(account).toContain('data-action="settings"');
    expect(account).toContain("onOpenSettings();");
  });

  it("uses one mutually exclusive Build inspector", () => {
    expect(html).toContain('id="build-inspector"');
    expect(html).toContain('id="build-tool-explorer"');
    expect(html).toContain('id="build-tool-coverage"');
    expect(html).toContain('aria-controls="explorer-drawer"');
    expect(html).toContain('aria-controls="coverage-drawer"');
    expect(html).not.toContain('<summary>Opening explorer</summary>');
    expect(html).not.toContain('<summary>Coverage scan</summary>');
    expect(ruleBody(".inspector-panel")).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(".inspector-panel")).toMatch(/overflow-x:\s*hidden/);
    expect(ruleBody(".build-inspector")).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(".explorer-rows")).not.toMatch(/overflow-y/);
    expect(ruleBody(".explorer-rows")).not.toMatch(/max-height/);
    expect(ruleBody(".coverage-gaps")).not.toMatch(/overflow-y/);
    expect(ruleBody(".coverage-gaps")).not.toMatch(/max-height/);
    expect(ruleBody(".explorer-rows")).toMatch(/min-width:\s*0/);
    expect(ruleBody(".explorer-row")).toMatch(/min-width:\s*0/);
    expect(ruleBody(".explorer-row")).toMatch(/max-width:\s*100%/);
    expect(ruleBody(".coverage-gap-meta")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(app).toContain('setBuildInspector("explorer")');
    expect(app).toContain('setBuildInspector("coverage")');
    expect(app).toContain("panel.hidden = name !== active");
  });

  it("keeps the inspector chrome to one compact header row", () => {
    // Title + segmented control + info popover + scan action share one row;
    // the old multi-line chrome (separate label, explorer-head, scope line,
    // coverage head + standing hint) is gone.
    expect(html).toContain('id="inspector-dbs"');
    expect(html).toContain('id="inspector-info"');
    expect(app).toContain("inspector-info-pop");
    expect(html).not.toContain("build-inspector-label");
    expect(html).not.toContain("explorer-head");
    expect(html).not.toContain("explorer-scope");
    expect(html).not.toContain("coverage-head");
    expect(html).not.toContain("coverage-hint");
    expect(html).not.toContain("Master games — strong-player games");
    expect(html).not.toContain("How much of real human play");
    expect(app).toContain("inspectorScopeText");
    expect(app).toContain("onInspectorInfo");
    expect(app).toContain("inspector-info-pop");
    expect(css).toContain(".inspector-info-pop");
    const head = ruleBody(".build-inspector-head");
    expect(head).toMatch(/min-height:\s*34px/);
    const panel = ruleBody(".inspector-panel");
    expect(panel).toMatch(/max-height:\s*min\(44vh,\s*380px\)/);
  });

  it("keeps Coach height stable with a scrollable explanation and fixed footer", () => {
    const coach = ruleBody(".coach-prose");
    const maia = ruleBody(".coach-maia");
    const bookline = ruleBody(".coach-bookline");
    const card = ruleBody(".explain-card");
    const scroll = ruleBody(".coach-scroll");
    const footer = ruleBody(".coach-footer");
    const secondary = ruleBody(".coach-secondary");
    expect(html).toContain('<header class="explain-head">');
    expect(html).toContain('<div class="coach-scroll" id="coach-scroll">');
    expect(html).toContain('<div class="coach-footer" id="coach-footer">');
    expect(html).toContain('<div class="coach-secondary">');
    expect(card).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    expect(card).toMatch(/block-size:\s*var\(--coach-card-block-size\)/);
    expect(card).toMatch(/flex:\s*0\s+0\s+var\(--coach-card-block-size\)/);
    expect(card).toMatch(
      /--coach-card-block-size:\s*clamp\(136px,\s*calc\(var\(--study-h\)\s*\*\s*0\.23\),\s*170px\)/,
    );
    expect(scroll).toMatch(/min-height:\s*0/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/overflow-x:\s*hidden/);
    expect(footer).toMatch(/min-width:\s*0/);
    expect(footer).toMatch(/flex:\s*none/);
    expect(footer).toMatch(/overflow:\s*hidden/);
    expect(footer).not.toMatch(/overflow-y/);
    expect(secondary).not.toMatch(/margin-top:\s*auto/);
    expect(coach).toMatch(/overflow-wrap:\s*anywhere/);
    expect(maia).toMatch(/overflow-wrap:\s*anywhere/);
    expect(bookline).toMatch(/overflow-wrap:\s*anywhere/);
    expect(coach).not.toMatch(/line-clamp|overflow:\s*hidden/);
    // The footer is a fixed, non-scrolling row: no clamping anywhere — the
    // concise guidance content itself always fits beside the explanation scroll.
    expect(maia).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(bookline).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(ruleBody(".sidebar")).toMatch(/overflow-y:\s*auto/);
  });

  it("routes identity-changing actions through a one-time account chooser", () => {
    expect(app).toContain("resolveLichessAccountId(");
    expect(app).toContain("chooseLichessAccount(");
    expect(app).toContain("account_id");
    expect(app).toContain("— Primary");
    expect(app).toContain("is-primary");
    // My last game aggregates self server-side: no chooser, source shown quietly.
    expect(app).not.toMatch(/fetchMyLichessGame[\s\S]{0,400}?resolveLichessAccountId/);
    expect(app).toMatch(/fetchMyLichessGame[\s\S]*?source_account/);
    // Games compare aggregates self by default, narrowing only on explicit picks.
    expect(app).toMatch(/runLichessCompare[\s\S]*?gamesSourceAccountIds/);
    expect(app).toMatch(/runLichessCompare[\s\S]*?account_ids/);
    // Explorer keeps using a valid linked token internally — never a chooser.
    expect(app).not.toMatch(/refreshExplorerPanel[\s\S]*?chooseLichessAccount/);
    expect(css).toContain(".account-chooser-list");
    expect(css).toContain(".account-choice.is-primary");
    // The polish E2E hook is gated like the Scout hook (build flag + query
    // param); production pages never expose it outside installPolishE2eHook.
    expect(app).toContain("VITE_ENABLE_POLISH_E2E");
    expect(app).toContain("polish_e2e");
    expect(app).toContain("installPolishE2eHook");
    expect(app).toContain("if (window.__prepforgePolishE2e) return;");
    expect(app.match(/window\.__prepforgePolishE2e\s*=\s*\{/g) || []).toHaveLength(1);
    // The acceptance hook seeds promotion positions through the same
    // setPosition + legalMoves path production uses.
    expect(app).toContain("setBoardFen(boardName, fen)");
  });

  it("offers Self as the default games/scout source with compact chips", () => {
    expect(html).toContain('id="games-source-self"');
    expect(html).toContain('id="games-source-pick"');
    expect(html).toContain('id="scout-source-self"');
    expect(css).toContain(".source-chip");
    expect(css).toContain(".source-pick");
    expect(css).toContain(".replay-source");
    expect(app).toContain("gamesSourceAccountIds");
    expect(app).toContain("scoutSelfOn");
    // Per-game source metadata survives into the rendered rows.
    expect(replayView).toContain("source_account");
  });

  it("promotes through one shared picker on every interactive board", () => {
    expect(app).toContain("PROMOTION_PIECES");
    expect(app).toContain("function showPromotionPicker(");
    expect(app).toContain("function resolveBoardMove(");
    const hits = app.match(/resolveBoardMove\(\{/g) || [];
    // click + keyboard-square + drag paths all resolve through the picker.
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(css).toContain(".promotion-picker");
    expect(css).toContain(".promotion-option");
  });

  it("redesigns Settings on shared primitives with info popovers", () => {
    const settingsStart = html.indexOf('id="view-settings"');
    const settings = html.slice(settingsStart);
    // Shared primitives exist in markup and CSS.
    expect(settings).toContain('id="settings-theme-seg"');
    expect(settings).toContain('class="pf-switch"');
    expect(settings).toContain('class="pf-info"');
    expect(settings).toContain('class="pf-info-pop"');
    expect(settings).toContain('class="pf-row"');
    expect(css).toContain(".pf-switch");
    expect(css).toContain(".seg-btn");
    expect(css).toContain(".pf-info-pop");
    expect(css).toContain(".pf-row");
    // Segmented theme control carries the three modes; native select stays hidden.
    expect(settings).toContain('data-theme-value="system"');
    expect(settings).toContain('data-theme-value="light"');
    expect(settings).toContain('data-theme-value="dark"');
    // Booleans are switches, not native checkboxes.
    expect(settings).not.toContain('type="checkbox" id="settings-maia-auto"');
    expect(settings).not.toContain('type="checkbox" id="settings-brilliant-toggle"');
    expect(settings).toContain('id="settings-maia-auto" role="switch"');
    expect(settings).toContain('id="settings-brilliant-toggle" role="switch"');
    // Long helpers live in popovers, not standing paragraphs.
    expect(settings).not.toMatch(/<p class="muted[^"]*">Use a warm dark palette/);
    expect(settings).not.toMatch(/<p class="muted[^"]*">Higher is stronger but slower/);
    expect(settings).not.toMatch(/<p class="muted[^"]*">Sets how human the coach/);
    expect(settings).not.toMatch(/<p class="muted[^"]*">Adds a second pass/);
    expect(settings).not.toMatch(/<p class="muted[^"]*">My last game checks/);
    expect(settings).not.toMatch(/<p class="muted[^"]*">Stockfish runs in this browser/);
    expect(settings).toContain('id="engine-info-pop"');
    expect(settings).toContain('id="maia-info-pop"');
    expect(settings).toContain('id="strength-info-pop"');
    expect(settings).toContain('id="brilliant-info-pop"');
    expect(settings).toContain('id="connections-info-pop"');
    // Wiring: switches paint + segmented theme sync + info toggles.
    expect(settingsView).toContain("paintSwitch");
    expect(settingsView).toContain("bindSwitch");
    expect(settingsView).toContain("toggleInfoPop");
    expect(settingsView).toContain("settings-theme-seg");
  });

  it("renders menus and modals with theme tokens in both themes", () => {
    const menu = ruleBody(".context-menu");
    const menuBtn = ruleBody(".context-menu button");
    const menuBtnHover = css.match(/\.context-menu button:hover\s*\{([^}]+)\}/)?.[1] || "";
    const modal = ruleBody(".modal");
    expect(menu).toMatch(/background:\s*var\(--panel\)/);
    expect(menu).toMatch(/color:\s*var\(--text\)/);
    expect(menu).not.toMatch(/#ffffff|#1c1c1c/);
    expect(menuBtn).toMatch(/color:\s*var\(--text\)/);
    expect(menuBtn).not.toMatch(/#1c1c1c/);
    expect(menuBtnHover).toMatch(/background:\s*var\(--surface-hover\)/);
    expect(menuBtnHover).toMatch(/color:\s*var\(--text\)/);
    expect(modal).toMatch(/background:\s*var\(--panel\)/);
    expect(modal).toMatch(/color:\s*var\(--text\)/);
    expect(modal).not.toMatch(/#ffffff/);
    expect(css).toContain(".account-menu button[data-action=\"signout\"]:focus-visible");
    expect(css).toContain(".context-menu button:focus-visible");
    expect(css).toContain(".context-menu button:disabled");
  });

  it("expands hit areas on coarse pointers without changing desktop layout", () => {
    expect(css).toContain("@media (pointer: coarse)");
    for (const selector of [
      ".tab::after",
      ".train-mode::after",
      ".source-chip::after",
      ".explorer-row::after",
      ".engine-step::after",
      ".pf-switch::after",
      ".rep-menu-btn::after",
      ".pf-info::after",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("min-width: 44px");
    expect(css).not.toMatch(/\.square::after/);
  });
});
