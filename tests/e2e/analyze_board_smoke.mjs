// Playwright smoke: Analyze board interaction — no stray focus ring on the board, and
// engine lines (PVs) previewed on the board. Invoked by
// tests/e2e/test_analyze_board_smoke.py after uvicorn boots locally (E2E build:
// VITE_ENABLE_SCOUT_E2E=1 + ?analyze_e2e=1).
//
// Assertions:
//   1. clicking a square never leaves a focused square (no focus ring), and the arrow
//      keys then step the game instead of moving a square cursor;
//   2. the board stays one Tab stop; a typed square name moves keyboard focus there;
//   3. clicking an engine line plays it on the board (accent frame + "Line 1 · …"
//      label) while the row stays one line, the arrow keys and board-bar arrows step
//      through it, and the game (ply) is untouched;
//   4. "Exit line" and Esc restore the exact game position.
//
// Env:
//   E2E_BASE_URL — default http://127.0.0.1:9876

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const APP_URL = `${BASE}/?analyze_e2e=1`;
const ENGINE_TIMEOUT_MS = 90_000;

function fail(msg) {
  console.error(`[analyze-board-smoke] FAIL: ${msg}`);
  process.exit(1);
}

function check(ok, msg) {
  if (!ok) fail(msg);
  console.log(`[analyze-board-smoke] ok: ${msg}`);
}

const MOVES = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

