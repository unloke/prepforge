// Real-backend reproduction for the two Train workflow fixes (round 2):
//
//  1. Finish -> "New session" must keep the queue's repertoire scope. The live
//     queue is released before its summary paints, so the restart used to widen a
//     single-repertoire queue to a MIXED queue over every active repertoire.
//  2. Line rehearsal: a failed POST /api/train/move must leave the SAME card
//     answerable when the server rejected it, and must NOT re-ask the old card
//     when the response was lost after the server committed the grade. Replaying
//     an old answer would grade the NEXT card wrong (a false miss + permanent
//     desync), so the client reconciles with GET /api/train/session/{id} and
//     adopts the server's current prompt.
//
// Runs against a real API server serving the built app (no Lichess, no fixtures):
//
//   npm run build
//   DATABASE_URL="sqlite:///data/prepforge_api.sqlite3" py -m alembic upgrade head
//   DATABASE_URL="sqlite:///data/prepforge_api.sqlite3" py -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=9795)"
//   BASE_URL=http://127.0.0.1:9795 node scripts/train-flow-round2-repro.mjs
//
// Registers a fresh account, builds two small prepared repertoires through the
// public API, then drives the real UI with clicks. Exits 1 on any failed check.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:9795";
const EMAIL = process.env.E2E_EMAIL || `train-flow-${Date.now()}@example.com`;
const PASSWORD = "longpassword1";
const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};

// ---- API setup: one fresh account, two prepared repertoires -------------------
const jar = { cookie: "", csrf: "" };
async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(jar.cookie ? { Cookie: jar.cookie } : {}),
      ...(jar.csrf ? { "X-CSRF-Token": jar.csrf } : {}),
      ...(options.headers || {}),
    },
  });
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (cookies.length) {
    const byName = new Map(jar.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c]));
    for (const line of cookies) {
      const [pair] = line.split(";");
      const [name, ...rest] = pair.split("=");
      byName.set(name, [name, ...rest].join("="));
    }
    jar.cookie = [...byName.values()].join("; ");
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

await api("/api/csrf");
jar.csrf = (jar.cookie.match(/pf_csrf=([^;]+)/) || [])[1];
const registered = await api("/api/auth/register", {
  method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (registered.status >= 300) {
  console.error(`register failed: ${registered.status} ${registered.text.slice(0, 200)}`);
  process.exit(2);
}

async function buildRepertoire(name, color, moves) {
  const created = await api("/api/repertoires/create", {
    method: "POST", body: JSON.stringify({ name, color }),
  });
  if (created.status >= 300) throw new Error(`create ${name}: ${created.text.slice(0, 200)}`);
  let parent = created.json.nodes.find((node) => !node.parent_id).id;
  for (const uci of moves) {
    const added = await api("/api/build/add-move", {
      method: "POST",
      body: JSON.stringify({ repertoire_id: created.json.repertoire_id, parent_node_id: parent, move_uci: uci }),
    });
    if (added.status >= 300) throw new Error(`add ${uci}: ${added.text.slice(0, 200)}`);
    parent = added.json.selected_node_id;
  }
  return created.json.repertoire_id;
}
// White: 1.e4 e5 2.Nf3. Black: 1.e4 c6 2.d4 d5 (a second active repertoire, so a
// widened queue would visibly change the session).
const whiteId = await buildRepertoire("Repro White", "white", ["e2e4", "e7e5", "g1f3"]);
await buildRepertoire("Repro Black", "black", ["e2e4", "c7c6", "d2d4", "d7d5"]);
// A second untouched white repertoire: the lost-response case needs a session
// whose cards and progress no earlier case has graded.
const white2Id = await buildRepertoire("Repro White 2", "white", ["e2e4", "e7e5", "g1f3"]);

// ---- Browser -----------------------------------------------------------------
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next channel */ }
}
if (!browser) { console.error("no Chromium browser available"); process.exit(2); }
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const csrf = await page.evaluate(async () => (await (await fetch("/api/csrf")).json()).csrf_token);
await page.evaluate(async ([email, password, token]) => {
  await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ email, password }),
  });
}, [EMAIL, PASSWORD, csrf]);

