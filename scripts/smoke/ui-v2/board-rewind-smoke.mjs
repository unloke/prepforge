// Board rewind smoke — the board's motion, on every board that has one.
//
// The board is shown by four callers (Repertoire, Train, Analyze mainline,
// Analyze variations) and only Analyze's mainline ever told it which way the user
// was travelling. A step back replayed the move being undone, forward, from a
// square the piece had already left, while the piece that had to travel home was
// re-rendered in place. The board now derives its transition from the two
// positions (web-src/board/move-motion.js), so this smoke drives the real built
// app and asserts, for each board:
//   - the piece that should travel really animates, starting at the square it
//     came from (sampled per frame, not just a final screenshot);
//   - a piece that did not move is not animated;
//   - the settled DOM equals the FEN on every square, with no capture clone left;
//   - a jump between lines is a cut (no wrong-origin slide), and reduced motion
//     keeps the position without the travel.
//
// Fixture-backed on the production build (no E2E hooks): every FEN and opponent
// move is computed here with chess.js, so nothing depends on live Lichess.
// Usage: node scripts/smoke/ui-v2/board-rewind-smoke.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { Chess } from "chess.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.BOARD_REWIND_SMOKE_PORT || 8810);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// --- the repertoires this smoke opens (all real chess) ------------------------
// Each line is played here with chess.js, so a node's FEN is the position after
// its move — the same shape /api/build/load returns.
function lineNodes(id, name, moves, { rootFen = START_FEN, color = "white" } = {}) {
  const chess = new Chess(rootFen);
  const root = {
    id: `${id}0`, parent_id: null, depth: 0, san: null, uci: null, fen: chess.fen(),
    fen_before: chess.fen(), fen_after: chess.fen(), move_number: Number(chess.fen().split(" ")[5]) || 1,
    ply: 0, move_side: color, side_to_move: chess.turn() === "w" ? "white" : "black",
    source: "manual", is_mainline: true, is_enabled: true, is_prepared: false,
    mastery: null, maia_probability: null, arrows: [], circles: [],
  };
  const nodes = [root];
  let parent = root;
  moves.forEach((san, index) => {
    const fenBefore = chess.fen();
    const move = chess.move(san);
    const node = {
      id: `${id}${index + 1}`, parent_id: parent.id, depth: index + 1, san: move.san,
      uci: `${move.from}${move.to}${move.promotion || ""}`, fen: chess.fen(),
      fen_before: fenBefore, fen_after: chess.fen(),
      move_number: Number(fenBefore.split(" ")[5]) || 1,
      ply: index + 1, move_side: move.color === "w" ? "white" : "black",
      side_to_move: chess.turn() === "w" ? "white" : "black",
      source: "manual", is_mainline: true, is_enabled: true, is_prepared: false,
      mastery: null, maia_probability: null, arrows: [], circles: [],
    };
    nodes.push(node);
    parent = node;
  });
  return { repertoire_id: id, name, color, writable: true, selected_node_id: root.id, root_fen: rootFen, nodes };
}

