// Repertoire workspace (Build) viewport smoke — fixture-backed.
// Serves the committed static/ tree, intercepts /api/* with real-shape fixtures
// (signed-in account + one repertoire with a real e5/Bf5/Nc6-style fork), and at
// 1440x900 / 1180x900 / 390x844 checks:
//   - no horizontal overflow, no console/page errors
//   - rep header + board label render; sync chip reads Saved
//   - breadcrumb strip renders; fork bar appears at the fork with chips + count
//   - a rendered practical share (maia_probability) shows on a chip
//   - mastery legend renders when own-side nodes are trained
//   - inspector toggles (Explorer/Coverage) stay mutually exclusive
// Tracked UI-v2 smoke: run the whole eight-view suite with
// `npm run smoke:ui-v2` (scripts/smoke/ui-v2/run-all.mjs).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.BUILD_SMOKE_PORT || 8794);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// One repertoire, one real fork at e5: mainline 3...Bf5 (generated — carries a
// real-shaped maia_probability), alternative 3...Na6 (manual — no probability).
// Own-side nodes carry mastery so the legend has something to mirror.
// FENs are chess.js-verified (1.e4 c6 2.d4 d5 3.e5 with Bf5/Na6 branches).
const BUILD_NODES = [
  { id: "n0", parent_id: null, depth: 0, san: null, uci: null, move_number: 1, ply: 0, move_side: "white", is_mainline: false, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null },
  { id: "n1", parent_id: "n0", depth: 1, san: "e4", uci: "e2e4", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", fen_after: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", move_number: 1, ply: 1, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n2", parent_id: "n1", depth: 2, san: "c6", uci: "c7c6", fen: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", fen_before: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", fen_after: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", move_number: 1, ply: 2, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "mastered", maia_probability: null, arrows: [], circles: [] },
  { id: "n3", parent_id: "n2", depth: 3, san: "d4", uci: "d2d4", fen: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", fen_before: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", fen_after: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", move_number: 2, ply: 3, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n4", parent_id: "n3", depth: 4, san: "d5", uci: "d7d5", fen: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", fen_before: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", fen_after: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", move_number: 2, ply: 4, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "learning", maia_probability: null, arrows: [], circles: [] },
  { id: "n5", parent_id: "n4", depth: 5, san: "e5", uci: "e4e5", fen: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_before: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", fen_after: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", move_number: 3, ply: 5, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n6", parent_id: "n5", depth: 6, san: "Bf5", uci: "c8f5", fen: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", fen_before: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_after: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", move_number: 3, ply: 6, move_side: "black", side_to_move: "white", source: "generated_maia3", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "due", maia_probability: 0.481, arrows: [], circles: [] },
  { id: "n7", parent_id: "n5", depth: 6, san: "Na6", uci: "b8a6", fen: "r1bqkbnr/pp2pppp/n1p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", fen_before: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_after: "r1bqkbnr/pp2pppp/n1p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", move_number: 3, ply: 6, move_side: "black", side_to_move: "white", source: "manual", is_mainline: false, is_enabled: true, is_prepared: false, mastery: "weak", maia_probability: null, arrows: [], circles: [] },
];

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/build/load")) {
    return {
      repertoire_id: "rep-1", name: "Caro-Kann: Advance", color: "black",
      writable: true, selected_node_id: "n5", root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      nodes: BUILD_NODES,
    };
  }
  if (path.startsWith("/api/repertoires")) {
    return {
      repertoires: [{ id: "rep-1", name: "Caro-Kann: Advance", color: "black", root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", notes: "", tags: [], is_active: true, team_id: null, visibility: "private", health: { trainable: 3, mastered: 1, weak: 1, due: 1, learning: 1, untrained: 0, mastery_pct: 33, shallow_lines: 0 } }],
      shared: [],
    };
  }
  if (path.startsWith("/api/dashboard")) {
    return { games: 0, repertoires: 1, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: { reviews_7d: 0, mastered_now: 0, mastered_delta: 0, weak_now: 0, weak_delta: 0 }, recommendations: [] };
  }
  if (path.startsWith("/api/explorer")) {
    return { opening: "Caro-Kann: Advance Variation", moves: [{ san: "Nf3", uci: "g1f3", total: 128432, white: 34, draw: 31, black: 35, whitePct: 34, drawPct: 31, blackPct: 35 }] };
  }
  if (path.startsWith("/api/teams")) return { teams: [] };
  if (path.startsWith("/api/lichess")) return { accounts: [] };
  if (path.startsWith("/api/settings")) return {};
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
if (!browser) { console.error("[build-smoke] no chromium-based browser available"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000); // boot + signed-in hydration

  // Open the workspace the way users do: double-click the repertoire row in the
  // Library (selects + previews on first click, opens Build on the second).
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]').dblclick();
  await page.waitForTimeout(1000); // /api/build/load + tree render

  // Rep header shows the real repertoire from /api/build/load.
  const repName = await page.locator("#build-rep-name").textContent().catch(() => "");
  check(repName.includes("Caro-Kann"), `rep header should show Caro-Kann, got "${repName}"`);

  // Board bar: label + sync chip (writable rep, nothing pending -> Saved).
  const label = await page.locator("#build-board-label").textContent().catch(() => "");
  check(label.length > 0, "board label should be non-empty");
  const sync = await page.locator("#build-sync").textContent().catch(() => "");
  check(/Saved/.test(sync), `sync chip should read Saved, got "${sync}"`);

  // Breadcrumb strip renders (we load at n5 = e5, path 1.e4 c6 2.d4 d5 3.e5).
  const crumbs = await page.locator("#builder-tree .mtree-crumb").count();
  check(crumbs === 5, `expected 5 breadcrumbs (e4 c6 d4 d5 e5), got ${crumbs}`);

  // Fork bar at e5: two chips, count, hint, and the real practical share on Bf5.
  const barVisible = await page.locator("#build-branchbar:not([hidden])").count();
  check(barVisible === 1, "fork bar should be visible at the e5 fork");
  const chips = await page.locator("#build-branchbar .branch-chip").count();
  check(chips === 2, `fork bar should have 2 chips, got ${chips}`);
  const count = await page.locator("#build-branchbar .branchbar-count").textContent().catch(() => "");
  check(count === "2", `fork count should be 2, got "${count}"`);
  const bf5Chip = page.locator('#build-branchbar .branch-chip', { hasText: "Bf5" });
  const share = await bf5Chip.locator(".branch-share").textContent().catch(() => "");
  check(share === "48%", `Bf5 chip should show the real 48% practical share, got "${share}"`);
  const nc6Chip = page.locator('#build-branchbar .branch-chip', { hasText: "Na6" });
  check((await nc6Chip.locator(".branch-share").count()) === 0, "Na6 (manual) chip must not fake a share");

  // Mastery legend mirrors the trained own-side nodes (mastered + learning + due + weak).
  const legend = await page.locator("#builder-tree .build-mlegend").count();
  check(legend === 1, "mastery legend should render under the breadcrumbs");
  const legendText = await page.locator("#builder-tree .build-mlegend").textContent().catch(() => "");
  check(/mastered/.test(legendText) && /learning/.test(legendText) && /due/.test(legendText) && /weak/.test(legendText), `legend should list all four trained kinds, got "${legendText}"`);

  // Tree rows carry mastery classes on own-side moves.
  const trained = await page.locator("#builder-tree .mtree-move.m-mastered, #builder-tree .mtree-move.m-learning, #builder-tree .mtree-move.m-due, #builder-tree .mtree-move.m-weak").count();
  check(trained >= 4, `own-side moves should carry mastery classes, got ${trained}`);

  // Inspector toggles mutually exclusive.
  console.log(`[${vp.name}] at inspector step; tree trained=${trained}`);
  await page.locator('[data-testid="build-tool-explorer"]').click();
  await page.waitForTimeout(400);
  const explorerOpen = await page.locator("#explorer-drawer:not([hidden])").count();
  check(explorerOpen === 1, "explorer drawer should open");
  await page.locator('[data-testid="build-tool-coverage"]').click();
  await page.waitForTimeout(400);
  const coverageOpen = await page.locator("#coverage-drawer:not([hidden])").count();
  const explorerClosed = await page.locator("#explorer-drawer[hidden]").count();
  check(coverageOpen === 1 && explorerClosed === 1, "coverage should replace explorer (mutually exclusive)");
  await page.locator('[data-testid="build-tool-coverage"]').click();

  // Keyboard: ↓ moves the fork pick onto the next chip.
  await page.locator("#build-branchbar .branch-chip.is-active").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const activeSan = await page.locator("#build-branchbar .branch-chip.is-active .branch-san").textContent().catch(() => "");
  check(activeSan === "Na6", `ArrowDown should move the pick to Na6, got "${activeSan}"`);

  // Overflow + console errors.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|favicon/.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();
}

try {
  for (const vp of [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1180", width: 1180, height: 900 },
    { name: "mobile-390", width: 390, height: 844 },
  ]) {
    await runViewport(vp);
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("[build-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[build-smoke] ok — all three viewports render the Repertoire workspace from fixture state with no overflow and no console errors.");
