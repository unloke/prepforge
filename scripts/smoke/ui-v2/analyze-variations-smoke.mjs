// Analyze off-mainline smoke — fixture-backed, PRODUCTION build (no E2E hooks).
//
// A variation and the mainline can share a move number and still be different
// positions. This pins the one rule that keeps them apart: the selected tree node
// is what the board, the caption, the Coach's read and the engine card all
// describe. It drives the real UI over a legal PGN with a nested variation
// (1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5 (3... Nf6 4. d3) 4. c3) 3... a6 4. Ba4 Nf6),
// where `m5` (3. Bb5) and `v1` (3. Bc4) are both move 3.
//
// Checks:
//   - clicking a branch puts ITS fen on the board and names it in the caption
//   - the Coach's read changes with the branch (no stale mainline verdict)
//   - the engine card re-searches: its PV is LEGAL in the selected position
//     (checked here in Node with chess.js) and its score changes per position
//   - a fast variation→mainline burst settles on the last click
//   - ArrowLeft walks the branch's parent chain back to the mainline trunk
//   - a reload restores the branch (?node=), not the mainline ply
//   - a branch the USER plays (creation order ≠ traversal order) comes back as the
//     same position after a reload, and the saved PGN carries it
//   - with two games in the box, the analyzed game keeps only ITS own branches
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { Chess } from "chess.js";

const PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5 (3... Nf6 4. d3) 4. c3) 3... a6 4. Ba4 Nf6";
const MAINLINE_SANS = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"];
// Every position this smoke asserts, derived with chess.js in Node (the browser
// engine evaluates these REAL FENs; the classification labels below are a
// deterministic stand-in for the server classifier).
const fenOf = (sans) => { const c = new Chess(); for (const s of sans) c.move(s); return c.fen(); };
const MAINLINE = (() => {
  const chess = new Chess();
  return MAINLINE_SANS.map((san, i) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    return { ply: i + 1, move_number: Number(fenBefore.split(" ")[5]), side: mv.color === "w" ? "white" : "black",
      san: mv.san, uci: `${mv.from}${mv.to}${mv.promotion || ""}`, fen_before: fenBefore, fen_after: chess.fen() };
  });
})();
const FENS = MAINLINE.map((m) => m.fen_after);
// A second game whose movetext CONCATENATES legally after the first, so parsing the
// whole textarea would glue them into one game and hang G2's branch off G1's last
// move. The server analyzes one game at a time and returns that game's own PGN.
const G2_PGN = '[Event "G2"]\n[White "Carol"]\n[Black "Dave"]\n[Result "*"]\n\n1. d4 d5 2. c4 (2. Nf3 Nf6) e6 *';
const NODE_FEN = {
  m3: fenOf(["e4", "e5", "Nf3"]),
  m4: fenOf(["e4", "e5", "Nf3", "Nc6"]),
  m5: fenOf(["e4", "e5", "Nf3", "Nc6", "Bb5"]),
  v1: fenOf(["e4", "e5", "Nf3", "Nc6", "Bc4"]),
  v3: fenOf(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3"]),
  v4: fenOf(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"]),
  v5: fenOf(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3"]),
};

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.ANALYZE_VARIATIONS_SMOKE_PORT || 8809);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/settings")) return { stockfish_depth: 4, maia_rating: null };
  if (path.startsWith("/api/repertoires")) return { repertoires: [], shared: [] };
  if (path.startsWith("/api/analyses")) return { analyses: [] };
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 0, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess")) return { linked: false, accounts: [] };
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
if (!browser) { console.error("[analyze-variations-smoke] no browser"); server.close(); process.exit(2); }

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const base = `http://127.0.0.1:${PORT}`;

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
// The multi-game check deliberately trips the single-game refusal (a 400), and the
// browser logs every failed response. That one is expected; anything else is not.
let expectMultiGameRefusal = false;
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (expectMultiGameRefusal && /Failed to load resource.*400/.test(m.text())) return;
  consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Server-side pipeline stubs: prepare returns the fixture's REAL FENs (the browser
// Stockfish evaluates them at depth 4); classify-save mirrors the server contract.
//
// Both games of the multi-game paste are served the way the real server does it:
// one game at a time, with that game's OWN PGN in `prepare.pgn` (never the paste).
const G2_SANS = ["d4", "d5", "c4", "e6"];
const gameTwo = (() => {
  const chess = new Chess();
  const moves = G2_SANS.map((san, i) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    return { ply: i + 1, move_number: Number(fenBefore.split(" ")[5]), side: mv.color === "w" ? "white" : "black",
      san: mv.san, uci: `${mv.from}${mv.to}`, fen_before: fenBefore, fen_after: chess.fen() };
  });
  return { gameId: "variations-smoke-g2", pgn: G2_PGN, moves, positions: moves.map((m) => m.fen_after) };
})();
// Game 1 with its own header block, so a two-game paste really is two games for the
// server's splitter (a headerless movetext is one game on its own).
const G1_PGN = `[Event "G1"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

${PGN} *`;
const gameOne = { gameId: "variations-smoke", pgn: G1_PGN, moves: MAINLINE, positions: FENS };
let prepared = gameOne;
// Every prepare POST, so the two-game switch can be checked on what the client
// actually sent (the real server splits THAT text into games).
const preparePosts = [];

await page.route("**/api/analyze/prepare", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const posted = String(body.pgn || "");
  const mode = body.mode === "multi" ? "multi" : "single";
  const selectIndex = Number(body.select_index) || 0;
  // Split the POSTED text the way python-chess does: a game starts at a header
  // block that follows a blank line (or the start of the text). A second block
  // glued straight onto the first is therefore ONE game — the merged box this
  // smoke exists to catch is one game on the server, which is why
  // `select_index 1` came back "out of range (1 games)".
  const blocks = (posted.match(new RegExp(String.raw`(?:^|\n\s*\n)\[Event\s`, "g")) || []).length;
  const games = blocks > 1 ? [gameOne, gameTwo] : [posted.includes("Carol") ? gameTwo : gameOne];
  const record = { pgn: posted, mode, selectIndex, games: games.length, status: 200 };
  preparePosts.push(record);
  // The real server's own semantics, over the text it was sent: single mode
  // refuses a multi-game paste BEFORE storing anything (the app then offers the
  // batch), and a select_index past the end of the POSTED text is a 400 that the
  // `/games in the PGN/i` recovery does NOT catch.
  if (mode === "single" && games.length !== 1) {
    record.status = 400;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
      detail: `Found ${games.length} games in the PGN — this flow analyzes one game at a time. Remove the extra games, or use multi-game mode.`,
    }) });
    return;
  }
  if (selectIndex >= games.length) {
    record.status = 400;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({
      detail: `select_index ${selectIndex} is out of range (${games.length} games).`,
    }) });
    return;
  }
  prepared = games[selectIndex];
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    game_id: prepared.gameId, pgn: prepared.pgn, depth: 4, engine: "stockfish (browser)",
    positions: prepared.positions,
    moves: prepared.moves.map((m) => ({ ply: m.ply, san: m.san })), brilliant: { enabled: false },
    import_summary: mode === "multi" ? {
      mode: "multi", total_games: games.length, imported_count: games.length, existing_count: 0, failed_count: 0,
      selected_index: selectIndex, selected_game_id: prepared.gameId,
      games: games.map((g, index) => ({ index, game_id: g.gameId, status: "imported",
        white: index === 0 ? "Alice" : "Carol", black: index === 0 ? "Bob" : "Dave", error: null })),
    } : undefined,
  }) });
});
// The saved reviews by id, as the real server keeps them: a reload recalls the
// review it was on by game id (grades, chart) and lays the session's branches on top.
const savedReviews = new Map();
await page.route(/\/api\/analyses\/[^/?]+$/, async (route) => {
  const saved = savedReviews.get(decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()));
  if (!saved || route.request().method() !== "GET") return route.fallback();
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(saved) });
});
await page.route("**/api/analyze/classify-save", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const evals = new Map((body.positions || []).map((p) => [p.fen, p]));
  const moves = prepared.moves.map((m) => {
    const after = evals.get(m.fen_after) || {};
    return { ...m, classification: "good", best_move_uci: after.best_move_uci ?? null, score_cp: after.score_cp ?? null, comment: "" };
  });
  const eval_graph = moves.map((m) => ({ ply: m.ply, san: m.san, score_cp: m.score_cp,
    bounded_score_cp: m.score_cp == null ? 0 : Math.max(-1000, Math.min(1000, m.score_cp)), classification: m.classification }));
  const position_evals = {};
  for (const p of body.positions || []) {
    position_evals[p.fen] = { score_cp: p.score_cp, mate_in: p.mate_in, best_move_uci: p.best_move_uci, pv: p.pv || [], depth: p.depth };
  }
  const saved = {
    game_id: prepared.gameId, engine: "stockfish (browser)", depth: 4, summary: {},
    position_evals, moves, eval_graph, critical_moments: [],
  };
  savedReviews.set(prepared.gameId, saved);
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(saved) });
});

