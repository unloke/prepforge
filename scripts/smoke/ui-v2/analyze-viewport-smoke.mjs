// Analyze viewport smoke — fixture-backed (same stack as games/scout smokes).
// Checks at 1440x900 / 1180x900 / 982x614 / 390x844 / 390x660:
//   - no horizontal overflow, no console errors
//   - COOP/COEP headers → the real browser Stockfish is available
//   - demo PGN runs through the REAL pipeline: server stubs provide prepare
//     (depth 4, Maia off) + classify-save; Stockfish evaluates 5 positions
//   - coach card, win-chance chart, move grid, class bars render
//   - board-side eval bar shows the real white share and tracks the ply
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { Chess } from "chess.js";

// Explicit test PGN — the browser engine
// evaluates these REAL positions, so the prepare stub derives real FENs.
const DEMO_PGN_MOVETEXT = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6";
const DEMO_SANS = DEMO_PGN_MOVETEXT.split(" ").filter((t) => !/^\d+\.$/.test(t));
// Per-move metadata (uci / fens) derived in Node with chess.js — the same real
// game the browser engine evaluates.
const DEMO_MOVES = (() => {
  const chess = new Chess();
  const fens = [];
  const moves = [];
  for (let i = 0; i < DEMO_SANS.length; i++) {
    const fenBefore = chess.fen();
    const mv = chess.move(DEMO_SANS[i]);
    fens.push(chess.fen());
    moves.push({
      ply: i + 1,
      move_number: mv.turn === "w" ? Math.ceil((i + 1) / 2) : Math.ceil((i + 1) / 2),
      side: mv.color === "w" ? "white" : "black",
      san: mv.san,
      uci: `${mv.from}${mv.to}${mv.promotion || ""}`,
      fen_before: fenBefore,
      fen_after: chess.fen(),
    });
  }
  void fens;
  return moves;
})();
const DEMO_FENS = DEMO_MOVES.map((m) => m.fen_after);

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.ANALYZE_SMOKE_PORT || 8803);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) return { repertoires: [], shared: [] };
  if (path.startsWith("/api/analyses/")) return {
    game_id: path.split("/").pop(), engine: "stockfish", depth: 4, summary: {},
    moves: DEMO_MOVES.map((m) => ({ ...m, classification: "good" })), eval_graph: [],
  };
  if (path.startsWith("/api/analyses")) {
    return {
      analyses: [
        { game_id: "g1", white: "me_user", black: "opp_one", result: "0-1", analyzed_at: "2026-09-28T12:00:00Z" },
        { game_id: "g2", white: "opp_two_with_a_long_name", black: "me_user", result: "1-0", analyzed_at: "2026-09-27T12:00:00Z" },
      ],
    };
  }
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 0, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess")) return { linked: true, accounts: [{ id: "a1", username: "me_user", is_primary: true }] };
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(api(url.pathname)));
    return;
  }
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  try {
    const file = await readFile(join(STATIC_DIR, path));
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] || "application/octet-stream",
      // Cross-origin isolation so the real browser Stockfish can run.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(file);
  } catch { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of [undefined, "msedge", "chrome"]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[analyze-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

// Phones keep the game sources in the Games sheet once a game is loaded;
// raise it when its button is on screen and the sheet is down.
async function openGamesSheet(page) {
  const button = page.locator('#view-analyze [data-sheet-open="analyze-open"]');
  if (await button.isVisible() && (await button.getAttribute("aria-expanded")) !== "true" &&
    !(await page.locator("#history-drawer").isVisible())) await button.click();
}

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };
  const checkPanelHead = async (state) => {
    if (vp.width <= 760) {
      // Phones: Analyze is the pill in the thumb bar; Last game is a row in the Games sheet.
      const phone = await page.evaluate(() => {
        const bar = document.querySelector("#view-analyze .board-bar").getBoundingClientRect();
        const pill = document.getElementById("run-analysis").getBoundingClientRect();
        return { inBar: pill.width > 0 && pill.top >= bar.top - 1 && pill.bottom <= bar.bottom + 1 && pill.left >= bar.left && pill.right <= bar.right,
          lastGame: !!document.querySelector('#analyze-open [data-mirror="#fetch-my-game"]'), pill: pill.toJSON() };
      });
      check(phone.inBar && phone.lastGame, `${state}: Analyze must sit in the thumb bar and Last game in the sheet: ${JSON.stringify(phone)}`);
      return phone.pill;
    }
    const layout = await page.evaluate(() => {
      const head = document.querySelector("#analyze-sidebar > .panel-head");
      const bounds = head.getBoundingClientRect();
      const buttons = ["fetch-my-game", "run-analysis"].map((id) => {
        const button = document.getElementById(id);
        const rect = button.getBoundingClientRect();
        return { id, inHead: head.contains(button) && rect.width > 0 && rect.height > 0 &&
          rect.left >= bounds.left && rect.right <= bounds.right &&
          rect.top >= bounds.top && rect.bottom <= bounds.bottom,
        bounds: rect.toJSON() };
      });
      return { buttons, head: bounds.toJSON(),
        bodyBelow: document.querySelector("#analyze-sidebar > .panel-scroll").getBoundingClientRect().top >= bounds.bottom - 1 };
    });
    check(layout.buttons.every((b) => b.inHead) && layout.bodyBelow,
      `${state}: Last game / Analyze must fit inside the panel head: ${JSON.stringify(layout)}`);
    return layout.head;
  };

  // Server-side analysis pipeline stubs: prepare returns the demo game's REAL
  // position FENs (derived in Node with chess.js — the browser Stockfish
  // evaluates them at depth 4); classify-save echoes a real-shape contract
  // response. Maia stays OFF (no brilliant config) so no 46 MB model download.
  let savedPositions = [];
  let saveGate = null, sawSave = null;
  await page.route("**/api/analyze/prepare", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        game_id: "smoke-game",
        depth: 4,
        engine: "stockfish (browser)",
        positions: DEMO_FENS,
        moves: DEMO_SANS.map((san, i) => ({ ply: i + 1, san })),
        brilliant: { enabled: false },
      }),
    });
  });
  // classify-save mirrors the server CONTRACT: it receives the browser's real
  // engine evals per position and returns moves[] + eval_graph[] (the exact
  // shape renderAnalysis consumes). The evals are the real Stockfish output;
  // classification labels are a deterministic Δeval ladder standing in for the
  // server classifier (fixture-only — the UI logic under test is unchanged).
  await page.route("**/api/analyze/classify-save", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    savedPositions = body.positions || [];
    const evalByFen = new Map(savedPositions.map((p) => [p.fen, p]));
    const moves = DEMO_MOVES.map((m) => {
      const after = evalByFen.get(m.fen_after) || {};
      const before = evalByFen.get(m.fen_before) || {};
      const cp = after.score_cp ?? null;
      // Mover-POV delta of the centipawn score across the played move.
      const pov = (v, side) => (v == null ? null : side === "black" ? -v : v);
      const delta =
        pov(cp, m.side) != null && pov(before.score_cp, m.side) != null
          ? pov(cp, m.side) - pov(before.score_cp, m.side)
          : 0;
      const abs = Math.abs(delta);
      const classification =
        abs < 10 ? "best" : abs < 40 ? "good" : abs < 90 ? "inaccuracy" : abs < 200 ? "mistake" : "blunder";
      return { ...m, classification, best_move_uci: after.best_move_uci ?? null, score_cp: cp, comment: "" };
    });
    const eval_graph = moves.map((m) => ({
      ply: m.ply,
      san: m.san,
      score_cp: m.score_cp,
      bounded_score_cp: m.score_cp == null ? 0 : Math.max(-1000, Math.min(1000, m.score_cp)),
      classification: m.classification,
    }));
    if (saveGate) { sawSave(); await saveGate; }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        game_id: "smoke-game",
        engine: "stockfish (browser)",
        depth: 4,
        summary: {},
        position_evals: {},
        moves,
        eval_graph,
        critical_moments: [],
      }),
    });
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (vp.width > 760) {
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-testid="nav-analyze"]').boundingBox();
    check(!!box, "nav-analyze should expose a bounding box on the expanded rail");
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.mouse.up();
    }
  } else {
    await page.locator('[data-testid="bottom-analyze"]').click();
  }
  await page.waitForTimeout(700);

  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  const shot = async (state) => {
    if (!process.env.UI_V2_SHOTS) return;
    await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `analyze-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  };
  await shot("setup");
  await checkPanelHead("setup");

  // Board + coach + tool row render in setup.
  const board = await page.locator('[data-testid="analysis-board"] .square, [data-testid="analysis-board"] [data-square]').count();
  check(board === 64, `analysis board should render 64 squares, got ${board}`);
  const coachText = await page.locator('[data-testid="coach-prose"]').textContent().catch(() => "");
  check(/Make a move/.test(coachText || ""), `coach should show its idle line, got "${coachText.slice(0, 40)}"`);
  // Recent analyses ship open and load on entry (signed in) — never an empty open drawer.
  await page.waitForTimeout(200);
  const historyRows = await page.locator("#history-drawer:not([hidden]) .history-item").count();
  check(historyRows === 2, `recent analyses should list the 2 fixture games on entry, got ${historyRows}`);
  const pgnOpen = await page.locator("#pgn-drawer").evaluate((d) => d.open);
  check(!pgnOpen, "the PGN source drawer should start collapsed (prototype)");
  const toolButtons = await page.evaluate(() =>
    ["open-engine-widget", "fetch-my-game", "run-analysis", "pgn-input"].map((id) => !!document.getElementById(id)));
  check(toolButtons.every(Boolean), `Analyze tools should exist: ${toolButtons}`);
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  check(isolated, "page should be cross-origin isolated (COOP/COEP)");

  // Run the REAL analysis pipeline on the demo PGN (5-ply Ruy fragment).
  check(await page.locator("#pgn-input").inputValue() === "", "Analyze should start with an empty PGN source");
  await page.locator("#pgn-input").evaluate((el, pgn) => { el.value = pgn; }, DEMO_PGN_MOVETEXT);
  await page.evaluate(() => document.getElementById("run-analysis").click());
  // Stockfish at depth 4 over ~5 positions finishes in well under a second;
  // wait on the RESULTS (not a fixed sleep) and grab the transient success
  // status early — setStatus clears non-error text after ~6s.
  let sawReadyStatus = false;
  try {
    await page.waitForFunction(
      () => /Analysis ready/.test(document.querySelector('[data-testid="app-status"]')?.textContent || ""),
      null,
      { timeout: 20000 },
    );
    sawReadyStatus = true;
  } catch { /* status may have flashed before render assertions below */ }
  await page.waitForFunction(
    () =>
      !document.getElementById("analysis-results").hidden &&
      document.querySelectorAll("#analysis-moves .mtree-move").length >= 5,
    null,
    { timeout: 10000 },
  );
  check(sawReadyStatus, "status should confirm 'Analysis ready' after the run");
  const chartKids = await page.locator("#eval-chart *").count();
  check(chartKids > 0, "eval chart should have rendered the eval graph");
  const movesRows = await page.locator("#analysis-moves .mtree-move").count();
  check(movesRows >= 5, `move grid should list the game's plies, got ${movesRows}`);
  const classBars = await page.locator("#analysis-summary .cbar-row").count();
  check(classBars === 2, `class bars should show White + Black rows, got ${classBars}`);

  check(await page.locator("#analysis-job-dock .job-toast").count() === 0, "completed analysis progress must disappear immediately");

  // Exercise shared live evaluation and rapid forward/back navigation with the
  // real worker, not a mirrored test implementation.
  await page.locator("#open-engine-widget").click();
  await page.waitForFunction(() => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)"), null, { timeout: 20000 });
  await page.evaluate(async () => {
    for (const id of ["analysis-next", "analysis-next", "analysis-prev", "analysis-next", "analysis-prev", "analysis-next"]) {
      document.getElementById(id).click();
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await page.waitForFunction(() => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)"), null, { timeout: 20000 });
  await page.locator("#explain-engine-toggle").click();
  // Use the board navigation's real async path, allowing each render to settle.
  await page.evaluate(() => document.getElementById("analysis-start").click());
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => document.getElementById("analysis-next").click());
    await page.waitForTimeout(80);
  }
  const instant = await page.locator("#coach-prose").textContent();
  await page.locator("#explain-engine-toggle").click();
  try {
    await page.waitForFunction((text) => document.getElementById("coach-prose").textContent !== text, instant, { timeout: 15000 });
  } catch { check(false, "Coach must produce an engine verdict after rapid stepping stops"); }
  const engineLayout = await page.evaluate(() => {
    const panel = document.getElementById("analysis-eval-card").getBoundingClientRect();
    // The docked engine dissolves into the card (display: contents): measure its lines,
    // and require its depth ring and line stepper on the card's header row. Phones
    // show the best line alone under the eval row.
    const phone = window.innerWidth <= 760;
    const engine = document.getElementById(phone ? "analysis-engine-slot" : "engine-window-pvs").getBoundingClientRect();
    const coach = document.getElementById("analysis-explain").getBoundingClientRect();
    const head = ["#analysis-chart-caption", "#analysis-eval-meter", ...(phone ? [] : ["#engine-window-depth-readout", "#engine-window .engine-lines"]), "#open-engine-widget"]
      .map((sel) => document.querySelector(sel).getBoundingClientRect());
    const oneRow = head.every((r) => r.width > 0 && Math.abs((r.top + r.bottom) / 2 - (head[0].top + head[0].bottom) / 2) < 4 &&
      r.left >= panel.left && r.right <= panel.right + 1);
    return { fits: engine.width > 0 && engine.left >= panel.left && engine.right <= panel.right + 1 && oneRow, oneRow, coachHeight: coach.height,
      scrollOverflow: document.querySelector("#analyze-sidebar .panel-scroll").scrollWidth - document.querySelector("#analyze-sidebar .panel-scroll").clientWidth };
  });
  check(engineLayout.fits && engineLayout.scrollOverflow <= 1, `Engine must fit the evaluation card: ${JSON.stringify(engineLayout)}`);
  check(engineLayout.coachHeight <= 160, "Coach must remain compact");
  await shot("engine");
  await page.locator("#open-engine-widget").click();
  await page.evaluate(() => document.getElementById("analysis-start").click());

  // Composition: actions live in the panel head (there is no desktop top
  // bar), the mainline is a number | White | Black grid inside the panel, and
  // the board has no side eval bar, so it lines up with Build and Train.
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const white = box("#analysis-moves .mtree-move.is-white");
    const black = box("#analysis-moves .mtree-move.is-black");
    const num = box("#analysis-moves .mtree-num");
    // Phones dissolve the sidebar box (display: contents); the eval strip opens the panel.
    const panel = box("#analyze-sidebar").height ? box("#analyze-sidebar") : box("#analysis-eval-card");
    const boardBox = box("#analysis-board");
    return {
      sameRow: Math.abs(white.top - black.top) < 2,
      order: num.right <= white.left + 1 && white.right <= black.left + 1,
      panelHead: !!document.querySelector("#analyze-sidebar > .panel-head #analysis-game-title"),
      glyphs: document.querySelectorAll("#analysis-moves .mtree-glyph").length,
      noEvalBar: !document.getElementById("analysis-evalbar"),
      panelNextToBoard: window.innerWidth > 860 ? panel.left >= boardBox.right : panel.top >= boardBox.bottom,
    };
  });
  // Phones hide the move grid; the eval chart steps through the game instead.
  if (vp.width > 760) check(layout.sameRow && layout.order, `move grid should lay number | White | Black in one row: ${JSON.stringify(layout)}`);
  await checkPanelHead("results");
  check(layout.panelHead, "the panel head should carry the game title");
  check(layout.glyphs >= 1, "classified moves should carry a glyph");
  check(layout.noEvalBar, "the Analyze board should not carry a side eval bar");
  check(layout.panelNextToBoard, "the panel should sit beside (or, stacked, below) the board");

  await page.evaluate(() => document.getElementById("analysis-next").click());
  await page.waitForTimeout(300);
  await shot("results");
  const caption = await page.locator("#analysis-chart-caption").textContent();
  check(/^([+−]?\d+\.\d{2}|[+−]M|#-?\d+)$/.test(caption || ""), `the chart caption should show the current eval, got "${caption}"`);
  // A side line played on the board interrupts the mainline grid as a
  // full-width row and the mainline resumes in its own columns afterwards.
  await page.locator('[data-testid="analysis-board"] [data-square="d7"]').click();
  await page.locator('[data-testid="analysis-board"] [data-square="d5"]').click();
  await page.waitForSelector("#analysis-moves .mtree-var", { state: "attached", timeout: 5000 });
  const variation = await page.evaluate(() => {
    const grid = document.querySelector("#analysis-moves .mtree-line.is-main").getBoundingClientRect();
    const v = document.querySelector("#analysis-moves .mtree-var").getBoundingClientRect();
    const blacks = [...document.querySelectorAll("#analysis-moves .mtree-line.is-main > .mtree-move.is-black")].map((el) => el.getBoundingClientRect().left);
    return {
      fullWidth: v.width > grid.width * 0.8,
      blackAligned: blacks.every((l) => Math.abs(l - blacks[0]) < 2),
    };
  });
  if (vp.width > 760) {
    check(variation.fullWidth, "a variation should span the full grid width");
    check(variation.blackAligned, "Black moves should stay in one column around a variation");
  }
  await page.evaluate(() => document.getElementById("analysis-start").click());
  await page.waitForTimeout(200);

  // The eval readout beside the chart title is empty at ply 0 (the start
  // position has no engine evaluation) and shows a real number on scored plies.
  const captionAtStart = await page.locator("#analysis-chart-caption").textContent();
  check(!captionAtStart, `eval readout should be empty at ply 0 (no fabricated eval), got "${captionAtStart}"`);
  await page.evaluate(() => document.getElementById("analysis-next").click());
  await page.waitForFunction(
    () => /\d|M/.test(document.getElementById("analysis-chart-caption")?.textContent || ""),
    null,
    { timeout: 5000 },
  );
  // Leaving the chart hides the hover tooltip (it never lingers).
  await page.locator("#eval-chart").evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(100);
  const chartBox = await page.locator("#eval-chart").boundingBox();
  if (chartBox) {
    for (const ratio of [0.001, 0.999]) {
      await page.mouse.move(chartBox.x + chartBox.width * ratio, chartBox.y + chartBox.height / 2);
      const bounds = await page.locator("#eval-chart-tooltip").boundingBox();
      check(bounds && bounds.x >= chartBox.x - 1 && bounds.x + bounds.width <= chartBox.x + chartBox.width + 1 &&
        bounds.y >= chartBox.y - 1 && bounds.y + bounds.height <= chartBox.y + chartBox.height + 1, `chart edge tooltip must stay inside the chart: ${JSON.stringify({ bounds, chartBox })}`);
    }
    await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
    await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y - 150);
    await page.waitForTimeout(150);
    const tipVisible = await page.evaluate(() => {
      const tip = document.getElementById("eval-chart-tooltip");
      return !!tip && !tip.hidden && getComputedStyle(tip).display !== "none" && getComputedStyle(tip).visibility !== "hidden" && getComputedStyle(tip).opacity !== "0";
    });
    check(!tipVisible, "the chart tooltip should hide once the pointer leaves the chart");
  }

  // History recall must yield to a paste even if the saved report arrives last.
  let releaseRecall, sawRecall;
  const recallGate = new Promise((r) => { releaseRecall = r; });
  const recallRequested = new Promise((r) => { sawRecall = r; });
  await page.route("**/api/analyses/g1", async (route) => {
    sawRecall();
    await recallGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api("/api/analyses/g1")) });
  });
  await openGamesSheet(page);
  await page.locator('.history-item[data-game-id="g1"]').focus();
  await page.keyboard.press("Enter");
  await recallRequested;
  await openGamesSheet(page);
  await page.locator("#pgn-drawer").evaluate((d) => { d.open = true; });
  await page.locator("#pgn-input").fill("1. d4 d5");
  await page.waitForFunction(() => document.getElementById("analysis-moves").textContent.includes("d4"));
  const recalled = page.waitForResponse("**/api/analyses/g1");
  releaseRecall();
  await recalled;
  await page.waitForTimeout(300);
  check(await page.locator("#pgn-input").inputValue() === "1. d4 d5", "pending recall must not overwrite a new paste");
  check((await page.locator("#analysis-moves").textContent()).includes("d4"), "pending recall must not replace the pasted move tree");

  // The history row supplies Black's linked identity, so recall uses that side.
  await openGamesSheet(page);
  await page.locator('.history-item[data-game-id="g2"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /opp_two/.test(document.getElementById("analysis-game-title").textContent));
  check(await page.locator("#analysis-board [data-square]").first().getAttribute("data-square") === "h1", "a recalled Self-as-Black game should face Black");
  const recalledPgn = await page.locator("#pgn-input").inputValue();
  check(recalledPgn.includes('[Black "me_user"]') && recalledPgn.includes('[Result "1-0"]'), "recalled PGN should retain its game metadata");
  // A real recalled title wraps the actions at narrow widths. The header must
  // keep its full content height while the result body owns scrolling.
  const recalledHead = await checkPanelHead("long recalled title");
  if (vp.width > 760) {
    await page.locator("#analyze-sidebar > .panel-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const scrolledHead = await checkPanelHead("scrolled recalled report");
    check(Math.abs(recalledHead.top - scrolledHead.top) < 1 && Math.abs(recalledHead.height - scrolledHead.height) < 1,
      "scrolling the report must keep the panel head in place");
  } else {
    // Phones: one bottom bar. The tab bar waits under it until the views button raises it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check(!(await page.locator("#analyze-open").evaluate((el) => el.classList.contains("is-open"))), "Escape should lower the Games sheet");
    // A recalled Black game flips the board; measure once it has settled.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {}))));
    const bars = await page.evaluate(() => {
      const tabbar = document.getElementById("app-tabbar");
      const bar = document.querySelector("#view-analyze .board-bar").getBoundingClientRect();
      const board = document.getElementById("analysis-board").getBoundingClientRect();
      const coach = document.getElementById("analysis-explain").getBoundingClientRect();
      const chart = document.getElementById("eval-chart").getBoundingClientRect();
      return { tabbarHidden: getComputedStyle(tabbar).visibility === "hidden",
        oneScreen: chart.top >= 0 && chart.bottom <= board.top + 1 && coach.top >= board.bottom - 1 && coach.bottom <= bar.top + 1,
        barAtBottom: Math.abs(bar.bottom - window.innerHeight) < 2,
        boardFullWidth: board.width >= window.innerWidth - 1 || board.height >= window.innerHeight * 0.5,
        board: [Math.round(board.width), Math.round(board.height)], viewport: [window.innerWidth, window.innerHeight],
        page: [document.documentElement.clientWidth, document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
    });
    check(bars.tabbarHidden && bars.barAtBottom, `the board bar should be the only bottom bar: ${JSON.stringify(bars)}`);
    check(bars.boardFullWidth, `the phone board should take the width: ${JSON.stringify(bars)}`);
    check(bars.oneScreen, `eval chart over the board and coach under it, on one screen: ${JSON.stringify(bars)}`);
    await page.locator("#view-analyze [data-phone-nav]").click();
    await page.waitForTimeout(300);
    const raised = await page.evaluate(() => {
      const tabbar = document.getElementById("app-tabbar").getBoundingClientRect();
      const bar = document.querySelector("#view-analyze .board-bar").getBoundingClientRect();
      return getComputedStyle(document.getElementById("app-tabbar")).visibility === "visible" && Math.abs(tabbar.bottom - bar.top) < 2;
    });
    check(raised, "the views button should raise the tab bar right above the board bar");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check(!(await page.evaluate(() => document.body.classList.contains("phone-nav-open"))), "Escape should put the tab bar away");
  }
  await shot("recalled");

  if (vp.width === 1440) {
    // Conversely, a review may finish saving in the background after recall.
    // Its result must not replace the selected report's empty eval graph.
    let releaseSave;
    saveGate = new Promise((r) => { releaseSave = r; });
    const saveRequested = new Promise((r) => { sawSave = r; });
    await page.locator("#pgn-input").fill(DEMO_PGN_MOVETEXT);
    await page.locator("#run-analysis").click();
    await saveRequested;
    await page.locator('.history-item[data-game-id="g2"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Recalled analysis/.test(document.getElementById("app-status").textContent));
    releaseSave();
    await page.waitForFunction(() => !document.getElementById("run-analysis").disabled);
    check(await page.locator("#eval-chart .eval-area").count() === 0, "a completed older review must not repaint the recalled report");
    check((await page.locator("#pgn-input").inputValue()).includes('[Black "me_user"]'), "a completed older review must keep the recalled PGN");
  }

  // Overflow + console errors (ignore engine/resource noise from wasm fetches).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|favicon|net::|wasm|IndexedDB|AbortError/i.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();
}

try {
  for (const vp of [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1180", width: 1180, height: 900 },
    { name: "split-982", width: 982, height: 614 },
    { name: "laptop-1280", width: 1280, height: 609 },
    { name: "tablet-860", width: 860, height: 900 },
    { name: "mobile-390", width: 390, height: 844 },
    // A phone browser's address and tool bars leave about this much.
    { name: "mobile-390-chrome", width: 390, height: 660 },
  ]) await runViewport(vp);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error("[analyze-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[analyze-smoke] ok — all seven viewports render Analyze (coach, chart, move grid, class bars, eval readout) through the real browser-engine pipeline with no overflow and no console errors.");
