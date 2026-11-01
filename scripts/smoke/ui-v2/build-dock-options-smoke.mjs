// Build dock options across the phone breakpoint — fixture-backed.
// The options popover is placed with inline left/top on a desktop and is the
// phone sheet (phone/study.css) below the breakpoint. With the phone Explorer
// pane picked, opened at 1440x900 and left open while the window narrows to
// 390x844, it must become the sheet
// (left 8px, full width less 16px), not keep its desktop left and fall off the
// screen; widened again, it hangs inside the window.
// Tracked UI-v2 smoke: `npm run smoke:ui-v2` (scripts/smoke/ui-v2/run-all.mjs).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.BUILD_DOCK_OPTIONS_SMOKE_PORT || 8814);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const NODES = [
  { id: "n0", parent_id: null, depth: 0, san: null, uci: null, fen: START, fen_before: null, fen_after: START, move_number: 1, ply: 0, move_side: "white", is_mainline: false, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null },
  { id: "n1", parent_id: "n0", depth: 1, san: "e4", uci: "e2e4", fen: E4, fen_before: START, fen_after: E4, move_number: 1, ply: 1, move_side: "white", side_to_move: "black", source: "manual", is_mainline: true, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null, arrows: [], circles: [] },
];
const REP = { id: "rep-1", name: "Caro-Kann: Advance", color: "black", root_fen: START, notes: "", tags: [], is_active: true, team_id: null, visibility: "private", health: { trainable: 1, mastered: 0, weak: 0, due: 0, learning: 0, untrained: 1, mastery_pct: 0, shallow_lines: 0 } };
const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/build/load")) return { repertoire_id: "rep-1", name: REP.name, color: "black", writable: true, selected_node_id: "n1", root_fen: START, nodes: NODES };
  if (path.startsWith("/api/repertoires")) return { repertoires: [REP], shared: [] };
  if (path.startsWith("/api/lichess/explorer")) return { opening: { eco: "B10", name: "Caro-Kann Defense" }, moves: [{ uci: "c7c6", san: "c6", white: 6100, draws: 5600, black: 6540 }] };
  if (path.startsWith("/api/teams")) return { teams: [] };
  if (path.startsWith("/api/lichess")) return { accounts: [] };
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
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
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[dock-options-smoke] no chromium-based browser available"); server.close(); process.exit(2); }

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "domcontentloaded" });
  const row = page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]');
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.dblclick();
  await page.locator("#build-rep-name").filter({ hasText: "Caro-Kann" }).waitFor({ state: "attached", timeout: 15000 });
  // The phone pane the user picked is kept when the window widens.
  await page.locator('#build-panes [data-pane="explorer"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.locator("#build-dock-opts").click();
  await page.locator("#build-dock-tools:popover-open").waitFor({ timeout: 4000 });

  const box = () => page.evaluate(() => {
    const el = document.getElementById("build-dock-tools");
    const r = el.getBoundingClientRect();
    return { open: el.matches(":popover-open"), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), vw: innerWidth, vh: innerHeight };
  });
  const inside = (b) => b.left >= 0 && b.right <= b.vw && b.top >= 0 && b.bottom <= b.vh;
  const desk = await box();
  check(desk.open && inside(desk), `desktop: options should open inside the window: ${JSON.stringify(desk)}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const phone = await box();
  check(phone.open, "phone: options should stay open across the resize");
  check(Math.abs(phone.left - 8) <= 1 && Math.abs(phone.width - 374) <= 1 && inside(phone), `phone: options should be the sheet (left 8, width 374) inside the window: ${JSON.stringify(phone)}`);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const back = await box();
  check(!back.open || inside(back), `desktop again: open options should hang inside the window: ${JSON.stringify(back)}`);
  check(errors.length === 0, `page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("[dock-options-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[dock-options-smoke] ok — the Build dock options follow the window across the phone breakpoint.");