async function fixture() {
  const { Chess } = await import("chess.js");
  const chess = new Chess();
  const moves = MOVES.map((san, i) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    const uci = mv.from + mv.to;
    return {
      ply: i + 1,
      move_number: Math.floor(i / 2) + 1,
      side: i % 2 ? "black" : "white",
      san,
      uci,
      fen_before: fenBefore,
      fen_after: chess.fen(),
      classification: "best",
      best_move_uci: uci,
      score_cp: 20,
      comment: "",
    };
  });
  return {
    game_id: "analyze-board-smoke",
    engine: "stockfish",
    depth: 12,
    summary: {},
    position_evals: {},
    moves,
    eval_graph: moves.map((m) => ({ ply: m.ply, san: m.san, score_cp: 20, bounded_score_cp: 20, classification: "best" })),
    critical_moments: [],
  };
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright not installed — run npm ci && npx playwright install chromium");
  }
  let browser;
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch (_) {
      /* try the next channel */
    }
  }
  if (!browser) fail("could not launch Chromium/Chrome/Edge");

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(APP_URL, { timeout: 30_000 });
    await page.waitForFunction(() => !!window.__prepforgeAnalyzeE2e, null, { timeout: 20_000 });
    const seeded = await fixture();
    await page.evaluate(async (f) => {
      await window.__prepforgeAnalyzeE2e.seedAnalysis(f);
    }, seeded);
    const e2e = (fn) => page.evaluate(fn);
    const getPly = () => e2e(() => window.__prepforgeAnalyzeE2e.getPly());
    const label = () => e2e(() => window.__prepforgeAnalyzeE2e.getBoardLabel());
    const waitPly = (ply, msg) =>
      page
        .waitForFunction((p) => window.__prepforgeAnalyzeE2e.getPly() === p, ply, { timeout: 5_000 })
        .catch(() => fail(msg));
    const boardPieces = () =>
      e2e(() => [...document.querySelectorAll("#analysis-board .square")].map((s) => s.dataset.piece || "").join(","));

    await page.click("#analysis-end");
    await waitPly(6, "End did not reach the last move");

    // --- 1. A click never leaves a focused square; arrows step the game. ---
    await page.click('#analysis-board .square[data-square="d4"]');
    const focused = await e2e(() => document.activeElement?.dataset?.square || null);
    check(focused === null, `clicking a square does not focus it (focused: ${focused})`);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await waitPly(5, "ArrowLeft after a board click did not step back one move");
    check(
      (await e2e(() => document.querySelectorAll("#analysis-board .square:focus").length)) === 0,
      "arrow keys after a click move no square cursor",
    );
    await page.keyboard.press("ArrowRight");
    await waitPly(6, "ArrowRight did not step forward");

    // --- 2. Keyboard: one Tab stop; typing a square name moves focus. ---
    const tabbable = await e2e(() => document.querySelectorAll('#analysis-board .square[tabindex="0"]').length);
    check(tabbable === 1, `the board is one Tab stop (got ${tabbable} tabbable squares)`);
    await page.locator('#analysis-board .square[tabindex="0"]').focus();
    await page.keyboard.press("g");
    await page.keyboard.press("1");
    check((await e2e(() => document.activeElement?.dataset?.square)) === "g1", "typing g1 focuses g1");
    await page.keyboard.press("ArrowLeft");
    await waitPly(5, "ArrowLeft with a focused square did not step the game");
    await page.click("#analysis-end");
    await waitPly(6, "End did not return to the last move");

    // --- 3. Engine line preview. ---
    const gameLabel = await label();
    const gamePieces = await boardPieces();
    await page.click("#open-engine-widget");
    await page
      .waitForSelector("#engine-window-pvs .engine-pv[data-line='0'] .pv-move[data-ply='3']", { timeout: ENGINE_TIMEOUT_MS })
      .catch(() => fail("engine produced no line with four moves"));
    const firstMove = await e2e(
      () => document.querySelector("#engine-window-pvs .engine-pv[data-line='0'] .pv-move[data-ply='0']").textContent,
    );
    const rowHeight = await e2e(() => document.querySelector("#engine-window-pvs .engine-pv[data-line='0']").offsetHeight);
    await page.click("#engine-window-pvs .engine-pv[data-line='0'] .engine-pv-eval");
    await page
      .waitForFunction(() => document.getElementById("analysis-board").classList.contains("is-previewing"), null, { timeout: 5_000 })
      .catch(() => fail("clicking an engine line did not put it on the board"));
    check((await label()).startsWith(`Line 1 · 4.${firstMove} · 1/`), `label names the previewed move (got ${await label()})`);
    check(!(await page.locator("#analysis-pv-exit").isHidden()), "Exit line is shown");
    check(
      (await e2e(() => document.querySelector("#engine-window-pvs .engine-pv[data-line='0']").offsetHeight)) === rowHeight,
      "the previewed row stays one line",
    );
    check((await getPly()) === 6, "the game ply is unchanged while previewing");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    check(/ · 3\//.test(await label()), `ArrowRight steps the line (got ${await label()})`);
    await page.click("#analysis-prev");
    check(/ · 2\//.test(await label()), `the Previous button steps the line back (got ${await label()})`);
    check(
      (await e2e(() => document.querySelector(".pv-move.is-current")?.dataset.ply)) === "1",
      "the current move is marked in the line",
    );
    await page.click("#engine-window-pvs .engine-pv[data-line='0'] .pv-move[data-ply='3']");
    check(/ · 4\//.test(await label()), "clicking a move in the line jumps to it");
    await page.waitForTimeout(1200); // engine repaints keep the preview
    check(/ · 4\//.test(await label()), "the preview survives engine repaints");
    check((await getPly()) === 6, "the game ply is still unchanged");

    // --- 4. Back to the game. ---
    await page.click("#analysis-pv-exit");
    check((await label()) === gameLabel, "Exit line restores the game label");
    check((await boardPieces()) === gamePieces, "Exit line restores the exact position");
    check(
      !(await e2e(() => document.getElementById("analysis-board").classList.contains("is-previewing"))),
      "the preview frame is removed",
    );
    await page.click("#engine-window-pvs .engine-pv[data-line='0'] .engine-pv-eval");
    await page.click("#analysis-start");
    check(/ · 0\//.test(await label()), "Start goes to the start of the line, still previewing");
    await page.keyboard.press("Escape");
    check((await label()) === gameLabel, "Esc returns to the game");
    await page.keyboard.press("ArrowLeft");
    await waitPly(5, "game navigation does not work after the preview");
    console.log("[analyze-board-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