// 1.e4 a6 2.e5 d5 3.exd6 — an en passant capture (the victim stands beside the
// square the pawn lands on), then a plain capture of the pawn on d6.
const EN_PASSANT = lineNodes("enp", "En passant", ["e4", "a6", "e5", "d5", "exd6", "Qxd6", "Nf3"]);
// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O — castling, king and rook.
const CASTLE = lineNodes("cas", "Castling", ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6"]);
// A pawn one step from promoting.
const PROMOTION = lineNodes("pro", "Promotion", ["a8=Q", "Kg7"], {
  rootFen: "8/P6k/8/8/8/8/6K1/8 w - - 0 1",
});
// 1.e4 e5 2.Nf3 Nc6 with four alternative third moves from the same parent:
// 3.d4 / 3.d3 (the same pawn) and 3.Bb5 / 3.Bc4 (the same bishop). A pair of
// siblings shares side to move and fullmove: a jump between them is not a move,
// even though the two placements differ by one like piece.
function siblingsOf(id, name) {
  const rep = lineNodes(id, name, ["e4", "e5", "Nf3", "Nc6"]);
  const parent = rep.nodes.at(-1);
  ["d4", "d3", "Bb5", "Bc4"].forEach((san, index) => {
    const chess = new Chess(parent.fen);
    const fenBefore = chess.fen();
    const move = chess.move(san);
    rep.nodes.push({
      id: `${id}b${index + 1}`, parent_id: parent.id, depth: parent.depth + 1, san: move.san,
      uci: `${move.from}${move.to}${move.promotion || ""}`, fen: chess.fen(),
      fen_before: fenBefore, fen_after: chess.fen(),
      move_number: Number(fenBefore.split(" ")[5]) || 1, ply: parent.ply + 1,
      move_side: move.color === "w" ? "white" : "black",
      side_to_move: chess.turn() === "w" ? "white" : "black",
      source: "manual", is_mainline: index === 0, is_enabled: true, is_prepared: false,
      mastery: null, maia_probability: null, arrows: [], circles: [],
    });
  });
  return rep;
}
const SIBLINGS = siblingsOf("sib", "Sibling alternatives");
const REPERTOIRES = [EN_PASSANT, CASTLE, PROMOTION, SIBLINGS];
const byId = new Map(REPERTOIRES.map((rep) => [rep.repertoire_id, rep]));

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/build/load")) {
    const id = new URL(path, "http://x").searchParams.get("repertoire_id");
    const rep = byId.get(id);
    if (rep) return rep;
    return { repertoire_id: id, name: "?", color: "white", writable: true, selected_node_id: null, root_fen: START_FEN, nodes: [] };
  }
  if (path.startsWith("/api/repertoires")) {
    return {
      repertoires: REPERTOIRES.map((rep, index) => ({
        id: rep.repertoire_id, name: rep.name, color: rep.color, root_fen: rep.root_fen,
        notes: "", tags: [], is_active: index === 0, team_id: null, visibility: "private",
        health: { trainable: 3, mastered: 1, weak: 1, due: 1, learning: 0, untrained: 0, mastery_pct: 33, shallow_lines: 0 },
      })),
      shared: [],
    };
  }
  // The practice opponent: one legal reply, computed from the position it asks
  // about. Deterministic and always legal, so no live Lichess is involved.
  if (path.startsWith("/api/lichess/explorer")) {
    const fen = new URL(path, "http://x").searchParams.get("fen");
    let moves = [];
    try {
      const chess = new Chess(fen);
      moves = chess.moves({ verbose: true });
    } catch { /* an unreadable position has no rows */ }
    const pick = moves.find((m) => m.piece !== "k") || moves[0];
    return {
      white: 12000, draws: 9000, black: 11000,
      opening: { eco: "B00", name: "Board rewind fixture" },
      moves: pick ? [{ uci: `${pick.from}${pick.to}${pick.promotion || ""}`, san: pick.san, white: 12000, draws: 9000, black: 11000 }] : [],
    };
  }
  if (path.startsWith("/api/train/smart/summary")) return { next_session: { cards: 0, weak: 0, due: 0, new: 0, polish: 0, resumed: 0 } };
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: REPERTOIRES.length, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/teams")) return { teams: [] };
  if (path.startsWith("/api/lichess")) return { linked: true, accounts: [{ id: "a1", username: "me_user", is_primary: true }] };
  if (path.startsWith("/api/settings")) return {};
  if (path.startsWith("/api/analyses")) return { analyses: [] };
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(api(url.pathname + url.search)));
    return;
  }
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  try {
    const file = await readFile(join(STATIC_DIR, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[board-rewind] no chromium-based browser available"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];
let checks = 0;
const check = (ok, label) => {
  checks += 1;
  if (!ok) failures.push(label);
};

// --- per-frame sampling ------------------------------------------------------
// Every frame of the transition: each square's own piece transform, its opacity,
// how many .piece elements it holds and how many are capture clones. That is what
// tells "the right piece travelled from the right square" apart from "something
// ended up in the right place".
async function startProbe(page, boardSelector) {
  await page.evaluate((selector) => {
    const board = document.querySelector(selector);
    const probe = { frames: [], active: true, start: performance.now() };
    window.__boardProbe = probe;
    const frame = () => {
      if (!probe.active) return;
      const snapshot = {};
      board.querySelectorAll(".square").forEach((square) => {
        const own = square.querySelector(".piece:not(.piece-caught)");
        const clone = square.querySelector(".piece-caught");
        snapshot[square.dataset.square] = {
          n: square.querySelectorAll(".piece").length,
          clone: clone ? 1 : 0,
          transform: own ? getComputedStyle(own).transform : null,
          opacity: own ? Number(getComputedStyle(own).opacity) : null,
          cloneOpacity: clone ? Number(getComputedStyle(clone).opacity) : null,
        };
      });
      probe.frames.push({ at: performance.now() - probe.start, snapshot });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, boardSelector);
}

async function stopProbe(page, { settle = 320 } = {}) {
  await page.waitForTimeout(settle);
  return page.evaluate(() => {
    const probe = window.__boardProbe;
    probe.active = false;
    return { frames: probe.frames, square: (() => {
      const el = document.querySelector(window.__boardProbe.board || ".chessboard .square");
      return el ? el.getBoundingClientRect().width : 0;
    })() };
  });
}

// "none" | { dx, dy } in px. A matrix with no translation is a settled piece.
function translation(transform) {
  if (!transform || transform === "none") return { dx: 0, dy: 0 };
  const matrix = /matrix\(([^)]+)\)/.exec(transform);
  if (!matrix) return { dx: 0, dy: 0 };
  const parts = matrix[1].split(",").map(Number);
  return { dx: parts[4] || 0, dy: parts[5] || 0 };
}
const moved = (entry) => {
  const { dx, dy } = translation(entry?.transform);
  return Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
};
// Frames in which `square` is visibly away from its settled place.
const travelFrames = (frames, square) => frames.filter((frame) => moved(frame.snapshot[square]));
// The offset a mover starts from, signed, from the frame it first moves in.
function originOffset(frames, square) {
  const first = travelFrames(frames, square)[0];
  return first ? translation(first.snapshot[square].transform) : null;
}

// --- settled DOM == FEN ------------------------------------------------------
async function settledDom(page, boardSelector) {
  return page.evaluate((selector) => {
    const out = {};
    document.querySelectorAll(`${selector} .square`).forEach((square) => {
      const own = square.querySelectorAll(".piece:not(.piece-caught)");
      out[square.dataset.square] = {
        piece: square.dataset.piece,
        own: own.length,
        all: square.querySelectorAll(".piece").length,
        clone: square.querySelectorAll(".piece-caught").length,
      };
    });
    return out;
  }, boardSelector);
}

function checkSettled(dom, fen, label) {
  const placement = fen.split(" ")[0];
  const want = {};
  placement.split("/").forEach((row, rankIndex) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        want[`${"abcdefgh"[file]}${8 - rankIndex}`] = ch;
        file += 1;
      }
    }
  });
  const wrong = [];
  for (const [square, state] of Object.entries(dom)) {
    const letter = want[square] || "";
    if (state.piece !== letter) wrong.push(`${square} data-piece "${state.piece}" want "${letter}"`);
    if (state.own !== (letter ? 1 : 0)) wrong.push(`${square} own pieces ${state.own} want ${letter ? 1 : 0}`);
    if (state.clone) wrong.push(`${square} left a capture clone`);
  }
  check(wrong.length === 0, `${label}: settled DOM must equal the FEN — ${wrong.slice(0, 4).join("; ")}`);
}

// The travel a step owes: `movers` are [from, to] pairs that must animate, each
// starting at (from - to) in pixels; `still` are squares that must not animate.
function checkTravel(frames, { movers, still = [] }, squareSize, label) {
  for (const [from, to] of movers) {
    const travel = travelFrames(frames, to);
    check(travel.length >= 2, `${label}: ${to} must animate (${travel.length} moving frames)`);
    const offset = originOffset(frames, to);
    if (!offset) continue;
    const [fromFile, fromRank] = ["abcdefgh".indexOf(from[0]), Number(from[1])];
    const [toFile, toRank] = ["abcdefgh".indexOf(to[0]), Number(to[1])];
    // Signed, in screen terms; a flipped board reverses both axes, so compare
    // magnitudes and require the offset to be at least a quarter of the way home
    // (the first sampled frame is a few ms into a 140 ms ease-out).
    const wantDx = (fromFile - toFile) * squareSize;
    const wantDy = (toRank - fromRank) * squareSize;
    check(Math.sign(offset.dx) === Math.sign(wantDx) || wantDx === 0,
      `${label}: ${to} must travel from ${from} (dx ${offset.dx.toFixed(1)}, want sign of ${wantDx})`);
    check(Math.sign(offset.dy) === Math.sign(wantDy) || wantDy === 0,
      `${label}: ${to} must travel from ${from} (dy ${offset.dy.toFixed(1)}, want sign of ${wantDy})`);
    const nearOrigin = Math.abs(offset.dx) >= Math.abs(wantDx) * 0.25 && Math.abs(offset.dy) >= Math.abs(wantDy) * 0.25;
    check(nearOrigin, `${label}: ${to} must start near ${from} (got ${offset.dx.toFixed(1)},${offset.dy.toFixed(1)}; full ${wantDx},${wantDy})`);
  }
  for (const square of still) {
    check(travelFrames(frames, square).length === 0, `${label}: ${square} must not animate`);
  }
}

// --- page helpers -----------------------------------------------------------
async function openBuild(page, repertoireId) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const row = page.locator(`#dashboard-repertoires .lib-row[data-repertoire-id="${repertoireId}"]`);
  await row.waitFor({ state: "visible", timeout: 20000 });
  // One click opens the workspace (the row's own click handler).
  await row.click();
  await page.locator("#build-rep-name").filter({ hasText: byId.get(repertoireId).name })
    .waitFor({ state: "attached", timeout: 20000 });
  // The board is painted once the load lands.
  await page.waitForFunction(() => document.querySelectorAll("#build-board .square .piece").length > 0);
}

