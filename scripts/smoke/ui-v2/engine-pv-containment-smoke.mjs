// Engine PV containment smoke — fixture-backed, production build, real browser engine.
//
// Regression guard for the Repertoire/Build inspector's engine card: the card is one
// drawer of the dock, the dock is sized to its drawers (fitBuildDock), and the card's
// lines are the only part of that drawer whose height changes while the user does
// nothing. Fitting only on a Build/Coverage paint left the dock a row short of the card
// each time a line arrived, a MultiPV step added rows or a new position emptied the
// block to pending rows — an internal scrollbar inside the inspector (or, stacked, the
// page) until the next unrelated repaint.
//
// Runs on the plain production build (`npm run build`, no E2E flags) with real
// browser Stockfish (a configured lite profile), and samples
// EVERY animation frame while the search streams:
//   - documentElement/body scrollWidth-clientWidth and scrollHeight-clientHeight
//   - #engine-window, #engine-window-pvs, #explorer-engine-slot, #explorer-drawer,
//     .dock-body scroll vs client (both axes)
//   - per-row escape: a row's box outside its slot/drawer box
// It exercises MultiPV 1→5 and two uncached positions (nothing cached for them), so the
// transient state is what is measured, not the settled content.
//
// Usage: node scripts/smoke/ui-v2/engine-pv-containment-smoke.mjs
//        ENGINE_PV_SMOKE_PORT=8796 (default) — unique port per worker.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.ENGINE_PV_SMOKE_PORT || 8796);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// One repertoire with a real Caro-Kann Advance line plus two deeper, never-analysed
// nodes: selecting them is the "uncached position with a long PV" state. FENs are
// chess.js-verified (1.e4 c6 2.d4 d5 3.e5 Bf5 4.Nf3 e6 5.Bd3 Bxd3).
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const NODES = [
  { id: "n0", parent_id: null, depth: 0, san: null, uci: null, move_number: 1, ply: 0, move_side: "white", fen: START, source: "manual", is_mainline: false, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n1", parent_id: "n0", depth: 1, san: "e4", uci: "e2e4", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", fen_before: START, fen_after: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", move_number: 1, ply: 1, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n2", parent_id: "n1", depth: 2, san: "c6", uci: "c7c6", fen: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", fen_before: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", fen_after: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", move_number: 1, ply: 2, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "mastered", maia_probability: null, arrows: [], circles: [] },
  { id: "n3", parent_id: "n2", depth: 3, san: "d4", uci: "d2d4", fen: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", fen_before: "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", fen_after: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", move_number: 2, ply: 3, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n4", parent_id: "n3", depth: 4, san: "d5", uci: "d7d5", fen: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", fen_before: "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", fen_after: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", move_number: 2, ply: 4, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "learning", maia_probability: null, arrows: [], circles: [] },
  { id: "n5", parent_id: "n4", depth: 5, san: "e5", uci: "e4e5", fen: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_before: "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", fen_after: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", move_number: 3, ply: 5, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n6", parent_id: "n5", depth: 6, san: "Bf5", uci: "c8f5", fen: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", fen_before: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_after: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", move_number: 3, ply: 6, move_side: "black", side_to_move: "white", source: "generated_maia3", is_mainline: true, is_enabled: true, is_prepared: true, mastery: "due", maia_probability: 0.481, arrows: [], circles: [] },
  { id: "n7", parent_id: "n5", depth: 6, san: "Na6", uci: "b8a6", fen: "r1bqkbnr/pp2pppp/n1p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", fen_before: "rnbqkbnr/pp2pppp/2p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3", fen_after: "r1bqkbnr/pp2pppp/n1p5/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", move_number: 3, ply: 6, move_side: "black", side_to_move: "white", source: "manual", is_mainline: false, is_enabled: true, is_prepared: false, mastery: "weak", maia_probability: null, arrows: [], circles: [] },
  { id: "n8", parent_id: "n6", depth: 7, san: "Nf3", uci: "g1f3", fen: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 4", fen_before: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4", fen_after: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 4", move_number: 4, ply: 7, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n9", parent_id: "n8", depth: 8, san: "e6", uci: "e7e6", fen: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 5", fen_before: "rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 4", fen_after: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 5", move_number: 4, ply: 8, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n10", parent_id: "n9", depth: 9, san: "Bd3", uci: "f1d3", fen: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/3B1N2/PPP2PPP/RNBQK2R b KQkq - 1 5", fen_before: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 5", fen_after: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/3B1N2/PPP2PPP/RNBQK2R b KQkq - 1 5", move_number: 5, ply: 9, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
  { id: "n11", parent_id: "n10", depth: 10, san: "Bxd3", uci: "f5d3", fen: "rn1qkbnr/pp3ppp/2p1p3/3pP3/3P4/3b1N2/PPP2PPP/RNBQK2R w KQkq - 0 6", fen_before: "rn1qkbnr/pp3ppp/2p1p3/3pPb2/3P4/3B1N2/PPP2PPP/RNBQK2R b KQkq - 1 5", fen_after: "rn1qkbnr/pp3ppp/2p1p3/3pP3/3P4/3b1N2/PPP2PPP/RNBQK2R w KQkq - 0 6", move_number: 5, ply: 10, move_side: "black", side_to_move: "white", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
];

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "PV Smoke", email: "pv@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/build/load")) {
    return { repertoire_id: "rep-1", name: "Caro-Kann: Advance", color: "black", writable: true, selected_node_id: "n5", root_fen: START, nodes: NODES };
  }
  if (path.startsWith("/api/repertoires")) {
    return {
      repertoires: [{ id: "rep-1", name: "Caro-Kann: Advance", color: "black", root_fen: START, notes: "", tags: [], is_active: true, team_id: null, visibility: "private", health: { trainable: 3, mastered: 1, weak: 1, due: 1, learning: 1, untrained: 0, mastery_pct: 33, shallow_lines: 0 } }],
      shared: [],
    };
  }
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 1, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: { moves_reviewed_7d: 0, mastered_now: 0, mastered_delta: 0, weak_now: 0, weak_delta: 0 }, recommendations: [] };
  if (path.startsWith("/api/lichess/explorer")) return { opening: { eco: "B12", name: "Caro-Kann: Advance Variation" }, moves: [{ uci: "c8f5", san: "Bf5", white: 6100, draws: 5600, black: 6540 }, { uci: "c8g4", san: "Bg4", white: 1120, draws: 900, black: 1080 }] };
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
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] || "application/octet-stream",
      // Cross-origin isolation so the real browser Stockfish (threaded WASM) runs.
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
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* next */ }
}
if (!browser) { console.error("[engine-pv-smoke] no chromium-based browser available"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

// Every animation frame records the worst metric seen so far, so the transient
// state of a streaming search is measured, not the settled content after it.
const SAMPLER = () => {
  const box = (el) => (el ? el.getBoundingClientRect() : null);
  window.__pvWorst = null;
  window.__pvFrames = 0;
  const sample = () => {
    const doc = document.documentElement;
    const pvs = document.getElementById("engine-window-pvs");
    const slot = document.getElementById("explorer-engine-slot");
    const drawer = document.getElementById("explorer-drawer");
    const body = document.querySelector("#build-inspector .dock-body");
    const rows = [...(pvs?.querySelectorAll(".engine-pv") || [])];
    const pvsBox = box(pvs);
    const slotBox = box(slot);
    const outside = (a, b) => !!a && !!b && (a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5 || a.left < b.left - 0.5 || a.right > b.right + 0.5);
    const row = (el) => (el ? [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight] : [0, 0]);
    const next = {
      docX: doc.scrollWidth - doc.clientWidth,
      docY: doc.scrollHeight - doc.clientHeight,
      pvsX: row(pvs)[0], pvsY: row(pvs)[1],
      slotX: row(slot)[0], drawerX: row(drawer)[0],
      bodyX: row(body)[0], bodyY: row(body)[1],
      escapedSlot: rows.filter((r) => outside(box(r), slotBox)).length,
      escapedPanel: rows.filter((r) => outside(box(r), pvsBox)).length,
      rows: rows.length,
    };
    const w = window.__pvWorst;
    if (!w) window.__pvWorst = next;
    else for (const k of Object.keys(next)) w[k] = Math.max(w[k], next[k]);
    window.__pvFrames += 1;
    window.__pvRaf = requestAnimationFrame(sample);
  };
  window.__pvRaf = requestAnimationFrame(sample);
};

// Selecting a move needs the tree on screen: phones show one pane at a time, so a
// stacked viewport goes to Moves, picks the node, then returns to Explorer (where
// the engine card lives) before the next measurement.
async function selectNode(page, id, phone) {
  const pane = (name) => page.locator(`#build-panes [data-pane="${name}"]`);
  if (phone) {
    await pane("moves").click();
    await page.locator(`#builder-tree .mtree-move[data-node-id="${id}"]`).click();
    await pane("explorer").click();
    return;
  }
  await page.locator(`#builder-tree .mtree-move[data-node-id="${id}"]`).click();
}

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "768x900", width: 768, height: 900 },
  { name: "390x660", width: 390, height: 660 },
];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  // A configured device runs the real lite engine without first benchmarking
  // hardware alongside the search. This checks streamed layout, not Detect.
  await page.addInitScript(() => localStorage.setItem("prepforge.engine-profile", JSON.stringify({
    profile: { net: "lite", workers: 2, source: "user" }, consent: "no",
  })));
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]').dblclick();
  await page.locator("#build-rep-name").filter({ hasText: "Caro-Kann" }).waitFor({ state: "attached", timeout: 20000 });

  // Phones switch panes with the segmented control; the engine switch lives on
  // the Explorer pane at every width.
  const pane = page.locator('#build-panes [data-pane="explorer"]');
  if (await pane.isVisible().catch(() => false)) await pane.click();
  await page.locator('[data-testid="open-engine-widget-build"]').click();
  await page.waitForSelector("#engine-window.is-visible", { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector("#engine-window-pvs .engine-pv:not(.is-pending) .pv-move"),
    null,
    { timeout: 90000 },
  ).catch(async error => {
    console.error(`[engine-pv-smoke] ${vp.name} startup`, await page.evaluate(() => ({
      card: document.getElementById("engine-window")?.innerText,
      profile: localStorage.getItem("prepforge.engine-profile"), isolated: crossOriginIsolated,
    })), errors);
    throw error;
  });
  console.log(`[engine-pv-smoke] ${vp.name} first PV ready`);
  await page.evaluate(SAMPLER);

  // 1. MultiPV 1→5, sampling the raise and the streaming that follows.
  for (let i = 0; i < 4; i += 1) await page.locator("#engine-lines-up").click();
  await page.waitForTimeout(2500);
  // 2. Two uncached positions: nothing is cached for either, so the pending rows
  //    and the first long lines are the state under measurement.
  const phone = vp.width <= 760;
  await selectNode(page, "n8", phone);
  await page.waitForTimeout(2500);
  await selectNode(page, "n10", phone);
  await page.waitForTimeout(2500);
  // Pending placeholders also count as five rows. Require actual engine output
  // before accepting containment of the final uncached position.
  console.log(`[engine-pv-smoke] ${vp.name} final search`, await page.locator("#engine-window").innerText());
  await page.waitForFunction(() =>
    document.querySelectorAll("#engine-window-pvs .engine-pv:not(.is-pending) .pv-move").length > 0,
  null, { timeout: 90000 }).catch(async error => {
    console.error(`[engine-pv-smoke] ${vp.name} final search failed`,
      await page.locator("#engine-window").innerText(), errors);
    throw error;
  });

  // At stacked widths (≤860) the page is the documented scroll owner for Build
  // (styles.css: the sidebar drops its one-screen fit), so a taller inspector is
  // reached by scrolling the page — that is not the card escaping. What must hold
  // there is that the rows are still reachable and inside the card's slot.
  const reach = await page.evaluate(() => {
    cancelAnimationFrame(window.__pvRaf);
    const pvs = document.getElementById("engine-window-pvs");
    const rows = [...pvs.querySelectorAll(".engine-pv")];
    const last = rows[rows.length - 1];
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const el of document.querySelectorAll("#view-build *")) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
    const b = last?.getBoundingClientRect();
    return { worst: window.__pvWorst, frames: window.__pvFrames, lastVisible: !!b && b.top >= -1 && b.bottom <= innerHeight + 1, rows: rows.length };
  });
  const worst = reach;
  const w = worst.worst;
  console.log(`[engine-pv-smoke] ${vp.name} frames=${worst.frames} worst=${JSON.stringify(w)}`);
  check(reach.frames > 60, `${vp.name}: the sampler ran through the streaming update (${reach.frames} frames)`);
  check(reach.rows === 5, `${vp.name}: all five requested lines are rendered (got ${reach.rows})`);
  check(reach.lastVisible, `${vp.name}: the last line stays reachable, never clipped away`);
  check(w.docX <= 0, `${vp.name}: the page must not gain horizontal scroll while the lines stream (worst ${w.docX}px)`);
  check(w.pvsX <= 0, `${vp.name}: the PV block must clip a long line, not scroll sideways (worst ${w.pvsX}px)`);
  check(w.escapedSlot === 0, `${vp.name}: a PV row must stay inside its slot (worst ${w.escapedSlot})`);
  check(w.escapedPanel === 0, `${vp.name}: a PV row must stay inside its panel (worst ${w.escapedPanel})`);
  // #explorer-engine-slot is deliberately full-bleed (margin -12px inside the body's
  // 12px padding), so the drawer reports exactly that 12px as scrollWidth overflow at
  // every viewport and with the engine closed. Anything beyond it is new bleed.
  check(w.drawerX <= 12, `${vp.name}: the Explorer drawer must not bleed past its slot margins (worst ${w.drawerX}px)`);
  check(w.bodyX <= 1, `${vp.name}: the inspector body must not scroll sideways (worst ${w.bodyX}px)`);
  // Above the stacking breakpoint the panel owns the screen and the inspector is the
  // intended internal scroll area, so the page itself must not move. Below it the page
  // is the documented scroll owner (styles.css); the reach check above covers that the
  // extra height is scrollable content, not content hidden under a clip.
  if (vp.width > 860) {
    check(w.docY <= 0, `${vp.name}: the page must not scroll vertically while the lines stream (worst ${w.docY}px)`);
    // Above the breakpoint the dock is fitted to its drawers, so the inspector must
    // not grow an internal scrollbar for rows that arrived after the last paint:
    // that is the transient this guards (measured 55px before the fix).
    check(w.bodyY <= 0, `${vp.name}: the inspector must stay fitted to the card's rows (worst ${w.bodyY}px of internal scroll)`);
  }

  const real = errors.filter((t) => !/Failed to load resource|favicon/.test(t));
  check(real.length === 0, `${vp.name}: console errors: ${real.join(" | ")}`);
  await page.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`[engine-pv-smoke] FAIL\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("[engine-pv-smoke] ok — the engine card's lines stay contained through MultiPV and uncached positions at all three viewports.");
