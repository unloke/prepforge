import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Chess } from "chess.js";

const baseline = process.env.ANALYZE_IMPORT_BASELINE === "1";
const shots = process.env.ANALYZE_IMPORT_SHOTS;
const rejected = '[White "Not Morphy"]\n[Black "Not Duke"]\n[Result "0-1"]\n\n1. Qh9 0-1';
const invalidFen = '[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n\n1. e4 e5 *';
const multi = '[Event "G1"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 *\n\n[Event "G2"]\n[White "Carol"]\n[Black "Dave"]\n\n1. d4 d5 2. c4 e6 *';
const chess = new Chess();
const moves = ["d4", "d5", "c4", "e6"].map((san, i) => {
  const before = chess.fen(), m = chess.move(san);
  return { ply: i + 1, san, uci: m.lan, fen_before: before, fen_after: chess.fen(),
    move_number: Number(before.split(" ")[5]), side: m.color === "w" ? "white" : "black", classification: "good" };
});
const review = { game_id: "import-review", white: "Morphy", black: "Duke", result: "*", moves,
  eval_graph: moves.map((m) => ({ ply: m.ply, score_cp: 0, bounded_score_cp: 0 })), position_evals: {}, summary: {}, depth: 4 };
const repertoire = { id: "import-prep", name: "Queen's Gambit", color: "white", root_fen: new Chess().fen(),
  is_active: true, tags: [], notes: "", visibility: "private", health: { trainable: 3, mastered: 1, due: 2 } };