const starts = [];
page.on("request", (request) => {
  if (request.url().includes("/api/train/smart/start")) starts.push(request.postDataJSON());
});
const snapshot = () => page.evaluate(() => ({
  banner: document.getElementById("train-banner")?.dataset.state,
  title: document.getElementById("train-banner-title")?.textContent?.trim(),
  sub: document.getElementById("train-banner-sub")?.textContent?.trim(),
  line: document.getElementById("train-line-label")?.textContent?.trim(),
  summaryUp: document.getElementById("train-summary")?.offsetParent !== null,
  hint: document.getElementById("train-hint")?.disabled,
  skip: document.getElementById("train-skip")?.disabled,
  pieces: Object.fromEntries([...document.querySelectorAll("#train-board .square")]
    .filter((square) => square.dataset.piece)
    .map((square) => [square.dataset.square, square.dataset.piece])),
}));
const clickSquare = (name) => page.locator(`#train-board [data-square="${name}"]`).click();
const SAN_UCI = { e4: "e2e4", e5: "e7e5", Nf3: "g1f3", c6: "c7c6", d4: "d2d4", d5: "d7d5" };
// The move this card wants. A teach card names it in the banner; a review card
// is asked through the same Hint button the player uses (three taps = answer).
async function expectedUci() {
  const banner = await page.evaluate(() => ({
    state: document.getElementById("train-banner")?.dataset.state,
    title: document.getElementById("train-banner-title")?.textContent || "",
    sub: document.getElementById("train-banner-sub")?.textContent || "",
  }));
  let san = (/^New move: (.+)$/.exec(banner.title.trim()) || [])[1];
  if (!san) {
    for (let tap = 0; tap < 3; tap += 1) {
      const disabled = await page.evaluate(() => document.getElementById("train-hint")?.disabled);
      if (disabled) break;
      await page.click("#train-hint");
      await page.waitForTimeout(250);
    }
    san = (/^Play (.+)$/.exec((await page.evaluate(() => document.getElementById("train-banner-sub")?.textContent || "")).trim()) || [])[1];
  }
  return san ? SAN_UCI[san.trim()] : null;
}
const play = async (uci) => { await clickSquare(uci.slice(0, 2)); await clickSquare(uci.slice(2, 4)); };
const toSetup = async () => {
  const state = await page.evaluate(() => document.querySelector("#view-train .train-sidebar")?.dataset.sessionState);
  if (state !== "setup") { await page.click("#train-mode-name"); await page.waitForTimeout(800); }
};

