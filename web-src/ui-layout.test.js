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

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  return match ? match[1] : "";
}

describe("workspace chrome layout", () => {
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
    expect(ruleBody(".coverage-hint")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ruleBody(".coverage-gap-meta")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(app).toContain('setBuildInspector("explorer")');
    expect(app).toContain('setBuildInspector("coverage")');
    expect(app).toContain("panel.hidden = name !== active");
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
});
