// Games viewport smoke — fixture-backed (same stack as train/build smokes).
// Checks at 1440x900 / 1180x900 / 390x844:
//   - no horizontal overflow, no console errors
//   - source tray chip + Sample + Check render; Check runs a real-shaped
//     /api/lichess/compare payload (page.route stub, no backend)
//   - outcome chips show real counts; ledger lists games with tone'd results
//   - focus detail: derived board + expected(good)/played(bad) arrows for the
//     user-error game; arrows react to the selected game without a standing legend
//   - outcome filter chip narrows the ledger
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.GAMES_SMOKE_PORT || 8801);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const GAMES = [
  {
    lichess_id: "g1", white: "opp_one", black: "me_user", result: "0-1", user_color: "black",
    in_repertoire: true, matched_plies: 3, departure_ply: 4, departure_move_uci: "d7d5",
    departure_reason: "user_left_preparation", repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance",
    move_san_history: ["e4", "c6", "Nf3", "d5"], expected_move_uci: "e7e6", expected_move_san: "e6",
    training_recorded: true, source_account: "self",
  },
  {
    lichess_id: "g2", white: "me_user", black: "opp_two", result: "1-0", user_color: "white",
    in_repertoire: true, matched_plies: 3, departure_ply: 4, departure_move_uci: "g8f6",
    departure_reason: "opponent_unprepared_branch", repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance",
    move_san_history: ["e4", "c6", "d4", "Nf6"], expected_move_uci: null, expected_move_san: null,
    training_recorded: false, source_account: "self",
  },
  {
    lichess_id: "g3", white: "me_user", black: "opp_three", result: "1-0", user_color: "white",
    in_repertoire: true, matched_plies: 4, departure_ply: null, departure_move_uci: null,
    departure_reason: "game_stayed_in_preparation", repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance",
    move_san_history: ["e4", "c6", "d4", "d5"], expected_move_uci: null, expected_move_san: null,
    training_recorded: false, source_account: "self",
  },
];

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) {
    return { repertoires: [
      { id: "rep-1", name: "Caro-Kann: Advance", color: "black", is_active: true, health: { trainable: 10, mastered: 3, weak: 2, due: 4, learning: 1, untrained: 0, mastery_pct: 30 } },
    ], shared: [] };
  }
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 1, training_sessions: 0, open_mistakes: 0, due_reviews: 5, due_soon: 1, streak: { current: 3, best: 9, trained_today: false }, recap: {}, recommendations: [] };
  // linked:true + a primary account drives appState.lichessUsername, which
  // syncReplayControls() requires before the Check button enables.
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
if (!browser) { console.error("[games-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  // Real-shaped compare payload on the production endpoint; no fake UI state.
  await page.route("**/api/lichess/compare", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ username: "self", count: GAMES.length, misses_recorded: 1, sources: ["self"], games: GAMES }),
    }));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (vp.width > 760) {
    // 60px hover-expand rail: hover to expand, then click the Games row by its
    // real position (locator clicks can land while the overlay is collapsing).
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-testid="nav-replay"]').boundingBox();
    check(!!box, "nav-replay should expose a bounding box on the expanded rail");
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.mouse.up();
    }
  } else {
    // Mobile: bottom tab bar.
    await page.evaluate(() => document.querySelector('[data-testid="bottom-review"]').click());
  }
  await page.waitForTimeout(700);

  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  const shot = async (state) => {
    if (!process.env.UI_V2_SHOTS) return;
    await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `games-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  };
  await shot("setup");

  // Setup: source tray, sample select, Check button.
  const chip = await page.locator('[data-testid="games-source-chips"] .src-chip').count();
  check(chip >= 1, `source tray should show at least one chip, got ${chip}`);
  const chipText = await page.locator('[data-testid="games-source-chips"] .src-chip').first().textContent().catch(() => "");
  check(/Self|me_user/.test(chipText || ""), `source tray should show the self/account chip, got "${chipText}"`);
  const sampleOptions = await page.locator("#replay-count option").count();
  check(sampleOptions === 4, `sample select should have 4 options, got ${sampleOptions}`);
  const checkDisabled = await page.locator("#lichess-compare-btn").isDisabled().catch(() => true);
  check(!checkDisabled, "Check button should be enabled with a source selected");

  // Run the check — renders the triage from the real payload shape.
  await page.evaluate(() => document.getElementById("lichess-compare-btn").click());
  await page.waitForTimeout(900);

  // Outcome chips: real counts from the payload kinds.
  const summaryText = await page.locator("#replay-summary").textContent().catch(() => "");
  check(/1 stayed in prep/.test(summaryText || ""), `summary should count 1 stayed in prep, got "${summaryText}"`);
  check(/1 you left prep/.test(summaryText || ""), `summary should count 1 you left prep`);
  check(/1 opponent left prep/.test(summaryText || ""), `summary should count 1 opponent departure`);
  check(/\+1 queued for training/.test(summaryText || ""), `summary should show the real queued count`);

  // Ledger: 3 rows; focused row (first, user-error) is open.
  const rows = await page.locator("#replay-results .lr[data-index]").count();
  check(rows === 3, `ledger should list 3 games, got ${rows}`);
  const openRows = await page.locator("#replay-results .lr.is-open").count();
  check(openRows === 1, `exactly one focused row, got ${openRows}`);

  // Focus detail: derived board + expected/played arrows for the user-error game.
  const board = await page.locator('[data-testid="replay-focus-board"] .scout-minisquare').count();
  check(board === 64, `focus board should render 64 squares, got ${board}`);
  const arrowGood = await page.locator("#replay-results .replay-arrows polygon.t-good").count();
  const arrowBad = await page.locator("#replay-results .replay-arrows polygon.t-bad").count();
  check(arrowGood === 1 && arrowBad === 1, `user-error focus should draw expected(good)+played(bad), got ${arrowGood}/${arrowBad}`);
  const focusText = await page.locator("#replay-results .focus").textContent().catch(() => "");
  check(/expected/.test(focusText || "") && /e6/.test(focusText || "") && /d5/.test(focusText || ""), "focus detail should name the expected and actual moves");
  check((await page.locator("#replay-results .focus .legend").count()) === 0, "focus should not show a standing arrow legend");

  await shot("triage");

  // Selecting the stayed-in-prep game drops the arrows.
  await page.locator("#replay-results .lr[data-index]").nth(2).evaluate((el) => el.click());
  await page.waitForTimeout(400);
  const arrowsAfter = await page.locator("#replay-results .replay-arrows").count();
  check(arrowsAfter === 0, `stayed-in-prep focus should have no arrow overlay, got ${arrowsAfter}`);
  check((await page.locator("#replay-results .focus .legend").count()) === 0, "stayed-in-prep focus should not show a standing legend");

  // Outcome filter chip narrows the ledger to its kind.
  await page.locator("#replay-summary [data-filter=\"user-error\"]").click();
  await page.waitForTimeout(400);
  const filtered = await page.locator("#replay-results .lr[data-index]").count();
  check(filtered === 1, `user-error filter should leave 1 row, got ${filtered}`);

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
  console.error("[games-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[games-smoke] ok — all three viewports render Games (tray, chips, ledger, focus board + arrows) from a real-shaped compare payload with no overflow and no console errors.");