const nodeFen = (rep, index) => rep.nodes[index].fen;
const nodeUci = (rep, index) => rep.nodes[index].uci;

async function clickNode(page, id) {
  await page.locator(`#builder-tree .mtree-move[data-node-id="${id}"]`).click();
}
async function clickCrumb(page, id) {
  await page.locator(`#build-tree-meta .mtree-crumb[data-node-id="${id}"]`).click();
}
// The rail on a wide screen, the thumb bar on a phone: one name either way.
async function openView(page, name) {
  const rail = page.locator(`[data-testid="nav-${name}"]`);
  if (await rail.count() && await rail.first().isVisible()) { await rail.first().click(); return; }
  const bottom = page.locator(`[data-testid="bottom-${name}"]`);
  if (await bottom.count() && await bottom.first().isVisible()) { await bottom.first().click(); return; }
  await rail.first().click();
}

const squareSizeOf = (page, selector) =>
  page.evaluate((sel) => document.querySelector(`${sel} .square`).getBoundingClientRect().width, selector);

// --- desktop scenarios ------------------------------------------------------
async function buildOrdinaryUndo(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  // Forward: e2 -> e4 (a move being shown), then back to the root.
  await clickNode(page, rep.nodes[1].id);
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[0].id);
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["e4", "e2"]], still: ["a7", "e7"] }, size, "build undo e4");
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 0), "build undo e4");
}