// The board's position, read back out of the rendered squares.
const boardFen = () => page.evaluate(() => {
  const files = "abcdefgh";
  return [8, 7, 6, 5, 4, 3, 2, 1].map((rank) => {
    let row = "", empty = 0;
    for (let f = 0; f < 8; f += 1) {
      const piece = document.querySelector(`#analysis-board [data-square="${files[f]}${rank}"]`)?.dataset.piece || "";
      if (piece) { if (empty) { row += empty; empty = 0; } row += piece; } else empty += 1;
    }
    return empty ? `${row}${empty}` : row;
  }).join("/");
});
const readout = () => page.evaluate(() => ({
  node: document.querySelector("#analysis-moves .mtree-move.is-current")?.dataset.nodeId || null,
  caption: (document.getElementById("analysis-ev-move")?.textContent || "").trim(),
  coach: (document.getElementById("coach-prose")?.textContent || "").trim(),
  evalChip: (document.getElementById("analysis-chart-caption")?.textContent || "").trim(),
  engineEval: (document.getElementById("engine-head-eval")?.textContent || "").trim(),
  pvSans: [...document.querySelectorAll("#engine-window-pvs .engine-pv:first-child .pv-move")].map((el) => el.textContent.trim()),
  hash: location.hash,
}));
const clickNode = (id) => page.evaluate((nodeId) => {
  const button = document.querySelector(`#analysis-moves .mtree-move[data-node-id="${nodeId}"]`);
  if (!button) return false;
  button.click();
  return true;
}, id);
// A pending row says "Calculating…" (which contains letters), so the PV is only
// ready when the first row has real .pv-move nodes. That also means a row left
// over from the previous node cannot be mistaken for the new position's answer:
// the caller waits for a PV that is legal from the position it just selected.
const hasPvMoves = () => page.evaluate(() =>
  document.querySelectorAll("#engine-window-pvs .engine-pv:first-child .pv-move").length > 0);
const waitForPv = async (timeoutMs = 40000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await hasPvMoves()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

// Waits for the engine to answer the position just selected: a PV whose every
// SAN is legal from that FEN. A slow CI can still be painting the previous
// node's line, which is exactly what the check below must not read.
async function waitForLegalPv(fen, timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  let last = { ok: false, why: "no PV moves rendered" };
  while (Date.now() < until) {
    const r = await readout();
    last = pvIsLegalFrom(fen, r.pvSans);
    if (last.ok) return { readout: r, pv: last };
    await page.waitForTimeout(150);
  }
  return { readout: await readout(), pv: last };
}

// A PV is "for" a position when every SAN in it is legal from that position, in order.
function pvIsLegalFrom(fen, sans) {
  if (!sans.length) return { ok: false, why: "no PV moves rendered" };
  const chess = new Chess(fen);
  for (const san of sans) {
    try { chess.move(san.replace(/^\d+\.+\s*/, "").trim()); }
    catch (err) { return { ok: false, why: `"${san}" is illegal in ${fen.split(" ")[0]} (${err.message})` }; }
  }
  return { ok: true };
}

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelector('[data-testid="nav-analyze"]').click());
await page.waitForTimeout(600);

