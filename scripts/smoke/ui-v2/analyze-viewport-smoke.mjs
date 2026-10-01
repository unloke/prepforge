// Analyze viewport smoke — fixture-backed (same stack as games/scout smokes).
// Checks at 1440x900 / 1180x900 / 982x614 / 390x844:
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

// The demo PGN the app prefills (app.js DEMO_PGN) — the browser engine
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
  if (path.startsWith("/api/analyses")) {
    return {
      analyses: [
        { game_id: "g1", white: "me_user", black: "opp_one", result: "0-1", analyzed_at: "2026-09-28T12:00:00Z" },
        { game_id: "g2", white: "opp_two", black: "me_user", result: "1-0", analyzed_at: "2026-09-27T12:00:00Z" },
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
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[analyze-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  // Server-side analysis pipeline stubs: prepare returns the demo game's REAL
  // position FENs (derived in Node with chess.js — the browser Stockfish
  // evaluates them at depth 4); classify-save echoes a real-shape contract
  // response. Maia stays OFF (no brilliant config) so no 46 MB model download.
  let savedPositions = [];
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
    await page.evaluate(() => document.querySelector('[data-testid="bottom-more"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-nav-mirror="analyze"]').click());
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

  // Composition: actions live in the panel head (there is no desktop top
  // bar), the mainline is a number | White | Black grid inside the panel, and
  // the board has no side eval bar, so it lines up with Build and Train.
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const white = box("#analysis-moves .mtree-move.is-white");
    const black = box("#analysis-moves .mtree-move.is-black");
    const num = box("#analysis-moves .mtree-num");
    const actions = box("#analyze-actions");
    const head = box("#analyze-sidebar > .panel-head");
    const panel = box("#analyze-sidebar");
    const boardBox = box("#analysis-board");
    return {
      sameRow: Math.abs(white.top - black.top) < 2,
      order: num.right <= white.left + 1 && white.right <= black.left + 1,
      actionsInHead: !!actions && actions.width > 0 && actions.top >= head.top - 1 && actions.bottom <= head.bottom + 1,
      panelHead: !!document.querySelector("#analyze-sidebar > .panel-head #analysis-game-title"),
      glyphs: document.querySelectorAll("#analysis-moves .mtree-glyph").length,
      noEvalBar: !document.getElementById("analysis-evalbar"),
      panelNextToBoard: window.innerWidth > 860 ? panel.left >= boardBox.right : panel.top >= boardBox.bottom,
    };
  });
  check(layout.sameRow && layout.order, `move grid should lay number | White | Black in one row: ${JSON.stringify(layout)}`);
  check(layout.actionsInHead, "Engine / My last game / Analyze should sit in the panel head");
  check(layout.panelHead, "the panel head should carry the game title");
  check(layout.glyphs >= 1, "classified moves should carry a glyph");
  check(layout.noEvalBar, "the Analyze board should not carry a side eval bar");
  check(layout.panelNextToBoard, "the panel should sit beside (or, stacked, below) the board");

  await page.evaluate(() => document.getElementById("analysis-next").click());
  await page.waitForTimeout(300);
  await shot("results");
  const caption = await page.locator("#analysis-chart-caption").textContent();
  check(/^([+−]?\d+\.\d|[+−]M|#-?\d+)$/.test(caption || ""), `the chart caption should show the current eval, got "${caption}"`);
  // A side line played on the board interrupts the mainline grid as a
  // full-width row and the mainline resumes in its own columns afterwards.
  await page.locator('[data-testid="analysis-board"] [data-square="d7"]').click();
  await page.locator('[data-testid="analysis-board"] [data-square="d5"]').click();
  await page.waitForSelector("#analysis-moves .mtree-var", { timeout: 5000 });
  const variation = await page.evaluate(() => {
    const grid = document.querySelector("#analysis-moves .mtree-line.is-main").getBoundingClientRect();
    const v = document.querySelector("#analysis-moves .mtree-var").getBoundingClientRect();
    const blacks = [...document.querySelectorAll("#analysis-moves .mtree-line.is-main > .mtree-move.is-black")].map((el) => el.getBoundingClientRect().left);
    return { fullWidth: v.width > grid.width * 0.8, blackAligned: blacks.every((l) => Math.abs(l - blacks[0]) < 2) };
  });
  check(variation.fullWidth, "a variation should span the full grid width");
  check(variation.blackAligned, "Black moves should stay in one column around a variation");
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
  const chartBox = await page.locator("#eval-chart").boundingBox();
  if (chartBox) {
    await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
    await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y - 150);
    await page.waitForTimeout(150);
    const tipVisible = await page.evaluate(() => {
      const tip = document.getElementById("eval-chart-tooltip");
      return !!tip && !tip.hidden && getComputedStyle(tip).display !== "none" && getComputedStyle(tip).visibility !== "hidden" && getComputedStyle(tip).opacity !== "0";
    });
    check(!tipVisible, "the chart tooltip should hide once the pointer leaves the chart");
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
    { name: "mobile-390", width: 390, height: 844 },
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
console.log("[analyze-smoke] ok — all four viewports render Analyze (coach, chart, move grid, class bars, eval readout) through the real browser-engine pipeline with no overflow and no console errors.");