async function buildEnPassant(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  // Forward through the line to 3.exd6 (en passant) ...
  for (let i = 1; i <= 5; i += 1) {
    await clickNode(page, rep.nodes[i].id);
    await page.waitForTimeout(180);
  }
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 5), "build en passant forward");
  // ... then back to 2...d5: the pawn returns e5 and the taken pawn reappears d5.
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[4].id);
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["d6", "e5"]], still: ["d5"] }, size, "build en passant back");
  await page.locator("#build-board").screenshot({ path: "tmp/round2/evidence/build-en-passant-back.png" });
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 4), "build en passant back");
  // The victim comes back as the pawn leaves, not as a ghost left behind.
  const fadedIn = frames.some((frame) => frame.snapshot.d5?.opacity !== undefined && frame.snapshot.d5.opacity < 1);
  check(fadedIn, "build en passant back: the returned pawn must fade in, not pop");
  // And forward again: the capture clone is held, then gone with the position.
  await startProbe(page, "#build-board");
  await clickNode(page, rep.nodes[5].id);
  const forward = await stopProbe(page);
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 5), "build en passant forward again");
  check(forward.frames.some((frame) => frame.snapshot.d5?.clone === 1),
    "build en passant forward: the victim is held on its square while the mover travels");
}

async function buildReverseCapture(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  // 5...Qxd6 takes the pawn on d6; stepping back gives it back.
  for (let i = 1; i <= 6; i += 1) {
    await clickNode(page, rep.nodes[i].id);
    await page.waitForTimeout(160);
  }
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 6), "build capture forward");
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[5].id);
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["d6", "d8"]], still: ["d6"] }, size, "build reverse capture");
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 5), "build reverse capture");
  const restored = frames.some((frame) => frame.snapshot.d6?.opacity !== undefined && frame.snapshot.d6.opacity < 1);
  check(restored, "build reverse capture: the taken pawn fades back in on d6");
}

