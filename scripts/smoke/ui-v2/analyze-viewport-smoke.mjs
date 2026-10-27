// Analyze viewport smoke — fixture-backed (same stack as games/scout smokes).
// Checks at 1440x900 / 1180x900 / 982x614 / 390x844 / 390x660:
//   - no horizontal overflow, no console errors
//   - COOP/COEP headers → the real browser Stockfish is available
//   - demo PGN runs through the REAL pipeline: server stubs provide prepare
//     (depth 4, Maia off) + classify-save; Stockfish evaluates 5 positions
//   - coach card, win-chance chart, move grid, class bars render
//   - board-side eval bar shows the real white share and tracks the ply
import { createServer } from "node:http";
import { hitAreaSource } from "./hit-area.mjs";
import { checkPhoneBoard } from "./phone-board.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { Chess } from "chess.js";
import { checkAnalyzeStability } from "./analyze-stability.mjs";

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
// A request the smoke holds open must arrive; if it never does, fail by name
// instead of waiting forever (closing the browser would not end this process).
const arrives = (promise, label, ms = 20000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s waiting for ${label}`)), ms).unref()),
]);

// Recent analyses starts collapsed on a phone, so recalling a saved game from
// it means opening it first. Phones raise the sources as a sheet, where one row
// opens the list in place; a wide panel has the drawer inline.
async function openGamesSheet(page) {
  const button = page.locator('#view-analyze [data-sheet-open="analyze-open"]');
  if (await button.isVisible() && (await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const reveal = page.locator('#analyze-open [data-reveal="#history-drawer"]');
  if (await reveal.isVisible() && (await reveal.getAttribute("aria-expanded")) !== "true") await reveal.click();
  // Opening the drawer reloads the list (its toggle event), replacing every row:
  // a row focused before that reload lands is gone, and Enter recalls nothing.
  // So wait for the toggle, then for the reloaded rows.
  await page.locator("#history-drawer").evaluate((d) => (d.open ? null : new Promise((resolve) => {
    d.addEventListener("toggle", () => resolve(), { once: true });
    d.open = true;
  })));
  await page.waitForFunction(() => document.querySelector("#analysis-history .history-item") &&
    !document.querySelector("#analysis-history > .hint"), null, { timeout: 10000 });
}

// A short or narrow panel, and a phone, show one pillar at a time behind tabs.
async function showPane(page, pane, probe) {
  if (await page.locator(probe).isVisible()) return;
  await page.locator(`#an-tab-${pane}`).click();
}

