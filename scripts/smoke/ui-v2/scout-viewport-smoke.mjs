// Scout viewport smoke — fixture-backed (same stack as games/train smokes).
// Checks at 1440x900 / 1180x900 / 390x844:
//   - no horizontal overflow, no console errors
//   - Start streams a real-shaped lichess PGN payload (page.route stub)
//   - profile renders with the scouted username; live counter counts games
//   - "With White / With Black" tabs show real per-colour counts
//   - tab switch is visibility-only (sections toggle, counts stay)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.SCOUT_SMOKE_PORT || 8802);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

// Real-shaped PGN blocks: scouttarget as White (40 games) and as Black (32), across
// a spread of openings and results so the report has a plan, first moves and coverage.
// Unique Site ids — the client dedupes games by id (seenIds).
const AS_WHITE = [
  "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6",
  "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6",
  "1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5",
  "1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7",
  "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6",
  "1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5",
  "1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7",
];
const AS_BLACK = [
  "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6",
  "1. e4 c5 2. Nf3 Nc6 3. Bb5 g6 4. Bxc6 dxc6",
  "1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4",
  "1. d4 Nf6 2. Bg5 Ne4 3. Bf4 c5 4. e3 Qb6",
  "1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5",
  "1. e4 e6 2. d4 d5 3. Nd2 Nf6 4. e5 Nfd7",
];
const RESULTS = ["1-0", "1/2-1/2", "0-1", "1-0", "0-1", "1/2-1/2", "0-1"];
const GAME_TOTAL = 72;
const PGN = Array.from({ length: GAME_TOTAL }, (_, i) => {
  const asWhite = i % 9 < 5; // 40 white / 32 black
  const pool = asWhite ? AS_WHITE : AS_BLACK;
  const moves = pool[(i * 3 + (i >> 2)) % pool.length];
  const res = RESULTS[(i * 5 + (i >> 1)) % RESULTS.length];
  const day = String(1 + (i % 28)).padStart(2, "0");
  const d = `2026.09.${day}`;
  const t = `${String(8 + (i % 14)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00`;
  const [w, b] = asWhite ? ["scouttarget", `opp_${i}`] : [`opp_${i}`, "scouttarget"];
  const speed = i % 3 === 0 ? "rapid" : "blitz";
  return `[Event "Rated ${speed} game"]\n[Site "https://lichess.org/g${String(i).padStart(7, "0")}"]\n[Date "${d}"]\n[White "${w}"]\n[Black "${b}"]\n[Result "${res}"]\n[UTCDate "${d}"]\n[UTCTime "${t}"]\n[WhiteElo "${1800 + (i % 90)}"]\n[BlackElo "${1790 + ((i * 3) % 90)}"]\n[TimeControl "${speed === "rapid" ? "600+0" : "300+3"}"]\n[Variant "Standard"]\n\n${moves} ${res}`;
}).join("\n\n");

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
if (!browser) { console.error("[scout-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  // Scout source: external-only selection ("__none__" linked marker + the
  // external username), matching the prototype's "Add a Lichess username" flow.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("prepforge.scout_source", JSON.stringify(["__none__"]));
      localStorage.setItem("prepforge.scout_external", JSON.stringify(["scouttarget"]));
    } catch { /* private mode */ }
  });
  // Lichess PGN stream (production scout endpoint shape) + explorer pool.
  // Playwright checks routes latest-first: register the catch-all FIRST so the
  // specific handlers below take precedence.
  await page.route("**/lichess.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }));
  await page.route("**/lichess.org/api/explorer/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ total: 0, white: 0, draws: 0, black: 0, moves: [] }),
    }));
  await page.route("**/lichess.org/api/games/user/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-chess-pgn",
      headers: { "access-control-allow-origin": "*" },
      body: PGN,
    }));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (vp.width > 760) {
    // 60px hover-expand rail: hover, then click the Scout row by position.
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-testid="nav-scout"]').boundingBox();
    check(!!box, "nav-scout should expose a bounding box on the expanded rail");
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.mouse.up();
    }
  } else {
    // Mobile: bottom bar → More sheet → Scout.
    await page.evaluate(() => document.querySelector('[data-testid="bottom-more"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-nav-mirror="replay\\:scout"]').click());
  }
  await page.waitForTimeout(700);

  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  const shot = async (state) => {
    if (!process.env.UI_V2_SHOTS) return;
    await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `scout-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  };
  await shot("setup");

  // Source tray shows the external pick; Start is enabled.
  const chip = await page.locator('[data-testid="scout-source-chips"]').textContent().catch(() => "");
  check(/scouttarget/.test(chip || ""), `scout tray should show the external source, got "${chip}"`);
  const startDisabled = await page.locator("#scout-btn").isDisabled().catch(() => true);
  check(!startDisabled, "Start should be enabled with a source selected");

  // Pre-Start: the Scout view chunk must already be loaded, because it carries
  // views/scout.css. Assert both halves directly — the stylesheet is applied AND
  // the view has bound its controls — since "Start" must only drive the data flow.
  // Without the entry preload, both are still pending at this point.
  const preStart = await page.evaluate(() => {
    const btn = document.getElementById("scout-btn");
    const sheets = Array.from(document.styleSheets).map((s) => s.href || "").filter(Boolean);
    return {
      lazySheet: sheets.some((href) => /scout-[^/]*\.css$/.test(href)),
      bound: btn?.dataset?.scoutBound === "1",
      panelPresent: !!document.querySelector(".scout-panel"),
      panelVisible: (() => {
        const p = document.querySelector(".scout-panel");
        return !!p && !p.hidden && getComputedStyle(p).display !== "none";
      })(),
      reportEmpty: (document.getElementById("scout-results")?.textContent || "").trim() === "",
    };
  });
  check(preStart.panelPresent, "scout panel should be present before Start");
  check(preStart.panelVisible, "scout panel should be visible before Start");
  check(
    preStart.lazySheet,
    "pre-Start: views/scout.css should already be applied when the Scout section is shown",
  );
  check(
    preStart.bound,
    "pre-Start: the Scout view should already have bound its controls (Start is data-only)",
  );
  check(preStart.reportEmpty, "pre-Start: report should still be empty");

  // Run the scout — streams the stubbed PGN and builds the report.
  await page.evaluate(() => document.getElementById("scout-btn").click());
  await page.waitForTimeout(2500);

  // Profile renders the scouted username (external-only source).
  const profileText = await page.locator("#scout-profile").textContent().catch(() => "");
  check(/scouttarget/.test(profileText || ""), `profile should name the scouted player, got "${profileText.slice(0, 80)}"`);
  const liveCount = await page.locator('[data-testid="scout-live-count"]').textContent().catch(() => "0");
  check(new RegExp(String(GAME_TOTAL)).test(liveCount || "0"), `live counter should show ${GAME_TOTAL} games, got "${liveCount}"`);

  // Colour tabs with real per-colour counts (40 as White, 32 as Black).
  const tabs = await page.locator("#scout-results .scout-color-tab").count();
  check(tabs === 2, `expected 2 colour tabs, got ${tabs}`);
  const tabsText = await page.locator("#scout-results .scout-color-tabs").textContent().catch(() => "");
  check(/With White/.test(tabsText || "") && /With Black/.test(tabsText || ""), `tabs should read With White / With Black, got "${tabsText}"`);
  check(/40 games/.test(tabsText || "") && /32 games/.test(tabsText || ""), `tabs should show real counts (40 / 32), got "${tabsText}"`);

  // Default tab: White visible, Black hidden.
  const whiteVisible = await page.locator('#scout-results .scout-section[data-scout-color="white"]').evaluate((el) => !el.hidden);
  const blackVisible = await page.locator('#scout-results .scout-section[data-scout-color="black"]').evaluate((el) => !el.hidden);
  check(whiteVisible && !blackVisible, `default tab should show White only (white=${whiteVisible}, black=${blackVisible})`);

  // Prototype composition: profile card → colour card (plan rows) with the
  // line-detail card holding the first row's board; one open row at a time.
  const rows = await page.locator('#scout-results .scout-section[data-scout-color="white"] .line-row').count();
  check(rows >= 1, `game plan should list line rows, got ${rows}`);
  const sideOpen = await page.locator("#scout-side").evaluate((el) => !el.hidden && !!el.querySelector(".line-title") && !!el.querySelector(".scout-miniboard"));
  check(sideOpen, "line-detail card should show the first plan row with a board");
  const sideActions = await page.locator("#scout-side .scout-action-analyze").boundingBox().catch(() => null);
  check(!!sideActions && sideActions.height > 10, `line-detail card should show its Analyze action, got ${JSON.stringify(sideActions)} :: ${(await page.locator("#scout-side").innerHTML()).replace(/s+/g, " ").slice(0, 600)}`);
  if (rows >= 2) {
    const titleBefore = await page.locator("#scout-side .line-title").textContent();
    await page.locator('#scout-results .scout-section[data-scout-color="white"] .line-row').nth(1).evaluate((el) => el.click());
    await page.waitForTimeout(200);
    const titleAfter = await page.locator("#scout-side .line-title").textContent();
    const openRows = await page.locator("#scout-results .scout-line.is-expanded").count();
    check(titleAfter !== titleBefore, "selecting another row should swap the line-detail card");
    check(openRows === 1, `exactly one row should be open, got ${openRows}`);
  }

  await shot("report-white");
  await page.evaluate(() => { const m = document.querySelector(".scout-main"); if (m && m.scrollHeight > m.clientHeight) m.scrollTop = m.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForTimeout(200);
  await shot("report-white-bottom");
  await page.evaluate(() => { const m = document.querySelector(".scout-main"); if (m) m.scrollTop = 0; window.scrollTo(0, 0); });

  // Switch to Black — visibility-only (no re-render, sections keep counts).
  await page.locator('#scout-results .scout-color-tab[data-scout-tab="black"]').click();
  await page.waitForTimeout(300);
  const whiteAfter = await page.locator('#scout-results .scout-section[data-scout-color="white"]').evaluate((el) => !el.hidden);
  const blackAfter = await page.locator('#scout-results .scout-section[data-scout-color="black"]').evaluate((el) => !el.hidden);
  check(!whiteAfter && blackAfter, `black tab should swap visibility (white=${whiteAfter}, black=${blackAfter})`);
  const blackHead = await page.locator('#scout-results .scout-section[data-scout-color="black"] > h3').textContent().catch(() => "");
  check(/With Black/.test(blackHead || ""), `black section head should render, got "${blackHead.slice(0, 60)}"`);
  const sideColor = await page.locator("#scout-side").evaluate((el) => el.dataset.color);
  check(sideColor === "black", `switching tab should move the detail card to Black, got "${sideColor}"`);

  await shot("report-black");

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
  console.error("[scout-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[scout-smoke] ok — all three viewports render Scout (profile, tabs, per-colour sections) from a real-shaped PGN stream with no overflow and no console errors.");