async function buildCastle(page) {
  const rep = CASTLE;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  for (let i = 1; i <= 7; i += 1) {
    await clickNode(page, rep.nodes[i].id);
    await page.waitForTimeout(160);
  }
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 7), "build castle forward");
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[6].id);
  const { frames } = await stopProbe(page);
  // Both pieces travel home: no teleporting rook.
  checkTravel(frames, { movers: [["g1", "e1"], ["f1", "h1"]] }, size, "build castle undo");
  await page.locator("#build-board").screenshot({ path: "tmp/round2/evidence/build-castle-undo.png" });
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 6), "build castle undo");
}

async function buildPromotion(page) {
  const rep = PROMOTION;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  await clickNode(page, rep.nodes[1].id);
  await page.waitForTimeout(200);
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 1), "build promotion forward");
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[0].id);
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["a8", "a7"]] }, size, "build promotion undo");
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 0), "build promotion undo");
}

async function buildRapidWalk(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  // A held ← / → : alternate forward and back faster than a 140 ms slide, ending
  // on a position with a capture clone still fading.
  for (let i = 0; i < 5; i += 1) {
    await clickNode(page, rep.nodes[5].id);
    await page.waitForTimeout(45);
    await clickCrumb(page, rep.nodes[4].id);
    await page.waitForTimeout(45);
  }
  await clickNode(page, rep.nodes[5].id);
  await page.waitForTimeout(400);
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 5), "build rapid walk settles");
  // Settled means settled: no piece is still animating after the budget.
  const moving = await page.evaluate(() => {
    const running = [...document.querySelectorAll("#build-board .piece")].flatMap((p) => p.getAnimations?.() || []);
    return running.filter((a) => a.playState === "running").length;
  });
  check(moving === 0, `build rapid walk: no animation still running after settle (${moving})`);
}

async function buildJumpCut(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  await clickNode(page, rep.nodes[1].id);
  await page.waitForTimeout(200);
  // A jump from move 1 to move 7 is not one move: no slide may be invented for it.
  await startProbe(page, "#build-board");
  await clickNode(page, rep.nodes[7].id);
  const { frames } = await stopProbe(page);
  const travellers = Object.keys(frames[0].snapshot).filter((square) => travelFrames(frames, square).length > 0);
  check(travellers.length === 0, `build jump: a jump must be a cut, got motion on ${travellers.join(",")}`);
  check(size > 0, "build jump: board measured");
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 7), "build jump");
}

