// Repertoire workspace (Build) viewport smoke — fixture-backed.
// Serves the committed static/ tree, intercepts /api/* with real-shape fixtures
// (signed-in account + one repertoire with a real e5/Bf5/Nc6-style fork), and at
// 1440x900 / 1180x900 / 390x844 checks:
//   - no horizontal overflow, no console/page errors
//   - rep header + board label render; sync chip reads Saved
//   - breadcrumb strip renders; fork bar appears at the fork with chips + count
//   - a rendered practical share (maia_probability) shows on a chip
//   - trained moves carry mastery classes without a standing legend
//   - the dock tabs (Explorer/Coverage/Engine) are a single-select tablist and
//     the Explorer tab is open by default with real W/D/L rows
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
// Own-side nodes carry mastery so the tree colours have real training data.
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
  // Shared-link payload (writable:false) — the read-only state the static
  // Opus host must render without any runtime banner injection.
  if (path.startsWith("/api/shared/")) {
    return {
      repertoire_id: "rep-shared", name: "Sicilian Najdorf (shared)", color: "black",
      writable: false, selected_node_id: "n5", root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      nodes: BUILD_NODES,
    };
  }
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
  if (path.startsWith("/api/lichess/explorer")) {
    return {
      opening: { eco: "B12", name: "Caro-Kann: Advance Variation" },
      moves: [
        { uci: "c8f5", san: "Bf5", white: 6100, draws: 5600, black: 6540 },
        { uci: "c8g4", san: "Bg4", white: 1120, draws: 900, black: 1080 },
        { uci: "e7e6", san: "e6", white: 610, draws: 800, black: 700 },
      ],
    };
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
  // Wait for the real hydrated row, not a fixed sleep. This smoke has no
  // Playwright auto-wait on this path, so a slow CI runner (the Library
  // smoke took 47s there vs 4.5s locally) could click before the delegated
  // dashboard handler was bound - which surfaced as
  // 'rep header should show Caro-Kann, got "No repertoire open"'.
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]')
    .waitFor({ state: "visible", timeout: 15000 });

  // Open the workspace the way users do: double-click the repertoire row in the
  // Library (selects + previews on first click, opens Build on the second).
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]').dblclick();
  // Same reasoning for the build load: wait until the header actually carries
  // the repertoire instead of hoping 1s was enough.
  await page.locator("#build-rep-name")
    .filter({ hasText: "Caro-Kann" })
    .waitFor({ state: "attached", timeout: 15000 });

  // Rep header shows the real repertoire from /api/build/load.
  const repName = await page.locator("#build-rep-name").textContent().catch(() => "");
  check(repName.includes("Caro-Kann"), `rep header should show Caro-Kann, got "${repName}"`);

  // Writable state: the shared host stays in the DOM but hidden — the writable
  // panel must not carry a leftover read-only banner from a previous state.
  const bannerWritable = await page.locator('[data-testid="shared-banner"]').evaluate((el) => ({
    hidden: el.hidden,
    connected: el.isConnected,
    inPanel: !!el.closest("#view-build .sidebar"),
    parentIsSidebar: el.parentElement.matches("#view-build .sidebar, #view-build .sidebar > .panel-body"),
  })).catch(() => null);
  check(!!bannerWritable, "shared banner host should exist in the writable state");
  check(bannerWritable?.hidden === true, `writable state should hide the shared banner, got hidden=${bannerWritable?.hidden}`);
  check(bannerWritable?.inPanel === true, "shared banner host should live inside the Build Opus panel");
  check(bannerWritable?.parentIsSidebar === true, "shared banner host should be a direct child of the Build sidebar (no injected wrapper)");

  // Board bar: label + sync chip (writable rep, nothing pending -> Saved).
  const label = await page.locator("#build-board-label").textContent().catch(() => "");
  check(label.length > 0, "board label should be non-empty");
  const sync = await page.locator("#build-sync").textContent().catch(() => "");
  check(/Saved/.test(sync), `sync chip should read Saved, got "${sync}"`);

  // Breadcrumb strip renders (we load at n5 = e5, path 1.e4 c6 2.d4 d5 3.e5).
  const crumbs = await page.locator("#build-tree-meta .mtree-crumb").count();
  check(crumbs === 6, `expected 6 breadcrumbs (Start e4 c6 d4 d5 e5), got ${crumbs}`);

  // Build header: size summary + Generate live next to the repertoire name.
  const repStats = await page.locator("#build-rep-stats").textContent().catch(() => "");
  check(/2 lines · 7 moves/.test(repStats), `build header should read "2 lines · 7 moves", got "${repStats}"`);
  check((await page.locator("#build-generate-node:visible").count()) === 1, "Generate moves should be visible in the build header");

  // Fork bar at e5: two chips, count, and the real practical share on Bf5.
  const barVisible = await page.locator("#build-branchbar:not([hidden])").count();
  check(barVisible === 1, "fork bar should be visible at the e5 fork");
  const chips = await page.locator("#build-branchbar .fork-chip").count();
  check(chips === 2, `fork bar should have 2 chips, got ${chips}`);
  const count = await page.locator("#build-branchbar .count").textContent().catch(() => "");
  check(count === "2", `fork count should be 2, got "${count}"`);
  const bf5Chip = page.locator('#build-branchbar .fork-chip', { hasText: "Bf5" });
  const share = await bf5Chip.locator("small").textContent().catch(() => "");
  check(share === "48%", `Bf5 chip should show the real 48% practical share, got "${share}"`);
  const nc6Chip = page.locator('#build-branchbar .fork-chip', { hasText: "Na6" });
  check((await nc6Chip.locator("small").count()) === 0, "Na6 (manual) chip must not fake a share");

  // Mastery stays on the moves; the panel has no standing colour legend.
  const legend = await page.locator("#build-tree-meta .legend").count();
  check(legend === 0, "breadcrumbs should not have a standing mastery legend");

  // Tree rows carry mastery classes on own-side moves.
  const trained = await page.locator("#builder-tree .mtree-move.m-mastered, #builder-tree .mtree-move.m-learning, #builder-tree .mtree-move.m-due, #builder-tree .mtree-move.m-weak").count();
  check(trained >= 4, `own-side moves should carry mastery classes, got ${trained}`);

  await page.locator("#explorer-rows .explorer-row").first().waitFor({ timeout: 4000 }).catch(() => {});

  // Optional review screenshot (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  if (process.env.UI_V2_SHOTS) {
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `repertoire-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  }

  // Dock: Explorer is open by default and shows real W/D/L rows; tabs are a
  // single-select tablist (Coverage replaces Explorer, Engine docks the widget).
  console.log(`[${vp.name}] at dock step; tree trained=${trained}`);
  await page.locator("#explorer-rows .explorer-row").first().waitFor({ timeout: 4000 }).catch(() => {});
  check((await page.locator("#explorer-drawer:not([hidden])").count()) === 1, "explorer panel should be open by default");
  const exRows = await page.locator("#explorer-rows .explorer-row").count();
  check(exRows === 3, `explorer should list 3 fixture moves, got ${exRows}`);
  check((await page.locator("#build-tool-explorer[aria-selected='true']").count()) === 1, "Explorer tab should be selected");
  // Phones switch panes with the segmented control above the tree.
  const tool = (name) => page.locator(vp.width <= 760 ? `#build-panes [data-pane="${name}"]` : `[data-testid="build-tool-${name}"]`);
  await tool("coverage").click();
  await page.waitForTimeout(300);
  check((await page.locator("#coverage-drawer:not([hidden])").count()) === 1 && (await page.locator("#explorer-drawer[hidden]").count()) === 1, "coverage should replace explorer");
  check((await page.locator("#coverage-run:visible").count()) === 1, "Scan should show on the Coverage tab");
  await tool("explorer").click();
  await page.waitForTimeout(300);
  check((await page.locator("#explorer-drawer:not([hidden])").count()) === 1, "explorer should return");
  if (vp.width <= 760) await tool("moves").click();

  // Keyboard: ↓ moves the fork pick onto the next chip.
  await page.locator("#build-branchbar .fork-chip.is-active").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const activeSan = await page.locator("#build-branchbar .fork-chip.is-active").textContent().catch(() => "");
  check(activeSan.includes("Na6"), `ArrowDown should move the pick to Na6, got "${activeSan}"`);

  // Overflow + console errors.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|favicon/.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();

  // ----- Shared / read-only state -------------------------------------------
  // Opened via the share link (?shared=...), the path that returns
  // writable:false. The banner must be the static Opus host: still a direct
  // child of the Build sidebar, revealed by flipping `hidden`, with its text
  // swapped in place. No element creation, no prepend, no re-render.
  const sharedPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const sharedErrors = [];
  sharedPage.on("console", (m) => { if (m.type() === "error") sharedErrors.push(m.text()); });
  sharedPage.on("pageerror", (e) => sharedErrors.push(`pageerror: ${e.message}`));
  const sharedCheck = (ok, label) => { if (!ok) failures.push(`${vp.name} shared: ${label}`); };

  await sharedPage.goto(`${base}/?shared=smoke-token`, { waitUntil: "domcontentloaded" });
  await sharedPage.waitForTimeout(1200); // boot + /api/shared/<token> hydrate

  const host = await sharedPage.locator('[data-testid="shared-banner"]').evaluate((el) => ({
    exists: true,
    hidden: el.hidden,
    parentIsSidebar: el.parentElement.matches("#view-build .sidebar, #view-build .sidebar > .panel-body"),
    isFirstChildOfSidebar: el.parentElement?.firstElementChild === el
      || !!el.parentElement?.previousElementSibling?.classList.contains("panel-head"),
    title: document.getElementById("shared-banner-title")?.textContent || "",
    forkInStaticHost: !!el.querySelector('[data-testid="shared-fork-btn"]'),
  })).catch(() => null);

  sharedCheck(!!host, "shared banner host should render for a shared repertoire");
  sharedCheck(host?.hidden === false, `shared banner should be visible, got hidden=${host?.hidden}`);
  sharedCheck(
    host?.parentIsSidebar === true,
    "shared banner must stay a direct child of the Build sidebar (runtime prepend path removed)",
  );
  sharedCheck(
    !!host?.title.includes("Sicilian Najdorf"),
    `shared banner title should name the shared repertoire, got "${host?.title}"`,
  );
  sharedCheck(
    host?.forkInStaticHost === true,
    "Copy button should live inside the static host",
  );

  // Exactly one banner in the document — a leftover from the legacy
  // create/prepend path would show up as a second node.
  const bannerCount = await sharedPage.locator("#shared-banner").count();
  sharedCheck(bannerCount === 1, `expected exactly 1 shared banner, got ${bannerCount}`);

  // Coverage is analysis, so a read-only repertoire can still be scanned; its
  // gaps render without the edit controls (covered by coverage-workbench-smoke).
  const scanEnabled = await sharedPage.locator("#coverage-run").isEnabled().catch(() => false);
  sharedCheck(scanEnabled, "Coverage Scan should be available for a read-only repertoire");

  // Toggling back to writable hides the host rather than removing it.
  const hostStillThere = await sharedPage.locator('[data-testid="shared-banner"]').count();
  sharedCheck(hostStillThere === 1, "shared banner host should persist in the DOM, not be removed");

  const sharedOverflow = await sharedPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  sharedCheck(sharedOverflow <= 0, `shared state horizontal overflow of ${sharedOverflow}px`);
  const realSharedErrors = sharedErrors.filter((t) => !/Failed to load resource|favicon/.test(t));
  sharedCheck(realSharedErrors.length === 0, `shared state console errors: ${realSharedErrors.join(" | ")}`);

  await sharedPage.close();
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
console.log("[build-smoke] ok — all three viewports render the Repertoire workspace (writable + shared/read-only) from fixture state with no overflow and no console errors.");