try {
  // ---- 1. single-repertoire queue: finish, then New session ----------------
  await page.goto(`${BASE}/#/train?rep=${whiteId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  // The Train link starts the queue itself; answer whatever it asks (the hint
  // names the prepared move, so this does not hard-code the server's ordering).
  for (let card = 0; card < 8; card += 1) {
    if ((await snapshot()).summaryUp) break;
    const uci = await expectedUci();
    if (!uci) { check(false, "the card named a prepared move", await snapshot()); break; }
    await play(uci);
    await page.waitForTimeout(1800);
  }
  const finished = await snapshot();
  check(finished.summaryUp === true, "finishing every card shows the session results", finished);
  await page.click("#train-summary-new");
  await page.waitForTimeout(4000);
  const restart = starts[starts.length - 1] || {};
  check(restart.fresh === true && restart.mixed === false && restart.repertoire_id === whiteId,
    "New session keeps the finished queue's repertoire", { starts });

  // ---- 2. Line rehearsal: the server REJECTED the answer -------------------
  // A 4xx proves the transaction never committed, so the same card comes back
  // and no reconciliation read is needed.
  const sessionReads = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/train/session/")) sessionReads.push(request.url());
  });
  const startRehearsal = async (repertoireId = whiteId) => {
    await toSetup();
    await page.click('#train-modes .train-mode[data-mode="all_lines"]');
    await page.waitForTimeout(1200);
    await page.selectOption("#train-repertoire-select", repertoireId);
    await page.waitForTimeout(1200);
    await page.click("#start-train");
    await page.waitForTimeout(3500);
  };
  await startRehearsal();
  const uci = await expectedUci();
  check(!!uci, "the rehearsal card names a prepared move", await snapshot());
  let failOnce = true;
  await page.route("**/api/train/move", async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "training session has no current prompt" }) });
      return;
    }
    await route.continue();
  });
  await play(uci);
  await page.waitForTimeout(2200);
  const afterFailure = await snapshot();
  check(afterFailure.banner === "move" && /didn't save/.test(afterFailure.sub || "")
    && afterFailure.pieces[uci.slice(0, 2)] && !afterFailure.pieces[uci.slice(2, 4)],
    "a rejected answer puts the same card back", afterFailure);
  check(afterFailure.hint === false && afterFailure.skip === false,
    "a rejected answer leaves hint/skip usable", afterFailure);
  check(sessionReads.length === 0, "a rejected answer needs no reconciliation read", sessionReads);
  await play(uci);
  await page.waitForTimeout(2600);
  const afterRetry = await snapshot();
  check(afterRetry.pieces.e4 === "P" && afterRetry.pieces.e5 === "p" && afterRetry.pieces.e2 !== "P",
    "the same card accepts the answer on retry and advances", afterRetry.pieces);

  // ---- 3. Line rehearsal: the server committed, the RESPONSE was lost ------
  // route.fetch() sends the request and lets the server grade + advance; the
  // response is then dropped before the page sees it. The client must not ask
  // for e4 again: the server now expects Nf3.
  await page.unroute("**/api/train/move");
  await startRehearsal(white2Id);
  // No hint taps here: the answer must be a clean first attempt, otherwise the
  // grade itself would be a miss and hide the false-mistake check below.
  const fresh = await snapshot();
  check(fresh.pieces.e2 === "P" && fresh.pieces.e4 === undefined && fresh.pieces.g1 === "N",
    "the rehearsal starts on the 1.e4 card", fresh.pieces);
  const reads = sessionReads.length;
  const graded = [];
  let loseOnce = true;
  await page.route("**/api/train/move", async (route) => {
    if (!loseOnce) { await route.continue(); return; }
    loseOnce = false;
    const response = await route.fetch();
    graded.push(await response.json());
    await route.abort("failed"); // the response never reaches the page
  });
  await play("e2e4");
  await page.waitForTimeout(3000);
  const afterLost = await snapshot();
  check(graded.length === 1 && graded[0].correct === true,
    "the server graded the e4 answer before the response was lost", graded[0]);
  check(sessionReads.length > reads, "the client reconciled with the session read", sessionReads);
  // The server's next card is 2.Nf3 (1.e4 e5 on the board), not 1.e4 again.
  check(afterLost.pieces.e4 === "P" && afterLost.pieces.e5 === "p" && afterLost.pieces.g1 === "N",
    "the client adopted the server's advanced card (2.Nf3)", { afterLost: afterLost.pieces, graded: graded[0]?.prompt });
  check(afterLost.pieces.e2 !== "P",
    "the client did not put the old 1.e4 card back", afterLost.pieces);
  // Answering the card on screen must be a first attempt on Nf3: no false miss.
  const answered = [];
  await page.route("**/api/train/move", async (route) => {
    const response = await route.fetch();
    answered.push(await response.json());
    await route.fulfill({ response });
  });
  await play("g1f3");
  await page.waitForTimeout(2600);
  const final = await snapshot();
  check(answered.length === 1 && answered[0].correct === true,
    "the adopted card accepts its own answer", answered[0]);
  check(answered[0] && (answered[0].mistakes || []).length === 0,
    "recovery records no false mistake", answered[0]?.mistakes);
  check(answered[0] && answered[0].progress && answered[0].progress.attempts === 1
    && answered[0].progress.correct_attempts === 1,
    "the next card's progress has exactly one attempt", answered[0]?.progress);
  check(final.summaryUp === true || final.banner === "done",
    "the rehearsal finishes on the server's line", final);

  // ---- 4. Line rehearsal: the reconciliation read fails, then succeeds ------
  // The grade committed and its response was lost, but the follow-up read also
  // fails (offline). The board must stay locked behind a concrete Retry sync
  // action — never a dead "Your move" on the old card.
  await page.unroute("**/api/train/move");
  await startRehearsal(white2Id);
  let loseAgain = true;
  await page.route("**/api/train/move", async (route) => {
    if (!loseAgain) { await route.continue(); return; }
    loseAgain = false;
    await route.fetch();
    await route.abort("failed");
  });
  let failRead = true;
  await page.route("**/api/train/session/**", async (route) => {
    if (!failRead) { await route.continue(); return; }
    failRead = false;
    await route.abort("failed");
  });
  await play("e2e4");
  await page.waitForTimeout(2500);
  const offline = await snapshot();
  check(offline.banner === "done" && /confirm/.test(offline.title || ""),
    "a failed reconciliation says the answer is unconfirmed", offline);
  // The board is locked, not re-asked: no "Your move" over a card the server
  // may already have advanced past, and no second answer on the old position.
  check(offline.hint === true && offline.skip === true && offline.title !== "Your move",
    "a failed reconciliation locks the card instead of re-asking it", offline);
  const retrySync = page.locator(".notice-action", { hasText: "Retry sync" });
  check(await retrySync.count() === 1, "the failure offers a concrete Retry sync action");
  await retrySync.click();
  await page.waitForTimeout(2200);
  const recovered = await snapshot();
  check(recovered.pieces.e4 === "P" && recovered.pieces.e5 === "p" && recovered.pieces.e2 !== "P"
    && recovered.pieces.g1 === "N",
    "Retry sync adopts the server's advanced card (2.Nf3)", recovered.pieces);
  check(pageErrors.length === 0, "no page errors", pageErrors);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n[train-flow-repro] FAIL (${failures.length}): ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\n[train-flow-repro] ok — restart keeps the queue's repertoire, and a failed rehearsal answer is recoverable.");
