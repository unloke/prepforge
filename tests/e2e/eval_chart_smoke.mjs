// Playwright smoke: the Analyze eval chart — mouse hover/click, the tooltip
// hiding on pointer leave, the dark-theme token wiring, and the current-ply position
// indicator. Invoked by tests/e2e/test_eval_chart_smoke.py after uvicorn boots
// locally (E2E build: VITE_ENABLE_SCOUT_E2E=1 + ?analyze_e2e=1).
//
// Assertions:
//   1. hover shows a text tooltip with SAN, the eval in pawns, and the
//      classification (never colour alone),
//   2. click selects the nearest ply (board label + app state move with it),
//   3. the tooltip never lingers: leaving the chart hides it, and the chart
//      is not a focus stop (moves are stepped with the global arrow keys),
//   4. the chart colours resolve from theme tokens and actually change with
//      data-theme (light vs dark),
//   5. the current-ply vertical indicator (dashed line + ring) tracks the
//      selected ply.
//
// Env:
//   E2E_BASE_URL — default http://127.0.0.1:9876

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const APP_URL = `${BASE}/?analyze_e2e=1`;

function fail(msg) {
  console.error(`[eval-chart-smoke] FAIL: ${msg}`);
  process.exit(1);
}

function check(ok, msg) {
  if (!ok) fail(msg);
  console.log(`[eval-chart-smoke] ok: ${msg}`);
}