async function buildSiblingCut(page) {
  const rep = SIBLINGS;
  const parent = rep.nodes[4]; // 1.e4 e5 2.Nf3 Nc6
  const bySan = (san) => rep.nodes.find((node) => node.san === san && node.depth === parent.depth + 1);
  const d4 = bySan("d4"), d3 = bySan("d3"), bb5 = bySan("Bb5"), bc4 = bySan("Bc4");
  await openBuild(page, rep.repertoire_id);
  const size = await squareSizeOf(page, "#build-board");
  const settle = () => page.waitForTimeout(220);
  // A jump that must be a cut: the board changes position, nothing slides.
  const jump = async (node, label) => {
    await startProbe(page, "#build-board");
    await clickNode(page, node.id);
    const { frames } = await stopProbe(page);
    const travellers = Object.keys(frames[0].snapshot)
      .filter((square) => travelFrames(frames, square).length > 0);
    check(travellers.length === 0, `${label}: a same-ply sibling jump must be a cut (${travellers.join(",")})`);
    checkSettled(await settledDom(page, "#build-board"), node.fen, label);
  };
  for (let i = 1; i <= 4; i += 1) {
    await clickNode(page, rep.nodes[i].id);
    await settle();
  }
  await clickNode(page, d4.id);
  await settle();
  checkSettled(await settledDom(page, "#build-board"), d4.fen, "build sibling d4");

  // d4 -> d3 directly: both are the parent's d2 pawn. There is no move between
  // the two positions, so nothing may slide (least of all d3 down from d4).
  await jump(d3, "build sibling d4->d3");
  await jump(d4, "build sibling d3->d4");

  // An ordinary undo first: d4 goes home to d2 ...
  await startProbe(page, "#build-board");
  await clickCrumb(page, parent.id);
  const undo = await stopProbe(page);
  checkTravel(undo.frames, { movers: [["d4", "d2"]] }, size, "build sibling undo");
  checkSettled(await settledDom(page, "#build-board"), parent.fen, "build sibling undo");
  // ... and only then the sibling child: from the parent this is a real move,
  // so d3 must start at d2, never at d4.
  await startProbe(page, "#build-board");
  await clickNode(page, d3.id);
  const forward = await stopProbe(page);
  checkTravel(forward.frames, { movers: [["d2", "d3"]] }, size, "build sibling child after undo");
  checkSettled(await settledDom(page, "#build-board"), d3.fen, "build sibling child after undo");

  // The same shape with bishops: 3.Bb5 and 3.Bc4 both leave f1.
  await jump(bb5, "build sibling d3->Bb5");
  await jump(bc4, "build sibling Bb5->Bc4");
  await jump(bb5, "build sibling Bc4->Bb5");

  // Undo the bishop, then play the other sibling child: f1 -> c4 is the move.
  await startProbe(page, "#build-board");
  await clickCrumb(page, parent.id);
  const bishopUndo = await stopProbe(page);
  checkTravel(bishopUndo.frames, { movers: [["b5", "f1"]] }, size, "build sibling bishop undo");
  checkSettled(await settledDom(page, "#build-board"), parent.fen, "build sibling bishop undo");
  await startProbe(page, "#build-board");
  await clickNode(page, bc4.id);
  const bishopForward = await stopProbe(page);
  checkTravel(bishopForward.frames, { movers: [["f1", "c4"]] }, size, "build sibling bishop child after undo");
  checkSettled(await settledDom(page, "#build-board"), bc4.fen, "build sibling bishop child after undo");
}

async function buildFlipThenBack(page) {
  const rep = EN_PASSANT;
  await openBuild(page, rep.repertoire_id);
  await clickNode(page, rep.nodes[2].id);
  await page.waitForTimeout(200);
  await page.locator("#build-flip").click();
  await page.waitForTimeout(500); // the flip animation's own budget
  const size = await squareSizeOf(page, "#build-board");
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[1].id);
  const { frames } = await stopProbe(page);
  // a6's pawn goes home to a7 on a flipped board: the offset's magnitude is a
  // square, whichever way the board is drawn.
  const travel = travelFrames(frames, "a7");
  check(travel.length >= 2, `build flip: a7 must animate after a flip (${travel.length} frames)`);
  const offset = originOffset(frames, "a7");
  check(Boolean(offset) && Math.abs(Math.abs(offset.dy) - size) < size * 0.75,
    `build flip: a7 travel must be one square (${offset && offset.dy.toFixed(1)} vs ${size})`);
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 1), "build flip undo");
}

async function buildReducedMotion(page) {
  const rep = EN_PASSANT;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openBuild(page, rep.repertoire_id);
  await clickNode(page, rep.nodes[5].id);
  await page.waitForTimeout(250);
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[4].id);
  const { frames } = await stopProbe(page);
  const travellers = Object.keys(frames[0].snapshot).filter((square) => travelFrames(frames, square).length > 0);
  check(travellers.length === 0, `build reduced motion: no travel (${travellers.join(",")})`);
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 4), "build reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

