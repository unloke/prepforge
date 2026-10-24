// Train viewport smoke — fixture-backed (same stack as build smoke).
// Train is Home → Session → Result (#view-train[data-train-screen]). Checks at
// 1440x900 / 1180x900 / 390x844 and two short phones:
//   - Home: the outlook, then one row per job (Due queue, Rehearse, Practice),
//     each Start on screen; nothing due is one quiet line; an empty queue
//     offers its fix and keeps History
//   - Session: Back, the card counter, up next, from a live queue fixture
//   - Result: history, Again keeps the scope, Back returns Home
//   - no horizontal overflow, no page scroll on Home, no console errors
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
    return { next_session: { cards: 4, weak: 1, due: 1, new: 1, polish: 1, resumed: 0, left: 4, upcoming: [
      { kind: "weak", repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance", color: "black", line: "1.e4 c6 2.d4 d5 3.e5" },
      { kind: "due", repertoire_id: "rep-2", repertoire_name: "London System", color: "white", line: "1.d4 d5 2.Nf3 Nf6" },
      { kind: "new", repertoire_id: "rep-1", repertoire_name: "Caro-Kann: Advance", color: "black", line: "1.e4 c6 2.d4 d5 3.e5 Bf5 4.Nf3" },
    ] }, outlook: { now: 2, today: 3, week: 6, next: null } };
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
  const screenOf = (target) => target.evaluate(() => document.getElementById("view-train")?.dataset.trainScreen);

  async function openTrain(target) {
    await target.goto(base, { waitUntil: "domcontentloaded" });
    await target.waitForTimeout(1000);
    if (vp.width > 760) {
      // The rail is a 60px icon rail that expands on hover (overlay). Mousemove,
      // pause for the 60ms+transition, then click while the label is still up.
      await target.mouse.move(30, 300);
      await target.waitForTimeout(400);
      const row = await target.locator('[data-testid="nav-train"]').boundingBox();
      await target.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
      await target.waitForTimeout(120);
      await target.mouse.down();
      await target.mouse.up();
    } else {
      await target.evaluate(() => document.querySelector('[data-testid="bottom-train"]').click());
    }
    await target.waitForTimeout(800);
  }

  // Empty queue: Due's Start becomes the fix, History stays reachable, and a
  // scope with nothing scheduled shows no outlook at all.
  const emptyPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  try {
    await emptyPage.route("**/api/train/smart/summary**", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ next_session: { cards: 0, weak: 0, due: 0, new: 0, polish: 0, resumed: 0, left: 0 }, outlook: { now: 0, today: 0, week: 0, next: null } }),
    }));
    await openTrain(emptyPage);
    await emptyPage.waitForFunction(() => document.getElementById("start-train")?.dataset.action === "build", null, { timeout: 2500 }).catch(() => {});
    const empty = await emptyPage.evaluate(() => ({
      screen: document.getElementById("view-train").dataset.trainScreen,
      start: document.getElementById("start-train").textContent.trim(),
      meta: document.getElementById("train-due-meta").textContent.trim(),
      outlookHidden: document.getElementById("train-outlook").hidden,
      history: (() => { const el = document.getElementById("train-history-open"); return !!el && el.getClientRects().length > 0; })(),
    }));
    check(empty.screen === "home", `Train opens on Home, got ${empty.screen}`);
    check(empty.start === "Open Repertoire", `an empty queue offers its fix, got ${JSON.stringify(empty.start)}`);
    check(empty.meta === "Nothing due", `an empty queue says so once, got ${JSON.stringify(empty.meta)}`);
    check(empty.outlookHidden, "nothing scheduled shows no outlook");
    check(empty.history, "History stays reachable with nothing to train");
  } finally {
    await emptyPage.close();
  }

  // Nothing due, but reviews scheduled: one quiet line, not three zeros.
  const quietPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  try {
    await quietPage.route("**/api/train/smart/summary**", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ next_session: { cards: 1, weak: 0, due: 0, new: 1, polish: 0, resumed: 0, left: 1 }, outlook: { now: 0, today: 0, week: 0, next: new Date(Date.now() + 3 * 86400000).toISOString() } }),
    }));
    await openTrain(quietPage);
    await quietPage.waitForFunction(() => !document.getElementById("train-outlook").hidden, null, { timeout: 2500 }).catch(() => {});
    const quiet = await quietPage.evaluate(() => ({
      cells: document.querySelectorAll("#train-outlook .train-outlook-lead, #train-outlook .train-outlook-rest").length,
      text: document.getElementById("train-outlook").textContent.trim(),
    }));
    check(quiet.cells === 0 && /^Nothing due · next in 3 days$/.test(quiet.text), `nothing due is one quiet line, got ${JSON.stringify(quiet)}`);
  } finally {
    await quietPage.close();
  }

  await openTrain(page);
  await page.waitForFunction(() => !document.getElementById("train-outlook").hidden, null, { timeout: 2500 }).catch(() => {});
  const shot = async (state) => {
    if (process.env.UI_V2_SHOTS) {
      await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `train-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
    }
  };
  const home = await page.evaluate(() => {
    const box = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect().toJSON() : null);
    const bar = box(document.querySelector("#view-train .board-bar"));
    return {
      screen: document.getElementById("view-train").dataset.trainScreen,
      homeHidden: document.getElementById("train-home").hidden,
      cells: [...document.querySelectorAll("#train-outlook .train-outlook-lead, #train-outlook .train-outlook-rest")].map((c) => c.textContent.trim()),
      meta: document.getElementById("train-due-meta").textContent.trim(),
      starts: ["start-train", "start-rehearse", "start-play"].map((id) => ({ id, text: document.getElementById(id).textContent.trim(), box: box(document.getElementById(id)) })),
      rehearseScope: document.querySelector("#train-rehearse-scope span").textContent.trim(),
      hint: !!box(document.getElementById("train-hint")),
      back: !!box(document.getElementById("train-back")),
      bar, vh: innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollHeight - innerHeight,
    };
  });
  check(home.screen === "home" && !home.homeHidden, `Train opens on Home, got ${home.screen}`);
  check(home.cells.length === 2 && home.cells[0] === "2 due now", `the outlook leads with what is due now, got ${JSON.stringify(home.cells)}`);
  check(home.meta === "4 cards", `the row's line is the session's size, got ${JSON.stringify(home.meta)}`);
  check(home.rehearseScope === "Caro-Kann: Advance", `Rehearse names its repertoire, got ${JSON.stringify(home.rehearseScope)}`);
  check(!home.hint, "Hint exists only in a drill");
  check(!home.back, "Home has no Back");
  for (const start of home.starts) {
    const limit = home.bar && vp.width <= 760 ? Math.min(home.bar.top, home.vh) : home.vh;
    check(!!start.box && start.box.bottom <= limit + 1, `${start.id} must be on screen: ${JSON.stringify({ box: start.box, bar: home.bar, vh: home.vh })}`);
    check(!!start.box && start.box.height >= (vp.width <= 760 ? 40 : 28), `${start.id} must be a real target, got ${start.box?.height}`);
  }
  check(home.overflow <= 0, `no horizontal overflow on Home, got ${home.overflow}px`);
  await shot("home");

  // Practice: the opponent picker opens from its chip.
  await page.locator("#train-play-book").click();
  await page.waitForTimeout(250);
  const picker = await page.locator('[role="listbox"]:visible, .train-picker:visible').count();
  check(picker >= 1, "the opponent chip opens a picker");
  await shot("play-picker");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Session: the Due queue from the fixture, started from Home.
  const startBodies = [];
  const startPayload = (generation) => ({
    session_generation: generation, state_version: 1,
    session_id: "s1", mode: "smart", mixed: true, scope: "all", fresh: true, resumed: false,
    repertoire_id: "rep-1", repertoire_name: "All repertoires", color: "black",
    card_index: 0, total_cards: 4, requeue_gap: 3,
    card_kinds: [
      { key: "weak", label: "Weak spot", title: "Missed more than answered" },
      { key: "due", label: "Due review", title: "Spaced repetition says now" },
      { key: "new", label: "New move", title: "Shown once, then tested" },
      { key: "polish", label: "Polish", title: "Kept warm with an occasional rep" },
    ],
    counts: { weak: 1, due: 1, new: 1, polish: 1 },
    health: { trainable: 4, mastered: 0, weak: 1, due: 1, learning: 0, untrained: 2, mastery_pct: 0 },
    cards: CARDS,
  });
  await page.route("**/api/train/smart/start", (route) => {
    startBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(startPayload(`2026-10-21T07:0${startBodies.length}:00+00:00`)) });
  });
  await page.locator("#start-train").click();
  await page.waitForTimeout(1500);
  const session = await page.evaluate(() => ({
    screen: document.getElementById("view-train").dataset.trainScreen,
    panel: !document.getElementById("train-progress-panel").hidden,
    count: document.getElementById("train-line-label").textContent.trim(),
    upnext: document.querySelectorAll("#train-upnext:not([hidden]) .un-row").length,
    upnextText: document.getElementById("train-upnext").textContent,
    back: document.getElementById("train-back").getClientRects().length > 0,
    homeHidden: document.getElementById("train-home").hidden,
  }));
  check(session.screen === "session" && session.panel && session.homeHidden, `Start opens the Session, got ${JSON.stringify(session)}`);
  check(session.count === "1 / 4", `the counter reads 1 / 4, got ${JSON.stringify(session.count)}`);
  check(session.upnext === 3 && /London System/.test(session.upnextText), `up next shows the real queue, got ${session.upnext}`);
  check(session.back, "a Session offers Back");
  await shot("session");
  const startToasts = await page.locator(".notices .notice").allTextContents();
  check(!startToasts.some((t) => /Queue ready|Resumed queue/.test(t)), `starting a queue should not toast its size, got ${JSON.stringify(startToasts)}`);

  // Result: play the whole 4-card queue.
  for (const [from, to] of [["c7", "c6"], ["g1", "f3"], ["e7", "e6"], ["f1", "b5"]]) {
    for (const sq of [from, to]) {
      await page.evaluate((name) => document.querySelector(`#train-board .square[data-square="${name}"]`).click(), sq);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(2600);
  }
  check(await screenOf(page) === "result", "finishing the last card shows the Result");
  check(await page.locator("#train-recent").evaluate((el) => el.hidden), "Recent never lists the run on the card (a first run has none before it)");
  await shot("result");
  await checkTrainingHistory(page, check, shot);
  await page.locator("#train-summary-new").click();
  await page.waitForTimeout(600);
  const first = startBodies[0] || {};
  const restart = startBodies[startBodies.length - 1] || {};
  check(startBodies.length >= 2, `Again should post a start, got ${JSON.stringify(startBodies)}`);
  check(restart.mixed === first.mixed && restart.repertoire_id === first.repertoire_id,
    `Again keeps the finished queue's scope, got ${JSON.stringify({ first, restart })}`);
  check(await screenOf(page) === "session", "Again opens the next Session");
  await page.locator("#train-back").click();
  await page.waitForTimeout(500);
  check(await screenOf(page) === "home", "Back returns Home");
  check(await page.locator("#train-summary").evaluate((el) => el.hidden), "Home clears the Result");
  const homeAgain = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  check(homeAgain <= 0 || vp.width <= 760, `Home must not scroll the page, got ${homeAgain}px over`);

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
console.log("[train-smoke] ok — every viewport renders Train Home, a live Session and its Result from fixture state, with every Start on screen, no overflow and no console errors.");