// Load the fixture through the real PGN input path, then run the REAL pipeline.
await page.locator("#pgn-input").evaluate((el, pgn) => {
  el.value = pgn;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, PGN);
await page.waitForFunction(() => document.querySelectorAll("#analysis-moves .mtree-move").length >= 6, null, { timeout: 10000 });
await page.evaluate(() => document.getElementById("run-analysis").click());
await page.waitForFunction(
  () => !document.getElementById("analysis-results").hidden && document.querySelectorAll("#analysis-summary .cbar-row").length > 0,
  null, { timeout: 60000 },
);
await page.waitForTimeout(1000);

// The analysis must not drop the PGN's branches: all five variation nodes survive.
const treeIds = await page.evaluate(() =>
  [...document.querySelectorAll("#analysis-moves .mtree-move")].map((b) => b.dataset.nodeId));
check(["v1", "v2", "v3", "v4", "v5"].every((id) => treeIds.includes(id)),
  `the analysed game must keep the PGN's variations in the move list: ${JSON.stringify(treeIds)}`);

await page.locator("#open-engine-widget").click();
await waitForPv();
// The engine card must actually be open before any PV is read: a card that is
// still opening has no rows, and a check would then read the wrong thing.
await page.waitForFunction(() => {
  const card = document.getElementById("engine-window");
  return !!card && !card.hidden && getComputedStyle(card).display !== "none";
}, null, { timeout: 10000 });

const evalByNode = {};
for (const [nodeId, label] of [["v1", "3. Bc4 (variation)"], ["m5", "3. Bb5 (mainline, same ply)"],
  ["v3", "4. c3 (nested variation)"], ["v5", "4. d3 (nested variation)"]]) {
  check(await clickNode(nodeId), `${label}: node ${nodeId} must be in the move list`);
  const want = NODE_FEN[nodeId];
  const { readout: r, pv } = await waitForLegalPv(want);
  const board = await boardFen();
  check(r.node === nodeId, `${label}: the move list must mark ${nodeId}, got ${r.node}`);
  check(board === want.split(" ")[0], `${label}: the board must show ${nodeId}'s position (${want.split(" ")[0]}), got ${board}`);
  check(r.caption.includes(label.split(" (")[0]), `${label}: the caption must name the move, got "${r.caption}"`);
  check(!!r.coach && !/^Reading the game/.test(r.coach), `${label}: the Coach must have a read, got "${r.coach}"`);
  check(pv.ok, `${label}: the engine's PV must be legal in the selected position — ${pv.why}`);
  check(r.engineEval === r.evalChip, `${label}: the eval chip and the engine card must agree (${r.engineEval} vs ${r.evalChip})`);
  evalByNode[nodeId] = r.engineEval;
}
// Same ply, different position ⇒ the engine must have re-read it, not kept one number.
check(new Set(Object.values(evalByNode)).size > 1,
  `the engine must re-evaluate each branch: ${JSON.stringify(evalByNode)}`);

// A fast variation → mainline burst settles on the LAST click, with a legal PV.
await page.evaluate(async () => {
  document.querySelector('#analysis-moves .mtree-move[data-node-id="v1"]')?.click();
  await new Promise((r) => setTimeout(r, 30));
  document.querySelector('#analysis-moves .mtree-move[data-node-id="m3"]')?.click();
});
{
  const { readout: r, pv } = await waitForLegalPv(NODE_FEN.m3);
  check(r.node === "m3", `a fast branch→mainline burst must settle on the last click, got ${r.node}`);
  check((await boardFen()) === NODE_FEN.m3.split(" ")[0], "a fast burst must leave the last clicked position on the board");
  check(pv.ok, `a fast burst must leave the engine on the last position — ${pv.why}`);
}

// ArrowLeft from a nested variation walks its parent chain back to the mainline.
if (await clickNode("v5")) {
  await page.waitForTimeout(500);
  for (const [expected, label] of [["v4", "3... Nf6"], ["v1", "3. Bc4"], ["m4", "2... Nc6"]]) {
    await page.keyboard.press("ArrowLeft");
    await waitForPv();
    await page.waitForTimeout(500);
    const r = await readout();
    check(r.node === expected, `ArrowLeft must reach ${expected} (${label}), got ${r.node}`);
    check((await boardFen()) === NODE_FEN[expected].split(" ")[0],
      `ArrowLeft to ${expected} must show its position on the board`);
  }
}

// A reload restores the BRANCH, not a mainline move of the same number.
if (await clickNode("v3")) {
  await page.waitForTimeout(600);
  const beforeReload = await readout();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const r = await readout();
  check(r.node === "v3", `a reload must restore the selected branch v3, got ${r.node} (was ${beforeReload.node})`);
  check((await boardFen()) === NODE_FEN.v3.split(" ")[0], "a reload must restore the branch's position");
  check(r.caption.includes("c3"), `a reload must name the branch's move, got "${r.caption}"`);
}

// A branch the USER plays. Creation order (1...d6 first, then 2...a6) differs from
// the depth-first order a reloaded PGN numbers them in, which is what used to make
// the selected branch come back as the other one (or as nothing). The saved
// identity is the root-to-node move path, so the position is the same after reload.
const playMove = async (from, to) => {
  await page.locator(`#analysis-board [data-square="${from}"]`).click();
  await page.locator(`#analysis-board [data-square="${to}"]`).click();
};
const branchFen = fenOf(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"]);
{
  // Start from the fixture mainline's position after 1. e4 (m1) and play 1... d6.
  check(await clickNode("m1"), "the user-branch case needs the mainline move m1 in the list");
  await page.waitForTimeout(400);
  await playMove("d7", "d6");
  await page.waitForTimeout(600);
  const a = await readout();
  const aFen = await boardFen();
  // ...then 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 (m3) and play 2... a6.
  check(await clickNode("m3"), "the user-branch case needs the mainline move m3 in the list");
  await page.waitForTimeout(400);
  await playMove("a7", "a6");
  await page.waitForTimeout(600);
  const bNode = (await readout()).node;
  const bFen = await boardFen();
  check(aFen !== bFen, "the two user branches must be different positions");
  check(!!bNode, "the branch just played must be the selected node");
  // Ordinary browsing: back to the first branch, then to the second.
  const ids = await page.evaluate(() => [...document.querySelectorAll("#analysis-moves .mtree-var .mtree-move")]
    .map((b) => b.dataset.nodeId));
  check(ids.length >= 2, `the move list must show both user branches: ${JSON.stringify(ids)}`);
  await clickNode(ids[0]);
  await page.waitForTimeout(300);
  await clickNode(bNode);
  await page.waitForTimeout(800);
  const hashBefore = (await readout()).hash;
  check(/[?&]node=[a-h][1-8][a-h][1-8]/.test(hashBefore),
    `the URL must name the branch by its move path, got "${hashBefore}"`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const r = await readout();
  check((await boardFen()) === bFen.split(" ")[0],
    "a reload must restore the position of the branch the user played (not the other branch)");
  // The internal node id is a presentation key (creation order live, depth-first
  // after a re-parse), so a reload may number the same branch differently: the
  // POSITION and the caption are what must come back — never the other branch.
  check(!!r.node && r.caption.includes("a6"),
    `a reload must reselect the branch the user played, got ${r.node} "${r.caption}" (was ${bNode})`);
  check(r.caption !== a.caption,
    `a reload must not fall back to the first branch (${a.caption}), got "${r.caption}"`);
  check(r.hash === hashBefore, `the URL must come back unchanged, got "${r.hash}"`);
  // The saved PGN carried the branch: reloading re-parsed it into the move list.
  check((await page.locator("#pgn-input").inputValue()).includes("a6"),
    "the saved PGN must contain the branch the user played");
  void branchFen;
}

// Two games in the box: only the ANALYZED game's branches may appear. Game 2's
// movetext concatenates legally after game 1's, so a whole-textarea parse would
// hang its branch off game 1's last move.
{
  const multi = `${G1_PGN}

${G2_PGN}`;
  await page.locator("#pgn-input").evaluate((el, pgn) => {
    el.value = pgn;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, multi);
  await page.waitForTimeout(700);
  expectMultiGameRefusal = true;
  await page.evaluate(() => document.getElementById("run-analysis").click());
  // The single-game flow refuses the paste and offers the batch: take it.
  await page.waitForSelector('.modal-overlay [data-action="ok"]', { timeout: 15000 });
  await page.locator('.modal-overlay [data-action="ok"]').click();
  await page.waitForTimeout(500);
  expectMultiGameRefusal = false;
  await page.waitForFunction(
    () => !document.getElementById("analysis-results").hidden && document.querySelectorAll("#analysis-summary .cbar-row").length > 0,
    null, { timeout: 60000 },
  );
  await page.waitForTimeout(1200);
  const sans = await page.evaluate(() =>
    [...document.querySelectorAll("#analysis-moves .mtree-move")].map((b) => b.querySelector(".mtree-san")?.textContent?.trim()));
  check(!sans.includes("Nf3") || sans.filter((s) => s === "Nf3").length === 1,
    `the analyzed game's list must not gain the other game's moves: ${JSON.stringify(sans)}`);
  check(!sans.includes("d4") && !sans.includes("c4") && !sans.includes("e6"),
    `the other game's moves and branch must not appear: ${JSON.stringify(sans)}`);
  check(sans.join(" ") === MAINLINE_SANS.join(" ") || sans.length >= MAINLINE_SANS.length,
    `the analyzed game keeps its own mainline: ${JSON.stringify(sans)}`);
  check(sans.includes("Bc4"), `the analyzed game keeps its own branch: ${JSON.stringify(sans)}`);
  // The box, the move tree and the checkpoint name ONE game after the run: the
  // paste's other game is not left in the textarea under this game's movetext (that
  // merged box made the picker's switch a 400 and a single re-run mislabel G1's
  // moves with G2's tags).
  const boxAfterRun = await page.locator("#pgn-input").inputValue();
  check((boxAfterRun.match(/\[Event /g) || []).length === 1,
    `the box must hold one game's header block after the run: ${JSON.stringify(boxAfterRun.slice(0, 200))}`);
  check(!boxAfterRun.includes('Event "G2"'),
    `the box must not keep the other pasted game's tags: ${JSON.stringify(boxAfterRun.slice(0, 200))}`);
  check(boxAfterRun.includes("Bb5") && !/d4|c4|e6/.test(boxAfterRun),
    `the box must carry the analyzed game's own moves: ${JSON.stringify(boxAfterRun.slice(0, 240))}`);
  // Each game on its own: select game 2 through the import picker and check that
  // ONLY its mainline and its own branch are listed. The picker POSTs the batch it
  // was built from (the server indexes into that), so prepare must accept it.
  const picker = page.locator("#analysis-import-select");
  check(await picker.count() > 0, "the import picker must list both pasted games");
  if (await picker.count()) {
    await picker.selectOption("1");
    // The switch is a full run: wait for the box to name game 2 (the run rewrites
    // it from `prepare.pgn`) and for the button to come back. A failure here is
    // reported by the checks below, not as a timeout.
    await page.waitForFunction(
      () => document.getElementById("pgn-input").value.includes('Event "G2"') &&
        !document.getElementById("run-analysis").disabled,
      null, { timeout: 60000 },
    ).catch(() => {});
    await page.waitForTimeout(1200);
    const switchPost = preparePosts.at(-1);
    check(switchPost.status === 200 && switchPost.selectIndex === 1 && switchPost.games === 2,
      `the picker's switch must POST a paste the server can index: ${JSON.stringify({ ...switchPost, pgn: switchPost.pgn.slice(0, 60) })}`);
    const g2 = await page.evaluate(() =>
      [...document.querySelectorAll("#analysis-moves .mtree-move")].map((b) => b.querySelector(".mtree-san")?.textContent?.trim()));
    // Its own mainline in order, plus its own branch — nothing from game 1.
    check(g2.filter((san) => ["d4", "d5", "c4", "e6"].includes(san)).join(" ") === "d4 d5 c4 e6",
      `game 2's list must carry its own mainline in order: ${JSON.stringify(g2)}`);
    check(g2.includes("Nf3") && g2.includes("Nf6"),
      `game 2 keeps its own branch: ${JSON.stringify(g2)}`);
    check(!g2.includes("Bb5") && !g2.includes("Ba4"),
      `game 2 must not show game 1's moves: ${JSON.stringify(g2)}`);
    // ...and the box names game 2, not game 1.
    const boxAfterSwitch = await page.locator("#pgn-input").inputValue();
    check(boxAfterSwitch.includes('Event "G2"') && !boxAfterSwitch.includes('Event "G1"'),
      `the box must name game 2 after the switch: ${JSON.stringify(boxAfterSwitch.slice(0, 200))}`);
    check(!boxAfterSwitch.includes("Bb5") && boxAfterSwitch.includes("c4"),
      `game 2's tags must carry game 2's moves: ${JSON.stringify(boxAfterSwitch.slice(0, 200))}`);
    // A single-mode re-run of the box is that one game: the server accepts it and
    // its tags stay with its own moves.
    const postsBeforeRerun = preparePosts.length;
    await page.evaluate(() => document.getElementById("run-analysis").click());
    await page.waitForFunction(
      () => !document.getElementById("analysis-results").hidden && !document.getElementById("run-analysis").disabled,
      null, { timeout: 60000 },
    ).catch(() => {});
    await page.waitForTimeout(1200);
    check(preparePosts.length === postsBeforeRerun + 1,
      `a re-run must reach prepare exactly once (${postsBeforeRerun} -> ${preparePosts.length})`);
    const rerun = preparePosts.at(-1);
    check(rerun.status === 200 && rerun.mode === "single" && rerun.games === 1,
      `a re-run of the box must POST one game: ${JSON.stringify({ ...rerun, pgn: rerun.pgn.slice(0, 60) })}`);
    const rerunSans = await page.evaluate(() =>
      [...document.querySelectorAll("#analysis-moves .mtree-move")].map((b) => b.querySelector(".mtree-san")?.textContent?.trim()));
    check(!rerunSans.includes("Bb5") && rerunSans.includes("c4") && rerunSans.includes("e6"),
      `a single re-run keeps game 2's moves: ${JSON.stringify(rerunSans)}`);
    const rerunBox = await page.locator("#pgn-input").inputValue();
    check(rerunBox.includes('Event "G2"') && !rerunBox.includes('Event "G1"'),
      `a single re-run keeps game 2's tags: ${JSON.stringify(rerunBox.slice(0, 200))}`);
  }
}

check(consoleErrors.length === 0, `no console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`);

await browser.close();
server.close();
if (failures.length) {
  console.error("[analyze-variations-smoke] FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("[analyze-variations-smoke] ok — the selected variation node drives the board, the caption, the Coach and the engine (PV legal in that position), through a fast reversal and a reload.");
