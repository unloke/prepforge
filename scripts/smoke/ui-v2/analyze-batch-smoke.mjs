import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Chess } from "chess.js";

const shots = process.env.ANALYZE_BATCH_SHOTS;
const pgns = [
  '[Event "G1"]\n[White "Alice"]\n[Black "Bob"]\n[Result "*"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 *',
  '[Event "G2"]\n[White "Carol"]\n[Black "Dave"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *',
];
const reviews = pgns.map((pgn, index) => {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history();
  chess.reset();
  const moves = history.map((san, i) => {
    const before = chess.fen(), move = chess.move(san);
    return { ply: i + 1, san, uci: move.lan, fen_before: before, fen_after: chess.fen(),
      move_number: Number(before.split(" ")[5]), side: move.color === "w" ? "white" : "black", classification: "good" };
  });
  return { game_id: `g${index + 1}`, pgn, white: index ? "Carol" : "Alice", black: index ? "Dave" : "Bob", result: "*",
    moves, depth: 4, engine: "saved", summary: {}, position_evals: {},
    eval_graph: moves.map(move => ({ ply: move.ply, san: move.san, score_cp: index ? 100 : 0, bounded_score_cp: index ? 100 : 0 })) };
});
const repertoire = { id: "batch-prep", name: "Queen's Gambit", color: "white", is_active: true,
  health: { trainable: 3, mastered: 1, due: 2 } };
const summary = { total_games: 2, imported_count: 0, existing_count: 2, failed_count: 0,
  selected_index: 0, selected_game_id: "g1", games: reviews.map((review, index) => ({
    index, game_id: review.game_id, white: review.white, black: review.black, status: "existing",
  })) };
const posts = [];
let holdRecall = false, recallStarted, releaseRecall;
const api = (path) => {
  if (path === "/api/auth/me") return { id: "batch-user", display_name: "Batch QA", email: "batch@example.test" };
  if (path === "/api/auth/providers") return { google: false };
  if (path === "/api/csrf") return { csrf_token: "fixture" };
  if (path === "/api/settings") return { stockfish_depth: 4, maia_rating: null };
  if (path === "/api/repertoires") return { repertoires: [repertoire], shared: [] };
  if (path === "/api/dashboard") return { games: 2, repertoires: 1, training_sessions: 1, open_mistakes: 0,
    due_reviews: 2, due_soon: 0, streak: { current: 1, best: 1, trained_today: true }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/training")) return { sessions: [{ id: "batch-training", repertoire_id: repertoire.id, completed: true }] };
  if (path === "/api/analyses") return { analyses: reviews.map(review => ({ ...review, analyzed_at: "2026-09-28T12:00:00Z" })) };
  return reviews.find(review => path === `/api/analyses/${review.game_id}`) || {};
};
const dir = fileURLToPath(new URL("../../../src/prepforge_chess/web/static/", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/api/")) {
    let data = api(path), status = 200;
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
      posts.push(path);
      if (path === "/api/analyze/prepare") {
        if (payload.mode !== "multi") { status = 400; data = { detail: "Found 2 games in the PGN" }; }
        else data = { ...reviews[0], import_summary: summary, brilliant: { enabled: false },
          positions: [...new Set(reviews[0].moves.flatMap(move => [move.fen_before, move.fen_after]))] };
      } else if (path === "/api/analyze/classify-save") data = reviews[0];
    }
    if (holdRecall && path === "/api/analyses/g2") {
      recallStarted();
      await new Promise(resolve => { releaseRecall = resolve; });
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }
  try {
    const file = await readFile(join(dir, path === "/" ? "index.html" : path.replace(/^\/static\//, "")));
    res.writeHead(200, { "Content-Type": path === "/" ? "text/html" : mime[extname(path)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  if (shots) await mkdir(shots, { recursive: true });
  for (const [size, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/#/analyze`);
    await page.locator("#view-analyze:not([hidden])").waitFor();
    await page.locator("#pgn-input").evaluate((el, pgn) => { el.value = pgn; }, pgns.join("\n\n"));
    await page.locator("#run-analysis").evaluate(el => el.click());
    const firstDone = page.waitForResponse(response => response.url().endsWith("/api/analyze/classify-save") && response.ok());
    await page.getByRole("button", { name: "Analyze batch", exact: true }).click();
    await firstDone;
    await page.waitForFunction(() => document.getElementById("analysis-import-select") && !document.getElementById("run-analysis").disabled);
    await page.locator('#analysis-moves [data-node-id="m6"]').evaluate(el => el.click());
    await page.waitForFunction(() => document.querySelector('#analysis-board [data-square="e4"]')?.dataset.piece === "P");
    const snapshot = () => page.evaluate(() => ({
      e4: document.querySelector('#analysis-board [data-square="e4"]').dataset.piece,
      moves: document.getElementById("analysis-moves").textContent,
      graph: document.getElementById("eval-chart").innerHTML,
    }));
    const before = await snapshot(), workBefore = posts.length;
    holdRecall = true;
    const started = new Promise(resolve => { recallStarted = resolve; });
    await page.locator("#analysis-import-select").selectOption("1");
    await started;
    assert.equal(await page.locator("#analysis-import-select").isDisabled(), true);
    assert.deepEqual(await snapshot(), before, "a pending recall keeps board, move list and graph on the same old game");
    if (shots) await page.screenshot({ path: join(shots, `analyze-batch-loading-${size}.png`) });
    holdRecall = false;
    releaseRecall();
    await page.waitForFunction(() => document.getElementById("analysis-import-picker").getAttribute("aria-busy") === "false");
    assert.equal(posts.length, workBefore, "saved-game switching must not prepare or classify-save");
    assert.match(await page.locator("#analysis-moves").innerText(), /d4/);
    assert.doesNotMatch(await page.locator("#analysis-moves").innerText(), /Qh5/);
    assert.equal(await page.locator('#analysis-board [data-square="e4"]').getAttribute("data-piece"), "");
    assert.equal(await page.locator("#analysis-import-select").isDisabled(), false);
    assert.doesNotMatch(await page.locator("#notices").innerText(), /Imported \d+ new/);
    const geometry = await page.locator("#analysis-import-picker").evaluate(el => {
      const summary = el.querySelector(".import-summary").getBoundingClientRect();
      const select = el.querySelector("select").getBoundingClientRect();
      return { separate: summary.bottom <= select.top || summary.right <= select.left,
        visible: select.top >= 0 && select.bottom <= innerHeight && select.right <= innerWidth };
    });
    assert.equal(geometry.separate, true, "inline statistics and picker must not overlap");
    assert.equal(geometry.visible, true, "the picker must remain in the viewport");
    if (shots) await page.screenshot({ path: join(shots, `analyze-batch-ready-${size}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("[analyze-batch-smoke] ok — saved batch switches skip compute, keep board/list/eval consistent while loading, and leave the 390×844 picker unobscured");
} finally { holdRecall = false; releaseRecall?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
