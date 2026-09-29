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
const replayCss = readFileSync(join(root, "views", "replay.css"), "utf8");
const analyzeCss = readFileSync(join(root, "views", "analyze-chart.css"), "utf8");
const settingsView = readFileSync(join(root, "views", "settings.js"), "utf8");
const scoutView = readFileSync(join(root, "views", "scout.js"), "utf8");
const composer = readFileSync(join(root, "views", "shared", "source-composer.js"), "utf8");

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

  it("sizes study boards off the viewport with a full-width workspace", () => {
    expect(css).toContain(".study");
    expect(css).toMatch(/\.study\s*\{[^}]*--board-size:\s*min\(/s);
    expect(css).toMatch(/grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/grid-template-columns:\s*min\(\s*calc\(var\(--study-h\)/);
    expect(css).toContain(".board-area");
    expect(css).toMatch(/\.board-area\s*\{[^}]*width:\s*var\(--board-size\)/s);
    expect(css).toContain(".board-stack");
    expect(html).toContain('id="analysis-board"');
    expect(html).toContain('id="train-board"');
    expect(css).toMatch(/#analyze-sidebar\s*\{[^}]*max-height:\s*var\(--study-h\)[^}]*overflow:\s*hidden/);
  });

  it("keeps the Train coach in the sidebar with the board starting at the top", () => {
    const trainStart = html.indexOf('id="view-train"');
    const train = html.slice(trainStart);
    expect(train).toContain('id="train-banner"');
    expect(train).toContain('class="coach-banner train-coach"');
    expect(train).toContain('id="train-banner-title"');
    expect(train).toContain('id="train-banner-sub"');
    expect(train).toContain('id="train-turn-badge"');
    const boardArea = train.slice(train.indexOf('class="board-area"'), train.indexOf('id="train-board-label"'));
    expect(boardArea).not.toContain('id="train-banner"');
    expect(boardArea).toContain('id="train-board"');
    const sidebar = train.slice(train.indexOf('train-sidebar'));
    expect(sidebar.indexOf('id="train-banner"')).toBeGreaterThanOrEqual(0);
    // The blitz clock overlays the board's top edge (never in flow), so the board cannot move.
    expect(boardArea).toContain('id="train-blitz"');
    expect(ruleBody(".blitz-bar")).toMatch(/position:\s*absolute/);
    expect(css).toContain(".train-coach-title");
    expect(css).toContain(".train-coach-sub");
  });

  it("overlays topbar status left of Ctrl K without reserving layout width", () => {
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));
    const slot = header.indexOf('id="topbar-status-slot"');
    const status = header.indexOf('id="app-status"');
    const palette = header.indexOf('id="open-palette"');
    const account = header.indexOf('id="account-chip"');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(slot);
    expect(palette).toBeGreaterThan(status);
    expect(account).toBeGreaterThan(palette);
    expect(header).toContain('id="app-status-close"');
    expect(css).toContain(".topbar-status-slot");
    expect(css).toMatch(/\.topbar-status-slot\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.topbar-status-slot\s*\{[^}]*right:\s*calc\(100% \+ 12px\)/s);
    expect(css).toMatch(/\.topbar-status-slot \.status:not\(\[hidden\]\)\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toContain(".status-close");
    expect(app).toContain('function setStatus(message, { severity = "info" } = {})');
    expect(app).toContain('getElementById("app-status-close")');
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

  it("docks one single-select Build inspector (Explorer / Coverage / Engine)", () => {
    expect(html).toContain('id="build-inspector"');
    expect(html).toContain('class="dock"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="build-tool-explorer"');
    expect(html).toContain('id="build-tool-coverage"');
    expect(html).toContain('id="build-tool-engine"');
    expect(html).toContain('aria-controls="explorer-drawer"');
    expect(html).toContain('aria-controls="coverage-drawer"');
    expect(html).toContain('aria-controls="engine-drawer"');
    expect(html).not.toContain('<summary>Opening explorer</summary>');
    expect(html).not.toContain('<summary>Coverage scan</summary>');
    expect(html).not.toContain(' id="open-engine-widget-build"');
    expect(html).not.toContain('build-inspector-head');
    expect(ruleBody(".dock-body")).toMatch(/overflow:\s*auto/);
    expect(ruleBody(".explorer-rows")).not.toMatch(/overflow-y/);
    expect(ruleBody(".explorer-rows")).not.toMatch(/max-height/);
    expect(ruleBody(".coverage-gaps")).not.toMatch(/overflow-y/);
    expect(ruleBody(".coverage-gaps")).not.toMatch(/max-height/);
    expect(ruleBody(".explorer-rows")).toMatch(/min-width:\s*0/);
    expect(ruleBody(".explorer-row")).toMatch(/min-width:\s*0/);
    expect(ruleBody(".explorer-row")).toMatch(/max-width:\s*100%/);
    expect(ruleBody(".coverage-gap-meta")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(app).toContain('setBuildInspector("explorer")');
    expect(app).toContain("panels[name].hidden = !on");
    expect(app).toContain("function dockEngine()");
    expect(app).toContain("function undockEngine()");
    expect(ruleBody(".engine-window.is-docked")).toMatch(/position:\s*static/);
  });

  it("keeps the dock chrome to one tools row above the panel", () => {
    // Database seg + opening + score chip + info popover + scan share one row;
    // the old multi-line chrome (separate label, explorer-head, scope line,
    // coverage head + standing hint) is gone.
    expect(html).toContain('id="build-dock-tools"');
    expect(html).toContain('id="inspector-dbs"');
    expect(html).toContain('id="inspector-info"');
    expect(html).not.toContain("build-inspector-label");
    expect(html).not.toContain("explorer-scope");
    expect(html).not.toContain("coverage-head");
    expect(html).not.toContain("coverage-hint");
    expect(html).not.toContain("Master games — strong-player games");
    expect(html).not.toContain("How much of real human play");
    expect(app).toContain("inspectorScopeText");
    expect(app).toContain("onInspectorInfo");
    expect(app).toContain("inspector-info-pop");
    expect(css).toContain(".inspector-info-pop");
    expect(ruleBody(".dock")).toMatch(/flex:\s*0 0 clamp\(210px,\s*40%,\s*330px\)/);
  });

  it("composes Analyze as one panel: game head, coach card, results, drawers", () => {
    const view = html.slice(html.indexOf('id="view-analyze"'), html.indexOf('id="view-build"'));
    const rule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return analyzeCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
    };
    expect(view).toContain('<aside class="sidebar panel" id="analyze-sidebar">');
    expect(view).toContain('id="analysis-game-title"');
    expect(view).toContain('<section class="coach-card" id="analysis-explain"');
    expect(view).toContain('<header class="cc-head">');
    expect(view).toContain('class="moves-grid" id="analysis-moves"');
    // The eval bar sits on the board's left, before the board itself.
    expect(view.indexOf('id="analysis-evalbar"')).toBeLessThan(view.indexOf('id="analysis-board"'));
    // The sidebar is a raised panel: the body scrolls, the head stays put.
    expect(ruleBody(".panel-scroll")).toMatch(/overflow:\s*auto/);
    // Analyze actions live in the topbar, not in the panel.
    expect(html.indexOf('id="analyze-actions"')).toBeLessThan(html.indexOf('id="view-dashboard"'));
    for (const id of ["open-engine-widget", "fetch-my-game", "run-analysis"]) {
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(html.indexOf('id="view-dashboard"'));
    }
    expect(app).toContain("analyzeActions.hidden = !isAnalyze");
    // Coach copy wraps instead of clipping; the mainline is a 3-column grid.
    expect(rule(".coach-prose")).not.toMatch(/line-clamp|overflow:\s*hidden/);
    expect(rule(".coach-card > *")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".moves-grid .mtree-line.is-main")).toMatch(/grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/);
    expect(rule(".moves-grid")).toMatch(/overflow:\s*auto/);
    // Superseded legacy Analyze chrome is gone from the eager sheet.
    expect(css).not.toContain(".explain-card");
    expect(css).not.toContain(".coach-scroll");
    expect(css).not.toContain(".reveal");
    expect(css).not.toContain(".movelist");
    expect(html).not.toContain("explain-card");
  });

  it("composes Teams as directory | detail | incoming shares", () => {
    const view = html.slice(html.indexOf('id="view-teams"'), html.indexOf('id="view-settings"'));
    const teamsCss = readFileSync(join(root, "views", "teams.css"), "utf8");
    expect(view).toContain('<div class="teams">');
    expect(view).toContain('class="card dir"');
    expect(view).toContain('id="team-detail-card"');
    expect(view).toContain('class="card incoming"');
    // Two tabs over one panel, counts on the tabs, invite status as a footer line.
    expect(view).toContain('class="tabs" role="tablist"');
    expect(view).toContain('id="team-invite-foot"');
    // Page grid in the eager sheet; collapses to 2 columns then 1.
    expect(css).toMatch(/\.teams\s*\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)\s+330px/);
    expect(css).toMatch(/max-width:\s*1279px\)\s*\{\s*\.teams\s*\{[^}]*250px/);
    expect(css).toMatch(/max-width:\s*1020px\)\s*\{\s*\.teams\s*\{[^}]*minmax\(0,\s*1fr\)\s*;/);
    expect(teamsCss).toContain(".team-row.is-selected");
    // The old page intro, stacked-card chrome and generic list rows are gone.
    expect(html).not.toContain("teams-stack");
    expect(html).not.toContain("teams-intro");
    expect(css).not.toContain("teams-stack");
    expect(css).not.toContain(".list-item");
    expect(app).not.toContain("list-item");
  });

  it("composes Settings as a section nav beside a card column", () => {
    const view = html.slice(html.indexOf('id="view-settings"'), html.indexOf("</main>"));
    const settingsCss = readFileSync(join(root, "views", "settings.css"), "utf8");
    expect(view).toContain('<div class="settings">');
    expect(view).toContain('class="settings-nav"');
    expect(view).toContain('class="settings-content"');
    for (const id of ["appearance", "engine", "maia", "strength", "board", "connections", "about"]) {
      expect(view).toContain(`id="set-${id}"`);
    }
    expect(view).toContain('id="piece-style-picker"');
    expect(css).toMatch(/\.settings\s*\{[^}]*grid-template-columns:\s*180px\s+minmax\(0,\s*760px\)/);
    expect(css).toMatch(/max-width:\s*1020px\)\s*\{\s*\.settings\s*\{[^}]*minmax\(0,\s*1fr\)/);
    expect(settingsCss).toContain(".set-row");
    expect(settingsCss).toContain(".status-pill.ok");
    // The old label/value rows, thumbnail picker and feedback host are gone.
    for (const legacy of ["settings-row", "settings-label", "settings-value", "pf-feedback", "piece-style-preview", "settings-layout"]) {
      expect(html).not.toContain(legacy);
      expect(css).not.toContain(legacy);
    }
  });

  it("never navigates away during background hydration", () => {
    // S1 startup invariant: the ONLY startup switchView runs inside
    // restoreWorkspaceLocation with the parsed URL view. Background hydration
    // (auth/Lichess/settings/Maia) paints into the current view and must never
    // call switchView — so a signed-in first open with delayed hydration stays
    // on the URL route instead of self-navigating to Settings.
    const startup = app.slice(app.indexOf("async function init()"));
    expect(app).toContain("async function restoreWorkspaceLocation()");
    expect(startup).toContain("restoreWorkspaceLocation()");
    const restore = app.slice(app.indexOf("async function restoreWorkspaceLocation()"));
    expect(restore.slice(0, 1200)).toMatch(/switchView\(loc\.view,\s*\{\s*fromUrl:\s*true\s*\}\)/);
    expect(startup).not.toMatch(/switchView\(\s*["']settings["']\s*\)/);
    for (const name of [
      "loadSignedInWorkspace",
      "refreshAutoMaiaRating",
      "applySettingsPayload",
    ]) {
      const idx = app.indexOf(`function ${name}`);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(app.slice(idx, idx + 2500)).not.toMatch(/switchView\s*\(/);
    }
    // Controller-owned hydration is injected (not app.js): assert on account.js.
    expect(account).not.toMatch(/refreshAuthStatus[\s\S]{0,800}?switchView/);
    expect(account).not.toMatch(/refreshLichessStatus[\s\S]{0,1000}?switchView/);
    expect(account).not.toMatch(/setLichessUsername[\s\S]{0,1000}?switchView/);
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
    // The default My-last-game action passes no account_id: the backend fans
    // out across linked identities and ranks by canonical finish timestamp.
    expect(app).toMatch(/async function fetchMyLichessGame\(accountId = null\)/);
    expect(app).toMatch(/api\(`\/api\/lichess\/latest\$\{query\}`\)/);
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

  it("offers one shared Source Composer on Games and Scout with compact chips", () => {
    expect(html).toContain('id="games-source-add"');
    expect(html).toContain('id="games-source-chips"');
    expect(html).toContain('id="scout-source-add"');
    expect(html).toContain('id="scout-source-chips"');
    expect(html).not.toContain('id="games-source-self"');
    expect(html).not.toContain('id="games-source-pick"');
    expect(html).not.toContain('id="scout-source-self"');
    expect(html).not.toContain('id="scout-source-pick"');
    expect(html).not.toContain('id="scout-source-picked"');
    expect(html).not.toContain('id="scout-username"');
    expect(html).not.toContain('id="replay-account"');
    expect(html).toMatch(/id="scout-source-add"[^>]*/);
    expect(css).not.toContain(".source-add");
    expect(css).not.toContain(".source-pick");
    expect(css).not.toContain(".replay-account");
    expect(css).toContain(".src-chips");
    expect(css).toContain(".src-chip");
    expect(css).toContain(".src-popover");
    expect(css).toContain(".src-kind");
    expect(css).toContain(".src-empty");
    // Games + Scout share one selection system: the Source Composer primitive.
    expect(app).toContain("views/shared/source-composer.js");
    expect(app).toContain("openSourceComposer");
    expect(composer).toContain("export function positionPopover");
    expect(app).toContain("selectionChips");
    expect(app).toContain("selectionFromStorage");
    expect(app).toContain("selectionToStorage");
    // Games and Scout resolve through the same fetch path (linked + external).
    expect(app).toContain("gamesPickedUsernames");
    expect(app).toContain("openGamesComposer");
    expect(app).toContain("writeGamesSelection");
    expect(app).toContain("gamesSourceAccountIds");
    expect(app).toContain("usernames");
    expect(app).not.toContain("chooseGamesSourceAccounts");
    expect(app).not.toContain('getElementById("replay-account")');
    // Scout: identical picker, identical model — difference lives only in the
    // analysis workflow after picking. The report's profile links
    // (scout-username-link) are unrelated chrome.
    expect(app).not.toContain('getElementById("scout-username")');
    expect(app).not.toContain("scoutSelfOn");
    expect(app).not.toContain("setScoutSelf");
    expect(app).not.toContain("scoutSourceAccountIds");
    expect(app).not.toContain("setScoutSourceAccountIds");
    expect(app).not.toContain("scoutExternalUsernames");
    expect(app).toContain("scoutPickedUsernames");
    expect(app).toContain("openScoutComposer");
    expect(app).toContain("writeScoutSelection");
    expect(app).not.toContain("chooseScoutSourceAccounts");
    expect(scoutView).toContain("scoutPickedUsernames");
    expect(scoutView).not.toContain('getElementById("scout-username")');
    // Per-game source metadata survives into the rendered rows.
    expect(replayView).toContain("source_account");
  });

  it("keeps dark-mode text on semantic tokens (no hard-coded light colors)", () => {
    // Games result / move preview / secondary text use --text, never a fixed
    // dark hex that would vanish on a dark panel.
    const replayRule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return replayCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
    };
    expect(replayRule(".lr")).toMatch(/color:\s*var\(--text\)/);
    for (const selector of [".lr", ".res.r-win", ".res.r-loss", ".open-prev", ".moveline .inprep", ".kind-badge.t-bad"]) {
      expect(replayRule(selector), selector).not.toMatch(/color:\s*#[0-9a-fA-F]{3,6}/);
    }
    // Segmented control (prototype): body text on the surface-3 track in both
    // states; the selected tile is a raised panel-coloured chip.
    const segBtn = ruleBody(".seg-btn");
    expect(segBtn).toMatch(/color:\s*var\(--text\)/);
    const segActive = css.match(/\.seg-btn\.is-active\s*\{([^}]+)\}/)?.[1] || "";
    expect(segActive).toMatch(/background:\s*var\(--panel\)/);
    expect(segActive).not.toMatch(/color:/);
    const segDisabled = css.match(/\.seg-btn:disabled\s*\{([^}]+)\}/)?.[1] || "";
    expect(segDisabled).toMatch(/color:\s*var\(--label\)/);
    // Shared switches use tokens for track + knob in both states.
    const knob = ruleBody(".pf-knob");
    expect(knob).toMatch(/background:\s*var\(--text\)/);
    expect(css).toMatch(/\.pf-switch\.is-on \.pf-knob/);
    // Rank accents use semantic good/danger/warn so both themes adapt. Text
    // uses the *-text variants (WCAG AA); fills/borders keep the base tokens.
    expect(css).toContain(".sum-chip.t-good { color: var(--good-text); }");
    expect(css).toContain(".sum-chip.t-bad { color: var(--danger); }");
  });

  it("gives every view one scroll owner (no duplicate side rails)", () => {
    // Study sidebars scroll internally within the viewport-height study, so
    // controls never move when results appear; the generic sidebar stays
    // layout-only. Inner panels that need their own scroll keep it.
    expect(ruleBody(".sidebar")).toMatch(/overflow:\s*visible/);
    expect(ruleBody(".sidebar")).not.toMatch(/overflow-y/);
    expect(css).toMatch(/#analyze-sidebar\s*\{[^}]*overflow:\s*hidden/);
    expect(ruleBody(".panel-scroll")).toMatch(/overflow:\s*auto/);
    expect(css).toMatch(/#view-train \.train-sidebar \{[\s\S]{0,120}?overflow:\s*hidden/);
    // Panels that need independent scroll keep it: coach prose, inspector,
    // move lists, composer rows/popover, context menus.
    expect(ruleBody(".dock-body")).toMatch(/overflow:\s*auto/);
    expect(analyzeCss).toMatch(/\.moves-grid\s*\{[^}]*overflow:\s*auto/);
    expect(ruleBody(".src-popover")).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(".src-rows")).toMatch(/overflow:\s*auto/);
    expect(ruleBody(".context-menu")).toMatch(/overflow-y:\s*auto/);
    // No reserved gutter rails that shift content width.
    expect(css).not.toContain("scrollbar-gutter");
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
    expect(settings).not.toContain('type="checkbox" id="settings-maia-analysis"');
    expect(settings).toContain('id="settings-maia-auto" role="switch"');
    expect(settings).toContain('id="settings-maia-analysis" role="switch"');
    // The old brilliant sub-toggle is gone: Maia analysis carries brilliant signals.
    expect(settings).not.toContain("settings-brilliant-toggle");
    expect(settings).not.toContain("brilliant-info");
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
    expect(settings).toContain('id="maia-analysis-info-pop"');
    expect(settings).toContain('id="connections-info-pop"');
    // Wiring: switches paint + segmented theme sync + info toggles.
    expect(settingsView).toContain("paintSwitch");
    expect(settingsView).toContain("bindSwitch");
    expect(settingsView).toContain("toggleInfoPop");
    expect(settingsView).toContain("settings-theme-seg");
  });

  it("scopes Maia analysis to the analysis layer", () => {
    const settingsStart = html.indexOf('id="view-settings"');
    const settings = html.slice(settingsStart);
    // One Maia analysis switch, no brilliant sub-toggle.
    expect(settings).toContain('id="settings-maia-analysis" role="switch"');
    expect(settings).toContain('id="maia-analysis-info-pop"');
    expect(settings).not.toContain("settings-brilliant-toggle");
    expect(settings).not.toContain("brilliant-info");
    expect(settings).not.toContain("maia-analysis-sub");
    expect(css).not.toContain(".pf-analysis-sub");
    // Analysis-layer default OFF with a single named gate.
    expect(app).toContain("maiaAnalysis: false");
    expect(app).toContain("function maiaAnalysisEnabled()");
    expect(app).not.toContain("function brilliantEnabled()");
    expect(app).not.toMatch(/pref\("brilliantDetection"\)/);
    // Analysis-layer callers consult the gate: coach live check, saved-brilliant
    // rarity, intuition texture, phase tips, and the Analyze Maia pass.
    expect(app).toMatch(/brilliantCandidate && maiaAnalysisEnabled\(\)/);
    expect(app).toMatch(/async _checkIntuition\(features, prevFen, fen, token\) \{\r?\n    if \(!maiaAnalysisEnabled\(\)\) return;/);
    expect(app).toMatch(/without the rarity grounding\.\r?\n    if \(!maiaAnalysisEnabled\(\)\) return;/);
    expect(app).toMatch(/maiaAnalysisEnabled\(\) &&\r?\n {6}prep\.brilliant/);
    const phaseIdx = app.indexOf("async function maiaPhaseCoach");
    expect(app.slice(phaseIdx, phaseIdx + 600)).toMatch(/maiaAnalysisEnabled\(\)/);
    // Independent Maia-by-design capabilities never consult the gate.
    expect(app.slice(app.indexOf("async function fetchPlayMaia"), app.indexOf("async function fetchPlayMaia") + 300)).not.toMatch(/maiaAnalysisEnabled\(\)/);
    const genIdx = app.indexOf("runBrowserBuildGenerate({");
    expect(app.slice(genIdx, genIdx + 1200)).not.toMatch(/maiaAnalysisEnabled\(\)/);
    // Coverage and Scout state their Maia requirement instead of silently changing shape.
    expect(app).toMatch(/Coverage needs Maia analysis/);
    expect(scoutView).toContain("MAIA_ENRICH_OFF");
    expect(scoutView).toContain("maiaAnalysisEnabled");
    // Settings status peeks instead of constructing the worker.
    expect(settingsView).toContain("peekSharedMaia3Provider");
    expect(settingsView).toContain("renderMaiaAnalysis");
  });

  it("shares one switch primitive across coach, train, and settings", () => {
    // No native-looking boolean controls outside modal/popover checkbox lists.
    for (const id of ["explain-engine-toggle", "train-blitz-toggle"]) {
      expect(html).toContain(`id="${id}" role="switch"`);
      expect(html).not.toContain(`type="checkbox" id="${id}"`);
    }
    expect(html).toContain('id="settings-maia-analysis" role="switch"');
    // Legacy one-off switch classes are gone — everything is .pf-switch.
    expect(css).not.toContain(".pref-toggle");
    expect(css).not.toContain(".pref-switch");
    expect(css).not.toContain(".pref-knob");
    expect(css).not.toContain(".pref-label");
    expect(css).not.toContain(".explain-toggle");
    expect(css).toContain(".pf-switch");
    // Wiring paints through the shared class contract.
    expect(app).toContain("pf-switch");
    expect(app).not.toContain("pref-toggle");
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

  it("gives primary mobile controls 44px touch targets without enlarging the board", () => {
    // Slice from the mobile chrome block (bottom tab bar / touch targets).
    const mobile = css.slice(css.indexOf("/* Mobile: no rail"));
    expect(mobile).toMatch(/\.tab\s*\{[^}]*height:\s*44px/s);
    expect(mobile).toMatch(/\.lichess-chip\s*\{[^}]*min-height:\s*44px/s);
    expect(mobile).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/s);
    expect(mobile).toMatch(/\.ib\s*\{[^}]*min-height:\s*44px/s);
    expect(mobile).toMatch(/\.rep-menu-btn\s*\{[^}]*min-width:\s*44px/s);
    expect(mobile).toMatch(/#view-train \.board-bar \.ib\s*\{[^}]*min-width:\s*44px/s);
    expect(mobile).not.toMatch(/\.square\s*\{[^}]*min-(?:width|height):\s*44px/s);
  });
});
