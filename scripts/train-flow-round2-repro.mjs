// Real-backend reproduction for the two Train workflow fixes (round 2):
//
//  1. Finish -> "New session" must keep the queue's repertoire scope. The live
//     queue is released before its summary paints, so the restart used to widen a
//     single-repertoire queue to a MIXED queue over every active repertoire.
//  2. Line rehearsal: a failed POST /api/train/move must leave the SAME card
//     answerable. It used to leave the optimistic move on a locked board under a
//     "Your move" banner.
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

  // ---- 2. Line rehearsal: a failed answer stays answerable ------------------
  await toSetup();
  await page.click('#train-modes .train-mode[data-mode="all_lines"]');
  await page.waitForTimeout(1200);
  await page.selectOption("#train-repertoire-select", whiteId);
  await page.waitForTimeout(1200);
  await page.click("#start-train");
  await page.waitForTimeout(3500);
  const uci = await expectedUci();
  check(!!uci, "the rehearsal card names a prepared move", await snapshot());
  let failOnce = true;
  await page.route("**/api/train/move", async (route) => {
    if (failOnce) { failOnce = false; await route.abort("failed"); return; }
    await route.continue();
  });
  await play(uci);
  await page.waitForTimeout(2200);
  const afterFailure = await snapshot();
  check(/didn't save/.test(afterFailure.sub || "") && afterFailure.banner === "move",
    "a failed answer says it did not save", afterFailure);
  check(afterFailure.pieces[uci.slice(0, 2)] && !afterFailure.pieces[uci.slice(2, 4)],
    "a failed answer puts the piece back on its square", afterFailure.pieces);
  check(afterFailure.hint === false && afterFailure.skip === false,
    "a failed answer leaves hint/skip usable", afterFailure);
  await play(uci);
  await page.waitForTimeout(2600);
  const afterRetry = await snapshot();
  check(afterRetry.banner === "done" || afterRetry.sub !== afterFailure.sub,
    "the same card accepts the answer on retry", afterRetry);
  check(pageErrors.length === 0, "no page errors", pageErrors);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n[train-flow-repro] FAIL (${failures.length}): ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\n[train-flow-repro] ok — restart keeps the queue's repertoire, and a failed rehearsal answer is recoverable.");