async function analyzeMainlineAndVariation(page) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#dashboard-repertoires .lib-row").first().waitFor({ state: "visible", timeout: 20000 });
  await openView(page, "analyze");
  await page.evaluate(() => {
    const input = document.getElementById("pgn-input");
    input.value = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The board follows the PGN through its debounced parse.
  await page.waitForFunction(() => document.querySelectorAll("#analysis-board .square .piece").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const size = await squareSizeOf(page, "#analysis-board");
  // Step back one ply with the keyboard: the knight that just moved goes home.
  await startProbe(page, "#analysis-board");
  await page.keyboard.press("ArrowLeft");
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["c4", "f1"]] }, size, "analyze mainline back");
  const fenAfterBack = await page.evaluate(() => document.getElementById("analysis-board").dataset.fen || "");
  void fenAfterBack;
  // Settled DOM equals whatever position the app now shows (read from the board's
  // own last-move state): compare against the tree's current move instead.
  const current = await page.evaluate(() => document.querySelector("#analysis-moves .mtree-move.is-current")?.getAttribute("data-node-id") || "");
  check(Boolean(current), `analyze mainline back: a current move is marked (${current})`);
  const dom = await settledDom(page, "#analysis-board");
  const pieces = Object.values(dom).filter((s) => s.own === 1).length;
  check(pieces === 32, `analyze mainline back: every piece is on the board (${pieces})`);

  // A branch: play a different black move on the board from after 1.e4, then jump
  // to the mainline move — the board must cut, not slide a piece that never moved.
  await page.keyboard.press("Home");
  await page.waitForTimeout(250);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  const clickSquare = async (name) => page.locator(`#analysis-board .square[data-square="${name}"]`).click();
  await clickSquare("c7");
  await clickSquare("c5");
  await page.waitForTimeout(400);
  const branchPieces = await settledDom(page, "#analysis-board");
  check(Object.values(branchPieces).every((s) => s.clone === 0), "analyze variation: no capture clone left on the board");
  const branchCurrent = await page.evaluate(() => document.querySelector("#analysis-moves .mtree-move.is-current")?.getAttribute("data-node-id") || "");
  check(branchCurrent.startsWith("v"), `analyze variation: the branch move is the current node (${branchCurrent})`);
  // Jump back to the mainline's 1...e5 (a different position: two pawns moved).
  await startProbe(page, "#analysis-board");
  await page.locator('#analysis-moves .mtree-move[data-node-id="m2"]').click();
  const jump = await stopProbe(page);
  const travellers = Object.keys(jump.frames[0].snapshot).filter((square) => travelFrames(jump.frames, square).length > 0);
  check(travellers.length === 0, `analyze variation jump: a branch jump must be a cut (${travellers.join(",")})`);
  const afterJump = await settledDom(page, "#analysis-board");
  check(Object.values(afterJump).filter((s) => s.own === 1).length === 32, "analyze variation jump: 32 pieces on the mainline position");
  check(Object.values(afterJump).every((s) => s.clone === 0), "analyze variation jump: no ghost left behind");
}

async function trainTakeback(page) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#dashboard-repertoires .lib-row").first().waitFor({ state: "visible", timeout: 20000 });
  await openView(page, "train");
  await page.locator('[data-mode="play"]').click();
  await page.locator("#train-play-book").selectOption("explorer");
  await page.locator("#start-play").click();
  // The session is up once the board carries a position and the takeback is
  // still disabled (there is nothing to take back yet).
  await page.waitForFunction(() => {
    const fen = document.getElementById("train-board")?.dataset.fen || "";
    return fen && document.getElementById("start-play")?.disabled === false;
  }, null, { timeout: 20000 });
  // Play e4; the fixture opponent answers with its one legal reply.
  await page.locator('#train-board .square[data-square="e2"]').click();
  await page.locator('#train-board .square[data-square="e4"]').click();
  await page.waitForFunction(() => document.getElementById("play-takeback")?.disabled === false, null, { timeout: 20000 });
  await page.waitForTimeout(900); // the opponent's own animated step
  const size = await squareSizeOf(page, "#train-board");
  const beforeTakeback = await page.evaluate(() => document.getElementById("train-board").dataset.fen || "");
  await startProbe(page, "#train-board");
  await page.locator("#play-takeback").click();
  const { frames } = await stopProbe(page, { settle: 400 });
  // Both plies come back: the user's pawn home to e2 and the reply home to its
  // own origin. Read those two origins off the FENs, so the check is about the
  // positions rather than a hard-coded reply.
  const replyFen = beforeTakeback;
  const startFen = START_FEN;
  const pawnMoved = travelFrames(frames, "e2").length >= 2;
  check(pawnMoved, `train takeback: the user's pawn must travel home to e2 (${travelFrames(frames, "e2").length} frames)`);
  const offset = originOffset(frames, "e2");
  check(Boolean(offset) && Math.abs(offset.dy) >= size * 0.25, `train takeback: e2 starts a pawn-move away (${offset && offset.dy.toFixed(1)})`);
  checkSettled(await settledDom(page, "#train-board"), startFen, "train takeback");
  void replyFen;
}