const api = (path) => {
  if (path === "/api/auth/me") return { id: "import-user", display_name: "Analyze QA", email: "analyze@example.test" };
  if (path === "/api/auth/providers") return { google: false };
  if (path === "/api/csrf") return { csrf_token: "fixture" };
  if (path === "/api/settings") return { stockfish_depth: 4, maia_rating: null };
  if (path === "/api/repertoires") return { repertoires: [repertoire], shared: [] };
  if (path === "/api/repertoires/import-prep") return { ...repertoire, nodes: moves.map((m) => ({ id: `n${m.ply}`, parent_id: m.ply > 1 ? `n${m.ply - 1}` : null, fen: m.fen_after, uci: m.uci })) };
  if (path === "/api/dashboard") return { games: 1, repertoires: 1, training_sessions: 1, due_reviews: 2, due_soon: 0,
    open_mistakes: 0, streak: { current: 1, best: 1, trained_today: true }, recap: {}, recommendations: [] };
  if (path === "/api/analyses") return { analyses: [{ ...review, created_at: "2026-11-20T12:00:00Z" }] };
  if (path === "/api/analyses/import-review") return review;
  if (path.startsWith("/api/lichess")) return { linked: false, accounts: [] };
  if (path.startsWith("/api/training")) return { sessions: [{ id: "import-training", repertoire_id: repertoire.id, completed: true, correct: 3, total: 3 }] };
  return {};
};
const dir = fileURLToPath(new URL("../../../src/prepforge_chess/web/static/", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(api(path))); return;
  }
  try {
    const file = await readFile(join(dir, path === "/" ? "index.html" : path.replace(/^\/static\//, "")));
    res.writeHead(200, { "Content-Type": path === "/" ? "text/html" : mime[extname(path)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }); res.end(file);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  if (shots) await mkdir(shots, { recursive: true });
  for (const [size, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const capture = async (bug) => {
      if (shots) await page.screenshot({ path: join(shots, `analyze-bug${bug}-${baseline ? "before" : "after"}-${size}.png`), fullPage: true });
    };
    const openSheet = async () => {
      const button = page.locator('#view-analyze [data-sheet-open="analyze-open"]');
      if (await button.isVisible() && await button.getAttribute("aria-expanded") !== "true") await button.click();
    };
    const closeSheet = async () => {
      const button = page.locator('#analyze-open [data-sheet-close]');
      if (await button.isVisible()) await button.click();
    };
    const restore = async () => {
      await page.goto(`${base}/#/analyze`);
      await page.waitForFunction(() => document.querySelector('#view-analyze:not([hidden])'));
      // The view shows before its lazy stylesheet lands. Until then the phone bar's
      // shared rule (phone/study.css) shows the Games button that Analyze's own
      // phone.css hides when no game is open, so a cold load could see it visible
      // and then click it after it had gone.
      await page.waitForFunction(() => [...document.styleSheets].some((sheet) => /\/assets\/analyze-[^/]*\.css$/.test(sheet.href || "")));
      await page.evaluate(() => {
        for (const key of Object.keys(sessionStorage)) if (key.startsWith("prepforge.return_state.v1.")) sessionStorage.removeItem(key);
      });
      await openSheet();
      await page.locator("#history-drawer").evaluate((el) => { el.hidden = false; el.open = true; });
      await page.locator('.hi-open').first().click();
      await page.waitForFunction(() => document.getElementById("analysis-board-caption")?.textContent.includes("Morphy"));
      await closeSheet();
    };
    const paste = async (text) => {
      await openSheet();
      await page.locator("#pgn-drawer").evaluate((el) => { el.open = true; });
      await page.locator("#pgn-input").fill(text);
      await page.locator("#open-pgn").click();
      // Let the debounced live import settle as well as the explicit Open.
      await page.waitForTimeout(500);
    };
    await restore();
    await paste(rejected);
    assert.match(await page.locator("#pgn-error").innerText(), /Invalid move: Qh9/);
    if (!baseline) assert.match(await page.locator("#analysis-board-caption").innerText(), /^Morphy vs Duke/);
    await capture(1);
    await page.locator('[data-copy="pgn"]').evaluate((el) => el.click());
    const exported = await page.evaluate(() => navigator.clipboard.readText());
    if (!baseline) { assert.match(exported, /White "Morphy"/); assert.doesNotMatch(exported, /Not Morphy|Qh9/); }
    console.log(`[analyze-import-smoke] ${size} rejected import: ${JSON.stringify({ caption: await page.locator("#analysis-board-caption").innerText(), exported })}`);

    await restore();
    await paste(invalidFen);
    if (!baseline) { assert.equal(await page.locator("#pgn-error").isVisible(), true); assert.match(await page.locator("#pgn-error").innerText(), /FEN/); }
    await capture(2);

    await restore();
    await page.locator('#analysis-moves [data-node-id="m4"]').click();
    for (const [from, to] of [["e2", "e4"], ["g8", "f6"]]) {
      await page.locator(`#analysis-board [data-square="${from}"]`).click();
      await page.locator(`#analysis-board [data-square="${to}"]`).click();
      await page.waitForFunction((suffix) => location.hash.endsWith(suffix), to === "e4" ? "e2e4" : "g8f6");
    }
    const hash = new URL(page.url()).hash;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#analysis-moves .mtree-move").length >= 4);
    await page.waitForTimeout(800);
    if (!baseline) {
      assert.equal(new URL(page.url()).hash, hash);
      assert.match(await page.locator("#analysis-ev-move").innerText(), /Nf6/);
      assert.equal(await page.locator('#analysis-board [data-square="f6"]').getAttribute("data-piece"), "n");
    }
    console.log(`[analyze-import-smoke] ${size} continuation reload: ${new URL(page.url()).hash}`);
    await capture(3);

    await restore();
    await paste(multi);
    assert.equal(await page.locator("#pgn-error").isVisible(), true);
    if (!baseline) { assert.match(await page.locator("#pgn-error").innerText(), /Review.*Analyze batch/); assert.match(await page.locator("#analysis-board-caption").innerText(), /^Morphy vs Duke/); }
    await capture(4);
    await context.close();
  }
  console.log(`[analyze-import-smoke] ${baseline ? "baseline captured" : "ok — four import/restore regressions on desktop and mobile"}`);
} finally { await browser.close(); server.close(); }
