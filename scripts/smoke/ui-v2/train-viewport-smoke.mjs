// Train viewport smoke — fixture-backed (same stack as build smoke).
// Checks at 1440x900 / 1180x900 / 390x844:
//   - no horizontal overflow, no console errors
//   - mode tabs render (Smart queue / Line rehearsal / Practice game)
//   - coach banner + named board controls + blitz row present in setup
//   - play mode shows opponent-book picker; switching back works
//   - progress panel + queue strip + up-next render from a live session fixture
import { checkTrainingHistory } from './training-history.mjs';
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
  { kind: "new", repertoire_name: "Najdorf prep", color: "black", targets: [{ node_id: "t3", uci: "e7e6", san: "e6", fen_before: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
  { kind: "polish", repertoire_name: "Ruy Lopez", color: "white", targets: [{ node_id: "t4", uci: "f1b5", san: "Bb5", fen_before: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", start_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", run_in: [], hint: {} }] },
];

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "T", email: "t@x" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) {
    return { repertoires: [
      { id: "rep-1", name: "Caro-Kann: Advance", color: "black", is_active: true, health: { trainable: 10, mastered: 3, weak: 2, due: 4, learning: 1, untrained: 0, mastery_pct: 30 } },
      { id: "rep-2", name: "London System", color: "white", is_active: true, health: { trainable: 8, mastered: 5, weak: 1, due: 1, learning: 1, untrained: 0, mastery_pct: 62 } },
      { id: "rep-empty", name: "Just started", color: "black", is_active: true, health: { trainable: 0, mastered: 0, weak: 0, due: 0, learning: 0, untrained: 0, mastery_pct: 0 } },
    ], shared: [] };
  }
  if (path.startsWith("/api/train/smart/summary")) {
    return { next_session: { cards: 4, weak: 1, due: 1, new: 1, polish: 1, resumed: 0 } };
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

  async function openTrain(target) {
    await target.goto(base, { waitUntil: "domcontentloaded" });
    await target.waitForTimeout(1000);
    if (vp.width > 760) {
      // The rail is a 60px icon rail that expands on hover (overlay). Mousemove,
      // pause for the 60ms+transition, then click while the label is still up.
      await target.mouse.move(30, 300);
      await target.waitForTimeout(400);
      // Onto the Train row itself, wherever the rail's density puts it.
      const row = await target.locator('[data-testid="nav-train"]').boundingBox();
      await target.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
      await target.waitForTimeout(120);
      await target.mouse.down();
      await target.mouse.up();
    } else {
      // Mobile: bottom tab bar.
      await target.evaluate(() => document.querySelector('[data-testid="bottom-train"]').click());
    }
    await target.waitForTimeout(800);
  }

  // Empty queue: one setup heading. The preview must not repeat it underneath.
  const emptyPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  try {
    await emptyPage.route("**/api/train/smart/summary**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ next_session: { cards: 0, weak: 0, due: 0, new: 0, polish: 0, resumed: 0 } }),
    }));
    await openTrain(emptyPage);
    await emptyPage.waitForFunction(
      () => document.getElementById("train-banner-title")?.textContent === "No moves to train yet",
      null,
      { timeout: 2000 },
    ).catch(() => {});
    const emptySetup = await emptyPage.evaluate(() => ({
      banner: document.getElementById("train-banner-title")?.textContent?.trim(),
      preview: document.getElementById("train-brief")?.textContent?.trim(),
      previewHidden: document.getElementById("train-brief")?.hidden,
      startHidden: document.getElementById("train-srs-start")?.hidden,
      fixHidden: document.getElementById("train-empty")?.hidden,
      fix: document.getElementById("train-empty-build")?.textContent?.trim(),
      history: (() => {
        const el = document.querySelector('#train-empty [data-train-history]');
        return el ? { text: el.textContent.trim(), visible: !!el.getBoundingClientRect().height } : null;
      })(),
    }));
    check(emptySetup.banner === "No moves to train yet", "empty queue banner should be the one heading, got " + JSON.stringify(emptySetup.banner));
    check(emptySetup.previewHidden === true, "empty queue preview should be hidden, got " + JSON.stringify(emptySetup.preview));
    // Nothing to train: a dead Start is not the answer; the way to fix it is.
    check(emptySetup.startHidden === true, "empty queue should hide Start, got " + JSON.stringify(emptySetup.startHidden));
    check(emptySetup.fixHidden === false && emptySetup.fix === "Open Repertoire", "empty queue should offer the fix, got " + JSON.stringify(emptySetup.fix));
    // History has to stay reachable when there is nothing to train: it is the
    // one thing a player wants exactly then, and it used to leave with Start.
    check(emptySetup.history?.visible === true && emptySetup.history.text === "History",
      "the empty queue must still offer History, got " + JSON.stringify(emptySetup.history));
  } finally {
    await emptyPage.close();
  }

  await openTrain(page);
  await page.waitForFunction(
    () => !document.getElementById("train-brief")?.hidden,
    null,
    { timeout: 2000 },
  ).catch(() => {});
  const setupPreview = await page.evaluate(() => ({
    banner: document.getElementById("train-banner-title")?.textContent?.trim(),
    preview: document.getElementById("train-brief")?.textContent?.trim(),
    previewHidden: document.getElementById("train-brief")?.hidden,
  }));
  check(setupPreview.banner === "Ready to train", "queue banner should be Ready to train, got " + JSON.stringify(setupPreview.banner));
  check(setupPreview.previewHidden === false && /cards?/.test(setupPreview.preview || ""), "queue preview should name the cards, got " + JSON.stringify(setupPreview.preview));

  // Setup: mode tabs render with Smart queue active.
  const tabs = await page.locator("#train-modes .train-mode").count();
  check(tabs === 3, `expected 3 mode tabs, got ${tabs}`);
  const activeMode = await page.locator("#train-modes .train-mode.is-active").textContent().catch(() => "");
  check(/Smart queue/.test(activeMode), `Smart queue should be the default mode, got "${activeMode}"`);

  // Setup feedback lives in the coach banner; the position label is populated
  // during a session. Assert the actual named controls, not idle label text.
  const bannerState = await page.locator("#train-banner").getAttribute("data-state").catch(() => "");
  check(!!bannerState, "coach banner should carry a data-state");
  // A phone hides the board bar while choosing what to train, so name the
  // controls by id rather than through the accessibility tree.
  check(await page.locator("#train-flip").getAttribute("aria-label") === "Flip board", "board flip must have an accessible name");
  check(await page.locator("#train-hint").isDisabled(), "hints should be disabled before a session starts");
  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  const shot = async (state) => {
    if (process.env.UI_V2_SHOTS) {
      await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `train-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
    }
  };
  await shot("setup");
  const blitzRow = await page.locator("#train-blitz-row").count();
  check(blitzRow === 1, "blitz toggle row should be present");

  // Repertoire picker loads the real /api/repertoires fixture. In Smart mode the
  // picker is hidden by design (the queue mixes all repertoires); assert the data
  // landed by reading the select's options regardless of visibility.
  const repOptions = await page.locator("#train-repertoire-select option").count();
  check(repOptions === 3, `repertoire picker should have 3 options loaded, got ${repOptions}`);

  // Line rehearsal's Start must follow the pick: dead on a repertoire with no
  // moves to walk, live again on one with moves.
  await page.evaluate(() => document.querySelector('#train-modes .train-mode[data-mode="all_lines"]').click());
  await page.waitForTimeout(300);
  const startState = () => page.evaluate(() => {
    const b = document.getElementById("start-train");
    const cs = getComputedStyle(b);
    return { disabled: b.disabled, title: b.title, opacity: cs.opacity, cursor: cs.cursor, background: cs.backgroundColor };
  });
  const liveStart = await startState();
  check(liveStart.disabled === false, "rehearsal Start should be live for a repertoire with moves");
  await page.evaluate(() => {
    const sel = document.getElementById("train-repertoire-select");
    sel.value = "rep-empty";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const emptyStart = await startState();
  check(emptyStart.disabled === true, "rehearsal Start should be dead when the repertoire has no moves");
  check(/No moves to train/.test(emptyStart.title), `rehearsal Start should say why, got "${emptyStart.title}"`);
  check(emptyStart.cursor === "not-allowed" && Number(emptyStart.opacity) < 1, "disabled Start should read as disabled");
  check(emptyStart.background !== liveStart.background, "disabled Start should not keep the enabled primary fill");
  await page.evaluate(() => {
    const sel = document.getElementById("train-repertoire-select");
    sel.value = "rep-1";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  check((await startState()).disabled === false, "rehearsal Start should come back with a trainable repertoire");

  // While setting up, Start is the screen's one action and it has to be on the
  // screen: the board used to take the full width and push it under the thumb
  // bar (Start's top was 785 in a 740px viewport). Measured from the real boxes,
  // not from the CSS — a rule that names a reserve proves nothing on its own.
  const startGeometry = await page.evaluate(() => {
    const box = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect().toJSON() : null);
    const start = box(document.getElementById("start-train"));
    const bar = box(document.querySelector("#view-train .board-bar"));
    const board = box(document.querySelector("#view-train .board-stack"));
    const card = box(document.querySelector("#view-train .train-sidebar .tcard"));
    return {
      start, bar, board, card,
      vh: window.innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  const aboveBar = startGeometry.bar ? startGeometry.start.bottom <= startGeometry.bar.top + 1 : startGeometry.start.bottom <= startGeometry.vh;
  check(!!startGeometry.start && aboveBar,
    `Start must sit above the thumb bar while setting up: ${JSON.stringify({ start: startGeometry.start, bar: startGeometry.bar, vh: startGeometry.vh })}`);
  check(startGeometry.start.height >= (vp.width <= 760 ? 44 : 30), `Start must be a thumb target on a phone and at least a control height on a desktop, got ${startGeometry.start.height}`);
  // A phone lays setup out as a page (the card's box dissolves into it) with
  // Start docked, so there the card check is Start's own above.
  check(vp.width <= 760 || (!!startGeometry.card && startGeometry.card.bottom <= (startGeometry.bar ? startGeometry.bar.top : startGeometry.vh)),
    `the setup card must be whole above the bar: ${JSON.stringify({ card: startGeometry.card, bar: startGeometry.bar })}`);
  check(startGeometry.board && startGeometry.board.width <= startGeometry.vh && startGeometry.board.height <= startGeometry.vh,
    `the setup board must fit the screen: ${JSON.stringify(startGeometry.board)}`);
  check(startGeometry.overflow <= 0, `no horizontal overflow while setting up, got ${startGeometry.overflow}px`);
  check(startGeometry.pageScroll <= 0, `the setup screen must not scroll the page, got ${startGeometry.pageScroll}px over`);
  await page.evaluate(() => document.querySelector('#train-modes .train-mode[data-mode="smart"]').click());
  await page.waitForTimeout(300);

  // Mode switch to Practice game works (and back). The rail overlay collapses on
  // mouse-out, so use the keyboard path users have: focus the tab, press Enter.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="train-mode-play"]');
    btn.focus();
    btn.click();
  });
  await page.waitForTimeout(400);
  const playSetup = await page.locator("#train-play-setup:not([hidden])").count();
  check(playSetup === 1, "play mode should reveal the play setup");
  await shot("play");
  await page.evaluate(() => document.querySelector('#train-modes .train-mode[data-mode="smart"]').click());
  await page.waitForTimeout(300);

  // Drive a live session through the app's own start path: stub the smart start
  // POST before clicking Start so the queue comes from our fixture. The bodies
  // are kept: "New session" must ask for another queue LIKE the one that
  // finished (same scope), not fall back to a different one.
  const startBodies = [];
  await page.route("**/api/train/smart/start", (route) => {
    startBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session_generation: '2026-10-21T07:00:00+00:00', state_version: 1,
        session_id: "s1", mode: "smart", mixed: false, fresh: true, resumed: false,
        repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance", color: "black",
        card_index: 0, total_cards: 4,
        requeue_gap: 3,
        card_kinds: [
          { key: "weak", label: "Weak spot", title: "Missed more than answered" },
          { key: "due", label: "Due review", title: "Spaced repetition says now" },
          { key: "new", label: "New move", title: "Shown once, then tested" },
          { key: "polish", label: "Polish", title: "Kept warm with an occasional rep" },
        ],
        counts: { weak: 1, due: 1, new: 1, polish: 1 },
        health: { trainable: 4, mastered: 0, weak: 1, due: 1, learning: 0, untrained: 2, mastery_pct: 0 },
        cards: CARDS,
      }),
    });
  });
  await page.evaluate(() => document.getElementById("start-train").click());
  await page.waitForTimeout(1500);

  await shot("active");

  // Starting a queue must not toast a number the panel already shows: the card
  // head reads "Card 1 / 4" and the setup brief named the queue's size.
  const startToasts = await page.locator(".notices .notice").allTextContents();
  check(!startToasts.some((t) => /Queue ready|Resumed queue/.test(t)),
    `starting a queue should not toast its size, got ${JSON.stringify(startToasts)}`);

  // Result screen: the finished session is a report, so the mode tabs are gone
  // with the setup card — "New session" is the way back to them. Reach it by
  // playing the whole 4-card fixture queue, one card at a time.
  for (const [from, to] of [["c7", "c6"], ["g1", "f3"], ["e7", "e6"], ["f1", "b5"]]) {
    for (const sq of [from, to]) {
      await page.evaluate((name) => {
        document.querySelector(`#train-board .square[data-square="${name}"]`).click();
      }, sq);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(2600);
  }
  const summaryUp = await page.locator("#train-summary:not([hidden])").count();
  check(summaryUp === 1, "finishing the last card should show the session results");
  await shot("summary");
  await checkTrainingHistory(page, check, shot);
  check(!(await page.locator("#train-modes").isVisible()), "the mode tabs should be hidden on the result screen");
  check((await page.locator("#train-mode-name").textContent()) === "Smart queue", "the result card should name the session's mode");
  await page.evaluate(() => document.getElementById("train-summary-new").click());
  await page.waitForTimeout(400);
  check(!(await page.locator("#train-modes").isVisible()), "New session starts the next queue without the mode tabs");
  // The finished queue is released before its summary paints, so the restart has
  // to keep the scope it drilled. This fixture queue was drilled for ONE
  // repertoire, so the restart must ask for that same repertoire — the old code
  // had already released the live session and widened to every active one.
  const first = startBodies[0] || {};
  const restart = startBodies[startBodies.length - 1] || {};
  check(startBodies.length >= 2, `New session should post a start, got ${JSON.stringify(startBodies)}`);
  check(restart.fresh === true && restart.mixed === false && restart.repertoire_id === "rep-1",
    `New session should keep the finished queue's repertoire, got ${JSON.stringify({ first, restart })}`);
  check(await page.locator("#train-back").isVisible(), "a session should offer Modes");
  await page.locator("#train-back").click();
  await page.waitForTimeout(300);
  check(await page.locator("#train-modes .train-mode[data-mode=\"smart\"]").isVisible(), "Modes should lead back to the mode tabs");
  check(await page.locator("#train-summary").evaluate((el) => el.hidden), "New session should clear the result screen");

  // Start a fresh session for the rest of the checks.
  await page.route("**/api/train/smart/start", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      session_generation: '2026-10-21T07:01:00+00:00', state_version: 1,
      session_id: "s1", mode: "smart", mixed: true, fresh: true, resumed: false,
      repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance", color: "black",
      card_index: 0, total_cards: 4,
      requeue_gap: 3,
      card_kinds: [
        { key: "weak", label: "Weak spot", title: "Missed more than answered" },
        { key: "due", label: "Due review", title: "Spaced repetition says now" },
        { key: "new", label: "New move", title: "Shown once, then tested" },
        { key: "polish", label: "Polish", title: "Kept warm with an occasional rep" },
      ],
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
  const upnextRows = await page.locator("#train-upnext:not([hidden]) .un-row").count();
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
    // The short phone is where Start's geometry broke: the full-width board left
    // the setup panel 146px and put Start under the bar. It needs its own run.
    { name: "phone-430x740", width: 430, height: 740 },
    { name: "phone-390x660", width: 390, height: 660 },
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
console.log("[train-smoke] ok — every viewport renders Train (setup + live session) from fixture state with no overflow and no console errors, and Start sits above the thumb bar with its setup card.");