// --- phone scenarios --------------------------------------------------------
async function phoneBuildUndo(page) {
  const rep = EN_PASSANT;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const row = page.locator(`#dashboard-repertoires .lib-row[data-repertoire-id="${rep.repertoire_id}"]`);
  await row.waitFor({ state: "visible", timeout: 20000 });
  // A phone opens the row with the same single tap.
  await row.click();
  await page.locator("#build-rep-name").filter({ hasText: rep.name })
    .waitFor({ state: "attached", timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#build-board .square .piece").length > 0);
  const size = await squareSizeOf(page, "#build-board");
  await clickNode(page, rep.nodes[2].id);
  await page.waitForTimeout(250);
  await startProbe(page, "#build-board");
  await clickCrumb(page, rep.nodes[1].id);
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["a6", "a7"]] }, size, "phone build undo");
  checkSettled(await settledDom(page, "#build-board"), nodeFen(rep, 1), "phone build undo");
  // The board must be inside the viewport, not merely drawn: a clipped board
  // would make the motion unobservable even if the DOM were right.
  const visible = await page.evaluate(() => {
    const board = document.getElementById("build-board").getBoundingClientRect();
    return board.top >= 0 && board.left >= 0 && board.bottom <= innerHeight + 1 && board.right <= innerWidth + 1;
  });
  check(visible, "phone build: the board is fully inside the viewport");
  await page.locator("#build-board").screenshot({ path: "tmp/round2/evidence/phone-build-undo.png" });
}

async function phoneAnalyzeBack(page) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#dashboard-repertoires .lib-row").first().waitFor({ state: "visible", timeout: 20000 });
  await openView(page, "analyze");
  await page.evaluate(() => {
    const input = document.getElementById("pgn-input");
    input.value = "1. e4 e5 2. Nf3 *";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll("#analysis-board .square .piece").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const size = await squareSizeOf(page, "#analysis-board");
  await startProbe(page, "#analysis-board");
  await page.keyboard.press("ArrowLeft");
  const { frames } = await stopProbe(page);
  checkTravel(frames, { movers: [["f3", "g1"]] }, size, "phone analyze back");
  const dom = await settledDom(page, "#analysis-board");
  check(Object.values(dom).filter((s) => s.own === 1).length === 32, "phone analyze back: 32 pieces after the knight goes home");
  check(Object.values(dom).every((s) => s.clone === 0), "phone analyze back: no ghost");
}

// --- run --------------------------------------------------------------------
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, scenarios: [
    ["build undo", buildOrdinaryUndo],
    ["build en passant", buildEnPassant],
    ["build reverse capture", buildReverseCapture],
    ["build castle", buildCastle],
    ["build promotion", buildPromotion],
    ["build rapid walk", buildRapidWalk],
    ["build jump", buildJumpCut],
    ["build sibling cut", buildSiblingCut],
    ["build flip", buildFlipThenBack],
    ["build reduced motion", buildReducedMotion],
    ["analyze", analyzeMainlineAndVariation],
    ["train takeback", trainTakeback],
  ] },
  { name: "phone", width: 390, height: 844, scenarios: [
    ["phone build undo", phoneBuildUndo],
    ["phone analyze back", phoneAnalyzeBack],
    ["phone train takeback", trainTakeback],
  ] },
];

for (const vp of VIEWPORTS) {
  console.log(`[board-rewind] ${vp.name} ${vp.width}x${vp.height}`);
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const [label, scenario] of vp.scenarios) {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    try {
      await scenario(page);
    } catch (error) {
      check(false, `${vp.name} · ${label}: threw ${error && error.message ? error.message.split("\n")[0] : error}`);
    }
    // The browser's own refusals (a missing element, a failed fetch) are bugs too.
    const noise = consoleErrors.filter((text) => !/Failed to load resource/.test(text));
    check(noise.length === 0, `${vp.name} · ${label}: console errors — ${noise.slice(0, 2).join(" | ")}`);
    await page.close();
  }
  await context.close();
}

await browser.close();
server.close();

console.log(`[board-rewind] ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error("[board-rewind] failures:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("[board-rewind] ok");