async function runViewport(vp) {
  console.log(`[analyze-smoke] ${vp.name}`); // names the viewport a thrown step dies in
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  // The linked account's Lichess profile is fetched cross-origin; serve it here.
  await page.route("https://lichess.org/api/user/**", (route) => route.fulfill({
    status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ id: "me_user", username: "me_user", perfs: {} }),
  }));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };
  // Last game and Analyze close the coach's line (the panel has no head strip).
  // Both must sit inside that row, on its right end, with the word "Coach" and
  // the phase chip to their left and the card's height unchanged by the chip.
  const checkPanelHead = async (state) => {
    if (vp.width <= 760) {
      // Phones: Analyze is the pill in the thumb bar; Last game is a row in the Games sheet.
      // Measure the settled layout: a caption moving into the strip or a
      // board transition still running reads a few px off on a slow runner.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const phone = await page.evaluate(() => {
        const bar = document.querySelector("#view-analyze .board-bar").getBoundingClientRect();
        const pill = document.getElementById("run-analysis").getBoundingClientRect();
        // The pill floats in the bar's free middle; nothing may paint over a
        // control, or the covered one can't be tapped.
        const covered = ["analysis-prev", "analysis-next", "analysis-flip", "run-analysis"]
          .filter((id) => {
            const el = document.getElementById(id);
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return !top || !(top === el || el.contains(top));
          });
        // Text is not a control, so the hit-test above misses a label painted
        // under the pill: compare boxes instead.
        const overText = [...document.querySelectorAll("#view-analyze .board-bar *")]
          .filter((el) => el !== document.getElementById("run-analysis") &&
            !el.contains(document.getElementById("run-analysis")) &&
            !document.getElementById("run-analysis").contains(el) && el.textContent.trim())
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width && r.height &&
              Math.min(pill.right, r.right) - Math.max(pill.left, r.left) > 0.5 &&
              Math.min(pill.bottom, r.bottom) - Math.max(pill.top, r.top) > 0.5;
          })
          .map((el) => el.id || el.className);
        // The desktop caption is hidden on phones; the eval row names the position.
        const caption = document.getElementById("analysis-board-caption");
        const captionVisible = !!caption && caption.getBoundingClientRect().width > 0 &&
          getComputedStyle(caption).display !== "none";
        // Round 5: before a game has a graph, the game's name takes the 44px
        // strip over the board that the eval and graph hold afterwards. It is
        // one ellipsised line in that strip, never a second caption.
        const evalCard = document.getElementById("analysis-eval-card");
        const evalShown = !!evalCard && !evalCard.hidden && evalCard.getBoundingClientRect().height > 0;
        const boardTop = document.getElementById("analysis-board").getBoundingClientRect().top;
        const capRect = caption?.getBoundingClientRect();
        const captionInStrip = captionVisible && !evalShown && capRect.height <= 44.5 &&
          capRect.bottom <= boardTop + 1 && capRect.top >= 0 &&
          getComputedStyle(caption).whiteSpace === "nowrap" && caption.scrollHeight <= caption.clientHeight + 1;
        const moveRow = document.getElementById("analysis-ev-move");
        const moveShown = !!moveRow && moveRow.getBoundingClientRect().width > 0 &&
          getComputedStyle(moveRow).display !== "none";
        const rows = [...document.querySelectorAll("#analyze-open .sheet-row")].map((el) => el.textContent.trim());
        return { inBar: pill.width > 0 && pill.top >= bar.top - 1 && pill.bottom <= bar.bottom + 1 && pill.left >= bar.left && pill.right <= bar.right,
          rows, covered, overText, captionVisible, captionInStrip, evalShown, moveShown,
          moveText: (moveRow?.textContent || "").trim(), pill: pill.toJSON() };
      });
      const wantsRows = ["Last game", "Past analyses"];
      check(phone.inBar && wantsRows.every((label) => phone.rows.includes(label)) &&
        phone.covered.length === 0 && phone.overText.length === 0 && (!phone.captionVisible || phone.captionInStrip),
        `${state}: Analyze must sit in the thumb bar with no overlap, the caption hidden or one line in the strip over the board when there is no graph, and one sheet carrying Last game and Past analyses: ${JSON.stringify(phone)}`);
      return phone.pill;
    }
    const layout = await page.evaluate(() => {
      const head = document.querySelector("#analysis-explain .cc-head");
      const bounds = head.getBoundingClientRect();
      const coachWord = head.querySelector("b").getBoundingClientRect();
      const buttons = ["fetch-my-game", "run-analysis"].map((id) => {
        const button = document.getElementById(id);
        const rect = button.getBoundingClientRect();
        return { id, inHead: head.contains(button) && rect.width > 0 && rect.height > 0 &&
          rect.left >= bounds.left && rect.right <= bounds.right &&
          rect.top >= bounds.top && rect.bottom <= bounds.bottom,
        // Right of the word "Coach": the action row closes the line.
        rightOfCoach: rect.left >= coachWord.right,
        bounds: rect.toJSON() };
      });
      // One row: every part of the head is on the same line, whatever the chip says.
      const oneRow = [...head.children].every((el) => {
        const r = el.getBoundingClientRect();
        return !r.height || Math.abs((r.top + r.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 4;
      });
      return { buttons, head: bounds.toJSON(), oneRow, rows: [...head.children].map((el) => el.getBoundingClientRect().toJSON()),
        headless: !document.querySelector("#analyze-sidebar > .panel-head"),
        caption: (document.getElementById("analysis-board-caption").textContent || "").trim() };
    });
    // The panel has no strip above the verdict any more, and the two actions
    // close the coach's one line at its right end.
    check(layout.headless, `${state}: the panel must have no head strip: ${JSON.stringify(layout)}`);
    check(layout.buttons.every((b) => b.inHead && b.rightOfCoach) && layout.oneRow,
      `${state}: Last game / Analyze must sit on the coach's line, right of its title, on one row: ${JSON.stringify(layout)}`);
    return { ...layout.head, oneRow: layout.oneRow };
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
        // The analyzed game's own text, as the real server returns it (the client
        // re-parses this for its variations and refuses a run without it).
        pgn: DEMO_PGN_MOVETEXT,
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
  // Recent analyses ships open on a desktop, so an idle panel offers the games to
  // reopen; on a phone it sits closed in the Games sheet. It loads the moment it
  // is opened and never opens empty.
  await page.waitForTimeout(200);
  const historyOpen = await page.locator("#history-drawer").evaluate((d) => d.open);
  const shipsOpen = vp.width >= 861;
  check(historyOpen === shipsOpen, `recent analyses should start ${shipsOpen ? "open" : "collapsed"}`);
  await page.locator("#history-drawer").evaluate((d) => { d.open = true; });
  await page.waitForFunction(
    () => document.querySelectorAll("#history-drawer .history-item").length === 2,
    null, { timeout: 10000 },
  ).catch(() => {});
  const historyRows = await page.locator("#history-drawer .history-item").count();
  check(historyRows === 2, `recent analyses should list the 2 fixture games once opened, got ${historyRows}`);
  await page.locator("#history-drawer").evaluate((d) => { d.open = false; });
  if (vp.width <= 760) {
    // The one bottom button: both rows open their view inside the sheet, and
    // neither lowers it, so a thumb picks a game without losing the screen.
    const sheetRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#analyze-open .sheet-row")];
      const row = (label) => rows.find((el) => el.textContent.trim() === label);
      const sheet = document.getElementById("analyze-open");
      // With no game loaded the sources sit inline under the board; with one
      // they are a sheet over it. Either way the rows are on screen.
      const sheetShown = () => {
        const r = sheet.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const before = sheetShown();
      const out = {};
      for (const [label, drawer] of [["Past analyses", "history-drawer"], ["Paste a PGN", "pgn-drawer"]]) {
        const button = row(label);
        button.click();
        const target = document.getElementById(drawer);
        const r = target.getBoundingClientRect();
        out[label] = {
          expanded: button.getAttribute("aria-expanded"),
          open: target.open,
          shown: r.width > 0 && r.height > 0,
          sheetUp: sheetShown(),
        };
        button.click();
      }
      // Last game is a mirror: it closes the sheet and clicks the control.
      out["Last game"] = { mirror: row("Last game")?.dataset.mirror };
      return { before, out };
    });
    check(sheetRows.before, "the games button should show its rows");
    for (const label of ["Past analyses", "Paste a PGN"]) {
      const state = sheetRows.out[label];
      check(state.expanded === "true" && state.open && state.shown && state.sheetUp,
        `"${label}" should open its view in place and leave the sheet up: ${JSON.stringify(state)}`);
    }
    check(sheetRows.out["Last game"].mirror === "#fetch-my-game",
      `"Last game" should load the latest game: ${JSON.stringify(sheetRows.out["Last game"])}`);
  }
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
  // wait on the RESULTS, not a fixed sleep.
  await page.waitForFunction(
    () =>
      !document.getElementById("analysis-results").hidden &&
      document.querySelectorAll("#analysis-moves .mtree-move").length >= 5 &&
      document.querySelectorAll("#analysis-summary .rp-side").length > 0,
    null,
    { timeout: 20000 },
  );
  const chartKids = await page.locator("#eval-chart *").count();
  check(chartKids > 0, "eval chart should have rendered the eval graph");
  const movesRows = await page.locator("#analysis-moves .mtree-move").count();
  check(movesRows >= 5, `move grid should list the game's plies, got ${movesRows}`);
  const classBars = await page.locator("#analysis-summary .rp-side").count();
  check(classBars === 2, `the report should show White + Black accuracy, got ${classBars}`);

  check(await page.locator("#analysis-job-dock .notice").count() === 0, "completed analysis progress must disappear immediately");

  // Exercise shared live evaluation and rapid forward/back navigation with the
  // real worker, not a mirrored test implementation.
  await showPane(page, "engine", "#open-engine-widget");
  const engineSpot = await page.evaluate(() => {
    const r = document.getElementById("open-engine-widget").getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const coach = document.getElementById("analysis-explain").getBoundingClientRect();
    return { engine: r.toJSON(), top: top && (top.id || top.className), coach: coach.toJSON() };
  });
  console.log(`[analyze-smoke] engine button: ${JSON.stringify(engineSpot)}`);
  await page.locator("#open-engine-widget").click();
  // The full net's unlock row sits above the lines and never blocks them: the
  // first real line must appear with the row still up.
  await page.waitForFunction(() => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)"), null, { timeout: 20000 });
  const askedWhileSearching = await page.evaluate(() => {
    const row = document.getElementById("engine-window-unlock");
    const line = document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)");
    return { asked: !!row && !row.hidden, line: !!line, rowAboveLine: !!row && !!line && row.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING };
  });
  check(askedWhileSearching.line, "the engine card must show a line while the full-net unlock row is up");
  check(!askedWhileSearching.asked || askedWhileSearching.rowAboveLine,
    `the full-net unlock row must sit above the lines, not replace them: ${JSON.stringify(askedWhileSearching)}`);
  // Put it away after the lines are there: the search must not stop or restart.
  await page.locator('#engine-window-unlock [data-unlock-act="dismiss"]').click({ timeout: 2000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)"), null, { timeout: 20000 });
  await page.evaluate(async () => {
    for (const id of ["analysis-next", "analysis-next", "analysis-prev", "analysis-next", "analysis-prev", "analysis-next"]) {
      document.getElementById(id).click();
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await page.waitForFunction(() => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending)"), null, { timeout: 20000 });
  await showPane(page, "coach", "#explain-engine-toggle");
  await shot("coach");
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
  await showPane(page, "engine", "#open-engine-widget");
  const engineLayout = await page.evaluate(() => {
    // The engine is its own pillar: its name, depth and Live switch on one
    // header row, its lines inside the pane.
    const pane = document.getElementById("analysis-engine-pane").getBoundingClientRect();
    const engine = document.getElementById("engine-window-pvs").getBoundingClientRect();
    const coach = document.getElementById("analysis-explain").getBoundingClientRect();
    const head = ["#open-engine-widget", "#analysis-engine-pane .an-pane-head > b"].map((sel) => document.querySelector(sel).getBoundingClientRect())
      .filter((r, i) => i === 0 || r.width > 0);
    const oneRow = head.every((r) => r.width > 0 && Math.abs((r.top + r.bottom) / 2 - (head[0].top + head[0].bottom) / 2) < 4 &&
      r.left >= pane.left && r.right <= pane.right + 1);
    return { pane: [pane.left, pane.right], engine: [engine.left, engine.right, engine.width], fits: engine.width > 0 && engine.left >= pane.left && engine.right <= pane.right + 1 && oneRow, oneRow, coachHeight: window.innerWidth <= 760 ? 0 : coach.height,
      scrollOverflow: document.querySelector("#analyze-sidebar .panel-scroll").scrollWidth - document.querySelector("#analyze-sidebar .panel-scroll").clientWidth };
  });
  check(engineLayout.fits && engineLayout.scrollOverflow <= 1, `Engine must fit its pane: ${JSON.stringify(engineLayout)}`);
  check(engineLayout.coachHeight <= 180, "Coach must keep its reserved verdict, Humans and prep rows compact");
  await checkAnalyzeStability(page, vp.width <= 760, check);
  await shot("engine");
  await page.locator("#open-engine-widget").click();
  await page.evaluate(() => document.getElementById("analysis-start").click());

  // Composition: the two actions close the coach's line (there is no desktop
  // top bar and no panel head strip), the bar under the board names the game,
  // the mainline is a number | White | Black grid inside the panel, and the
  // board has no side eval bar, so it lines up with Build and Train.
  if (vp.width > 760) await showPane(page, "moves", "#analysis-moves");
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const white = box("#analysis-moves .mtree-move.is-white");
    const black = box("#analysis-moves .mtree-move.is-black");
    const num = box("#analysis-moves .mtree-num");
    // Phones dissolve the sidebar and the pane box (display: contents) and put
    // the eval band over the board; the pane switch heads the panel under it.
    const panel = ["#analyze-sidebar", "#analyze-panes", "#analyze-tabs"].map(box).find((r) => r.height);
    const boardBox = box("#analysis-board");
    return {
      sameRow: Math.abs(white.top - black.top) < 2,
      order: num.right <= white.left + 1 && white.right <= black.left + 1,
      // The bar under the board names the game. This PGN has no player tags, so
      // the name is the game's half-move count (a phone hides the bar's slot and
      // reads the position in its eval row instead).
      boardCaption: /\d+ half-moves?/.test(document.getElementById("analysis-board-caption").textContent),
      glyphs: document.querySelectorAll("#analysis-moves .mtree-glyph").length,
      noEvalBar: !document.getElementById("analysis-evalbar"),
      panelNextToBoard: window.innerWidth > 860 ? panel.left >= boardBox.right : panel.top >= boardBox.bottom,
    };
  });
  // Phones lay the score sheet under the coach and the eval chart above the
  // board; the sheet may scroll, the screen may not.
  if (vp.width > 760) check(layout.sameRow && layout.order, `move grid should lay number | White | Black in one row: ${JSON.stringify(layout)}`);
  await checkPanelHead("results");
  check(layout.boardCaption, "the bar under the board should name the game");
  check(layout.glyphs >= 1, "classified moves should carry a glyph");
  check(layout.noEvalBar, "the Analyze board should not carry a side eval bar");
  check(layout.panelNextToBoard, "the panel should sit beside (or, stacked, below) the board");

  await page.evaluate(() => document.getElementById("analysis-next").click());
  await page.waitForTimeout(300);
  // The coach's line is one row on every ply: the card under it keeps its top
  // while the board advances. Measured here at every desktop viewport with the
  // longest phase word forced, the state that wrapped the row before (982:
  // "Middlegame" pushed the evaluation card down 10px).
  if (vp.width > 760) {
    const drill = await page.evaluate(async () => {
      const chip = document.getElementById("coach-phase");
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const head = () => document.querySelector("#analysis-explain .cc-head");
      const tops = () => {
        const h = head().getBoundingClientRect();
        const coach = document.getElementById("analysis-explain").getBoundingClientRect();
        const card = document.getElementById("analysis-eval-card").getBoundingClientRect();
        const oneRow = [...head().children].every((el) => {
          const r = el.getBoundingClientRect();
          return !r.height || Math.abs((r.top + r.bottom) / 2 - (h.top + h.bottom) / 2) < 4;
        });
        return { coachTop: Math.round(coach.top), cardTop: Math.round(card.top), headH: Math.round(h.height), oneRow };
      };
      const rows = [];
      for (const word of ["Opening", "Middlegame", "Endgame"]) {
        chip.hidden = false;
        chip.textContent = word;
        chip.title = word;
        await wait(120);
        rows.push({ word, ...tops() });
      }
      // Step every ply with the two-word chip still on.
      await document.getElementById("analysis-start").click();
      await wait(200);
      for (let i = 0; i < 6; i += 1) {
        document.getElementById("analysis-next").click();
        await wait(220);
        rows.push({ word: "Middlegame (stepped)", ...tops() });
      }
      // Back to the ply the caller left the board on (1): the rest of the run
      // plays a variation from there.
      document.getElementById("analysis-start").click();
      await wait(200);
      document.getElementById("analysis-next").click();
      await wait(300);
      return rows;
    });
    const coachTops = [...new Set(drill.map((r) => r.coachTop))];
    const cardTops = [...new Set(drill.map((r) => r.cardTop))];
    const headHs = [...new Set(drill.map((r) => r.headH))];
    check(drill.every((r) => r.oneRow), `the coach's line must stay one row whatever the phase chip says: ${JSON.stringify(drill)}`);
    check(coachTops.length === 1 && headHs.length === 1 && cardTops.length === 1,
      `the coach card must not move when the board advances: ${JSON.stringify({ coachTops, cardTops, headHs, drill })}`);
  }
  await shot("results");
  const caption = await page.locator("#analysis-chart-caption").textContent();
  check(/^([+−]?\d+\.\d{2}|[+−]M|#-?\d+)$/.test(caption || ""), `the chart caption should show the current eval, got "${caption}"`);
  // The bar under the board keeps naming the game as the board steps, and a
  // phone's eval row names the move on show (its bar slot is hidden).
  const naming = await page.evaluate(() => ({
    caption: (document.getElementById("analysis-board-caption").textContent || "").trim(),
    tip: document.getElementById("analysis-board-caption").title,
    moveText: (document.getElementById("analysis-ev-move").textContent || "").trim(),
  }));
  check(naming.caption.length > 0 && naming.tip === naming.caption, `the bar under the board should name the game, with the same text in its tooltip: ${JSON.stringify(naming)}`);
  if (vp.width <= 760) check(/^\d+\.{1,3}\s\S+/.test(naming.moveText), `a phone's eval row should name the move on the board, got "${naming.moveText}"`);
  // A side line played on the board interrupts the mainline grid as a
  // full-width row and the mainline resumes in its own columns afterwards.
  await page.locator('[data-testid="analysis-board"] [data-square="d7"]').click();
  await page.locator('[data-testid="analysis-board"] [data-square="d5"]').click();
  await page.waitForSelector("#analysis-moves .mtree-var", { state: "attached", timeout: 5000 });
  if (vp.width > 760) await showPane(page, "moves", "#analysis-moves");
  const variation = await page.evaluate(() => {
    const grid = document.querySelector("#analysis-moves .mtree-line.is-main").getBoundingClientRect();
    const v = document.querySelector("#analysis-moves .mtree-var").getBoundingClientRect();
    return {
      fullWidth: v.width > grid.width * 0.8,
    };
  });
  if (vp.width > 760) {
    check(variation.fullWidth, "a variation should span the full grid width");
  }
  if (vp.width <= 760) {
    // The phone's screen is one column: the eval band (figure and graph), the
    // board, the move strip, the pane switch heading its sheet, the open pane
    // (here the coach) under it, then the thumb bar. The grading switch lives in
    // the engine pane on a phone, so the Coach tab itself says which pane is open.
    if (await page.locator("#an-tab-coach").getAttribute("aria-selected") !== "true") await page.locator("#an-tab-coach").click();
    await page.waitForFunction(() => document.getElementById("view-analyze").dataset.pane === "coach", null, { timeout: 5000 });
    const stack = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null;
      };
      const coach = document.querySelector("#analysis-explain");
      const prose = document.getElementById("coach-prose");
      const moves = document.querySelector("#analysis-moves");
      const bar = document.querySelector("#view-analyze .board-bar").getBoundingClientRect();
      return {
        chart: box("#analysis-eval-graph:not([hidden])"),
        board: box("#analysis-board"),
        strip: box("#analysis-moves"),
        coach: box("#analysis-explain"),
        proseBottom: Math.round(prose.getBoundingClientRect().bottom),
        tabs: box("#analyze-tabs"),
        barTop: Math.round(bar.top),
        coachFits: coach.scrollHeight <= coach.clientHeight + 1,
        coachScroll: [coach.scrollHeight, coach.clientHeight],
        coachKids: [...coach.querySelectorAll(":scope > *, :scope > * > *")].filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => `${el.id || el.className}:${Math.round(el.getBoundingClientRect().top)}-${Math.round(el.getBoundingClientRect().bottom)}`),
        pageScrolls: document.getElementById("view-analyze").scrollHeight >
          document.getElementById("view-analyze").clientHeight + 1,
      };
    });
    const inOrder = !!(stack.chart && stack.board && stack.strip && stack.tabs && stack.coach) &&
      stack.chart.bottom <= stack.board.top + 1 &&
      stack.board.bottom <= stack.strip.top + 1 &&
      stack.strip.bottom <= stack.tabs.top + 1 &&
      stack.tabs.bottom <= stack.coach.top + 1 &&
      stack.coach.bottom <= stack.barTop + 1;
    check(inOrder, `phone stack must be eval band, board, move strip, tabs, coach, thumb bar: ${JSON.stringify(stack)}`);
    // The graph is the scrubber: it keeps a finger-sized band on short screens.
    // Round 5 draws it 32px (Lichess-density); its target is the 44px strip
    // round it (the wrap's ::before band), measured where a finger lands.
    const graphHit = await page.locator("#analysis-eval-graph").evaluate((el, src) => eval(src)(el), hitAreaSource);
    check(graphHit.h >= 44 && graphHit.drawnH <= 36, `the phone graph must keep a 44px scrub target round a compact field, got ${JSON.stringify(graphHit)}`);
    check(stack.coachFits, `the reserved Coach rows and controls must fit inside their band: ${JSON.stringify(stack)}`);
    check(!stack.pageScrolls, "the phone Analyze screen must not scroll as a page");
    // Round 5: the board is one size in every tab; it never shrinks for a pane.
    for (const tab of ["coach", "engine", "report", "coach"]) {
      const el = page.locator(`#an-tab-${tab}`);
      if (!(await el.isVisible())) continue;
      await el.click();
      await page.waitForFunction((t) => document.getElementById("view-analyze").dataset.pane === t, tab, { timeout: 5000 }).catch(() => {});
      const held = await checkPhoneBoard(page, { view: "view-analyze", board: "analysis-board", tabs: "#analyze-tabs [role=tab]", label: `Analyze ${tab}` });
      for (const f of held.fails) check(false, f);
    }
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
  await page.locator('.history-item[data-game-id="g1"] .hi-open').focus();
  await page.keyboard.press("Enter");
  await arrives(recallRequested, "the history recall request (/api/analyses/g1)");
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
  await page.locator('.history-item[data-game-id="g2"] .hi-open').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /opp_two/.test(document.getElementById("analysis-board-caption").textContent));
  check(await page.locator("#analysis-board [data-square]").first().getAttribute("data-square") === "h1", "a recalled Self-as-Black game should face Black");
  const recalledPgn = await page.locator("#pgn-input").inputValue();
  check(recalledPgn.includes('[Black "me_user"]') && recalledPgn.includes('[Result "1-0"]'), "recalled PGN should retain its game metadata");
  // A long recalled name must not wrap the coach's line: the row keeps its one
  // height from the top of the report to the bottom of it.
  const recalledHead = await checkPanelHead("long recalled title");
  if (vp.width > 760) {
    await page.locator("#analyze-sidebar .panel-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const scrolledHead = await checkPanelHead("scrolled recalled report");
    // The row is inside the scroller, so its position changes with the scroll;
    // its height must not (a wrapped line would be 4px taller).
    check(Math.abs(recalledHead.height - scrolledHead.height) < 1 && scrolledHead.oneRow,
      `scrolling the report must not change the coach's line: ${JSON.stringify([recalledHead, scrolledHead])}`);
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
    // With a game loaded the sources sit behind the Games button.
    await openGamesSheet(page);
    await page.locator("#pgn-drawer").evaluate((d) => { d.open = true; });
    await page.locator("#pgn-input").fill(DEMO_PGN_MOVETEXT);
    await page.locator("#run-analysis").click();
    await arrives(saveRequested, "the review save request", 60000);
    await openGamesSheet(page);
    await page.locator('.history-item[data-game-id="g2"] .hi-open').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("pgn-input").value.includes('[Black "me_user"]'));
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