// A five-ply Ruy Lopez fragment with a synthetic eval graph (the chart contract
// is about the UI behaviour, not the engine numbers).
const FIXTURE = {
  game_id: "eval-chart-smoke",
  engine: "stockfish",
  depth: 12,
  summary: {},
  position_evals: {},
  moves: [
    { ply: 1, move_number: 1, side: "white", san: "e4", uci: "e2e4", fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", fen_after: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", classification: "best", best_move_uci: "e2e4", score_cp: 30, comment: "" },
    { ply: 2, move_number: 1, side: "black", san: "e5", uci: "e7e5", fen_before: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", fen_after: "rnbqkbnr/pppp1ppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2", classification: "good", best_move_uci: "e7e5", score_cp: 20, comment: "" },
    { ply: 3, move_number: 2, side: "white", san: "Nf3", uci: "g1f3", fen_before: "rnbqkbnr/pppp1ppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2", fen_after: "rnbqkbnr/pppp1ppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2", classification: "inaccuracy", best_move_uci: "f1b5", score_cp: -80, comment: "" },
    { ply: 4, move_number: 2, side: "black", san: "Nc6", uci: "b8c6", fen_before: "rnbqkbnr/pppp1ppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2", fen_after: "r1bqkbnr/pppp1ppp/2n5/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", classification: "mistake", best_move_uci: "g8f6", score_cp: -120, comment: "" },
    { ply: 5, move_number: 3, side: "white", san: "Bb5", uci: "f1b5", fen_before: "r1bqkbnr/pppp1ppp/2n5/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", fen_after: "r1bqkbnr/pppp1ppp/2n5/1B6/4P3/5N2/PPPP1PPP/RNBQK1R1 b KQkq - 3 3", classification: "blunder", best_move_uci: "f1c4", score_cp: -400, comment: "" },
  ],
  eval_graph: [
    { ply: 1, san: "e4", score_cp: 30, bounded_score_cp: 30, classification: "best" },
    { ply: 2, san: "e5", score_cp: 20, bounded_score_cp: 20, classification: "good" },
    { ply: 3, san: "Nf3", score_cp: -80, bounded_score_cp: -80, classification: "inaccuracy" },
    { ply: 4, san: "Nc6", score_cp: -120, bounded_score_cp: -120, classification: "mistake" },
    { ply: 5, san: "Bb5", score_cp: -400, bounded_score_cp: -400, classification: "blunder" },
  ],
  critical_moments: [],
};

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
    const page = await browser.newPage();
    await page.goto(APP_URL, { timeout: 30_000 });
    await page.waitForFunction(() => !!window.__prepforgeAnalyzeE2e, null, { timeout: 20_000 });

    await page.evaluate(async (fixture) => {
      await window.__prepforgeAnalyzeE2e.seedAnalysis(fixture);
    }, FIXTURE);
    // The reveal panel fades in over two rAFs after seeding; wait for the
    // visible state so interaction probes never race the fade.
    await page.waitForSelector("#analysis-results.is-visible", { timeout: 15_000 });
    await page.waitForSelector("#eval-chart .eval-line", { timeout: 15_000 });

    const chartBox = await page.locator("#eval-chart").boundingBox();
    if (!chartBox) fail("eval chart has no bounding box");
    const xForRatio = (ratio) => chartBox.x + chartBox.width * ratio;
    // Plotted x (user units) of a point at `ratio` along the plies: the chart
    // insets its plot by 9 screen px, so the inset in user units tracks the width.
    const CHART_W = 640;
    const plotX = (ratio) => {
      const pad = (9 * CHART_W) / chartBox.width;
      return pad + ratio * (CHART_W - 2 * pad);
    };

    // --- 1. Mouse hover: text tooltip (SAN, eval, classification). ---
    await page.mouse.move(xForRatio(0.75), chartBox.y + chartBox.height / 2); // ply 4
    await page.waitForFunction(
      () => {
        const t = document.getElementById("eval-chart-tooltip");
        return t && !t.hidden && t.textContent.includes("Nc6");
      },
      null,
      { timeout: 5_000 },
    );
    const tooltipText = await page.evaluate(
      () => document.getElementById("eval-chart-tooltip").textContent,
    );
    check(/Nc6/.test(tooltipText), "hover tooltip names the ply's SAN");
    check(/[+−]\d+\.\d|[+−]M|0\.0/.test(tooltipText), "hover tooltip states the eval in pawns");
    check(/Mistake/.test(tooltipText), "hover tooltip names the classification in text");

    // --- 2. Mouse click: selects the nearest ply. ---
    await page.mouse.click(xForRatio(0.75), chartBox.y + chartBox.height / 2);
    check(
      (await page.evaluate(() => window.__prepforgeAnalyzeE2e.getPly())) === 4,
      "click selects ply 4",
    );
    check(
      /Nc6/.test(await page.evaluate(() => window.__prepforgeAnalyzeE2e.getBoardLabel())),
      "board label follows the clicked ply",
    );

    // --- 5. Current-ply indicator follows the selection (dashed line + ring). ---
    const cursor = await page.evaluate(() => ({
      x1: document.getElementById("eval-chart-cursor").getAttribute("x1"),
      ring: document.getElementById("eval-chart-cursor-dot").getAttribute("visibility"),
      dash: document.getElementById("eval-chart-cursor").getAttribute("stroke-dasharray"),
    }));
    check(Math.abs(Number(cursor.x1) - plotX(0.75)) < 0.5, `cursor sits on ply 4's x (got ${cursor.x1})`);
    check(cursor.ring === "visible", "current-ply ring marker is visible");
    check(cursor.dash === "3 3", "cursor line carries a dashed (non-colour) cue");

    // --- 3. The tooltip never lingers; the chart is not a focus stop. ---
    await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y - 120);
    await page.waitForFunction(
      () => document.getElementById("eval-chart-tooltip")?.hidden === true,
      null,
      { timeout: 5_000 },
    );
    check(
      (await page.evaluate(() => document.getElementById("eval-chart").hasAttribute("tabindex"))) === false,
      "the chart is not a keyboard focus stop (no pinned tooltip)",
    );
    await page.mouse.click(xForRatio(0.5), chartBox.y + chartBox.height / 2); // ply 3
    check(
      (await page.evaluate(() => window.__prepforgeAnalyzeE2e.getPly())) === 3,
      "click on another point switches to that ply",
    );
    const afterClick = await page.evaluate(() => document.getElementById("eval-chart-cursor").getAttribute("x1"));
    check(Math.abs(Number(afterClick) - plotX(0.5)) < 0.5, `cursor follows the new selection (got ${afterClick})`);

    // --- 4. Dark theme: chart colours resolve from tokens and flip. ---
    const readColors = () =>
      page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent-strong)";
        document.body.appendChild(probe);
        const token = getComputedStyle(probe).color;
        const line = getComputedStyle(document.querySelector("#eval-chart .eval-line")).stroke;
        probe.remove();
        return { token, line };
      });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const light = await readColors();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    const dark = await readColors();
    check(light.line === light.token, "light theme: main line colour equals --accent-strong");
    check(dark.line === dark.token, "dark theme: main line colour equals --accent-strong");
    check(light.line !== dark.line, "main line colour actually changes with the theme");

    console.log("[eval-chart-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
