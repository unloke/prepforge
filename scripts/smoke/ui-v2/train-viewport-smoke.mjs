// Train viewport smoke — fixture-backed (same stack as build smoke).
// Checks at 1440x900 / 1180x900 / 390x844:
//   - no horizontal overflow, no console errors
//   - mode tabs render (Smart queue / Line rehearsal / Play vs human)
//   - coach banner + board label + blitz row present in setup
//   - play mode shows opponent-book picker; switching back works
//   - progress panel + queue strip + up-next render from a live session fixture
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.TRAIN_SMOKE_PORT || 8798);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const CARDS = [
  { kind: "due", repertoire_name: "Caro-Kann: Advance", color: "black", targets: [{ node_id: "t1", uci: "c7c6", san: "c6", fen_before: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
  { kind: "weak", repertoire_name: "London System", color: "white", targets: [{ node_id: "t2", uci: "g1f3", san: "Nf3", fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
  { kind: "new", repertoire_name: "Najdorf prep", color: "black", targets: [{ node_id: "t3", uci: "e7e6", san: "e6", fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
  { kind: "polish", repertoire_name: "Ruy Lopez", color: "white", targets: [{ node_id: "t4", uci: "f1b5", san: "Bb5", fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
];

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) {
    return { repertoires: [
      { id: "rep-1", name: "Caro-Kann: Advance", color: "black", is_active: true, health: { trainable: 10, mastered: 3, weak: 2, due: 4, learning: 1, untrained: 0, mastery_pct: 30 } },
      { id: "rep-2", name: "London System", color: "white", is_active: true, health: { trainable: 8, mastered: 5, weak: 1, due: 1, learning: 1, untrained: 0, mastery_pct: 62 } },
    ], shared: [] };
  }
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 2, training_sessions: 0, open_mistakes: 0, due_reviews: 5, due_soon: 1, streak: { current: 3, best: 9, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess")) return { accounts: [] };
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
  } catch { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[train-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (vp.width > 760) {
    // The rail is a 60px icon rail that expands on hover (overlay). Mousemove,
    // pause for the 60ms+transition, then click while the label is still up.
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    await page.mouse.move(60, 236); // onto the Train row itself (y=216..254)
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.up();
  } else {
    // Mobile: bottom tab bar.
    await page.evaluate(() => document.querySelector('[data-testid="bottom-train"]').click());
  }
  await page.waitForTimeout(800);

  // Setup: mode tabs render with Smart queue active.
  const tabs = await page.locator("#train-modes .train-mode").count();
  check(tabs === 3, `expected 3 mode tabs, got ${tabs}`);
  const activeMode = await page.locator("#train-modes .train-mode.is-active").textContent().catch(() => "");
  check(/Smart queue/.test(activeMode), `Smart queue should be the default mode, got "${activeMode}"`);

  // Coach banner + board label + blitz row in setup.
  const bannerState = await page.locator("#train-banner").getAttribute("data-state").catch(() => "");
  check(!!bannerState, "coach banner should carry a data-state");
  const label = await page.locator("#train-board-label").textContent().catch(() => "");
  check(label.length > 0, "board label should be non-empty");
  const blitzRow = await page.locator("#train-blitz-row").count();
  check(blitzRow === 1, "blitz toggle row should be present");

  // Repertoire picker loads the real /api/repertoires fixture. In Smart mode the
  // picker is hidden by design (the queue mixes all repertoires); assert the data
  // landed by reading the select's options regardless of visibility.
  const repOptions = await page.locator("#train-repertoire-select option").count();
  check(repOptions === 2, `repertoire picker should have 2 options loaded, got ${repOptions}`);

  // Mode switch to Play vs human works (and back). The rail overlay collapses on
  // mouse-out, so use the keyboard path users have: focus the tab, press Enter.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="train-mode-play"]');
    btn.focus();
    btn.click();
  });
  await page.waitForTimeout(400);
  const playSetup = await page.locator("#train-play-setup:not([hidden])").count();
  check(playSetup === 1, "play mode should reveal the play setup");
  await page.evaluate(() => document.querySelector('#train-modes .train-mode[data-mode="smart"]').click());
  await page.waitForTimeout(300);

  // Drive a live session through the app's own start path: stub the smart start
  // POST before clicking Start so the queue comes from our fixture.
  await page.route("**/api/train/smart/start", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      session_id: "s1", mode: "smart", mixed: true, fresh: true, resumed: false,
      repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance", color: "black",
      card_index: 0, total_cards: 4,
      counts: { weak: 1, due: 1, new: 1, polish: 1 },
      health: { trainable: 4, mastered: 0, weak: 1, due: 1, learning: 0, untrained: 2, mastery_pct: 0 },
      cards: CARDS,
    }),
  }));
  await page.evaluate(() => document.getElementById("start-train").click());
  await page.waitForTimeout(1500);

  // Progress panel visible with real card counter.
  const panelHidden = await page.locator("#train-progress-panel").evaluate((el) => el.hidden);
  check(!panelHidden, "progress panel should be visible in an active session");
  const lineLabel = await page.locator("#train-line-label").textContent().catch(() => "");
  check(/Card 1 \/ 4/.test(lineLabel || ""), `card counter should read Card 1 / 4, got "${lineLabel}"`);

  // Queue strip renders the real composition (1 weak · 1 due · 1 new · 1 polish).
  const queueVisible = await page.locator("#train-queue:not([hidden])").count();
  check(queueVisible === 1, "queue strip should be visible");
  const legendText = await page.locator("#train-queue-legend").textContent().catch(() => "");
  check(/weak/.test(legendText) && /due/.test(legendText) && /new/.test(legendText), `queue legend should list kinds, got "${legendText}"`);

  // Up next: 3 rows from the real queue (kinds weak/new/polish ahead of card 1).
  const upnextRows = await page.locator("#train-upnext:not([hidden]) .train-upnext-row").count();
  check(upnextRows === 3, `up next should show 3 upcoming cards, got ${upnextRows}`);
  const upnextText = await page.locator("#train-upnext").textContent().catch(() => "");
  check(/London System/.test(upnextText || ""), "up next should name the real next repertoire");

  // Stats render (session starts at 0).
  const streak = await page.locator("#train-stat-streak").textContent().catch(() => "");
  check(streak.trim() === "0", `streak should start at 0, got "${streak}"`);

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
  ]) await runViewport(vp);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error("[train-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[train-smoke] ok — all three viewports render Train (setup + live session) from fixture state with no overflow and no console errors.");
