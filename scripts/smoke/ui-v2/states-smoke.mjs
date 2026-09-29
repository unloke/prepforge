// UI v2 state smoke — the non-happy-path states the per-view viewport smokes
// don't reach (signed out, load failures, lazy-chunk hygiene, mobile account
// focus). Serves the built static/ tree; every /api/* call is answered per
// scenario through page.route, so each scenario controls its own session.
//
//   1. signed-out Library: onboarding card, empty layout, no owner-scoped API
//   2. signed-out Train / Settings: no authenticated API call, no error status
//   3. Library error: /api/dashboard and /api/repertoires failures each render
//      the same error card in the empty layout; the status stays an error
//      (never overwritten by "Ready"); Retry recovers to the real table
//   4. a window resize outside Analyze never loads the Analyze chunk / CSS
//   5. mobile More → account: focus moves into the menu, Escape returns it to
//      #sheet-account (aria-haspopup / aria-expanded), next Escape closes the
//      sheet back to the More button
//   6. empty account → "Link Lichess" lands on Settings → Connections
//
// Tracked UI-v2 smoke: part of `npm run smoke:ui-v2`
// (scripts/smoke/ui-v2/run-all.mjs). Requires `npm run build` first.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.STATES_SMOKE_PORT || 8801);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204); res.end(); return;
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
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* next */ }
}
if (!browser) { console.error("[states-smoke] no chromium-based browser available"); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (scenario, ok, label) => { if (!ok) failures.push(`${scenario}: ${label}`); };

// Endpoints a guest session may call. Anything else while signed out is an
// owner-scoped call that would 401 on the real backend.
const PUBLIC_API = [/^\/api\/auth\//, /^\/api\/csrf/, /^\/api\/health/, /^\/api\/engine/, /^\/api\/lichess\/explorer/, /^\/api\/opening/];

const SIGNED_IN = { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
const DASHBOARD = {
  games: 0, repertoires: 1, training_sessions: 0, open_mistakes: 0,
  due_reviews: 2, due_soon: 0,
  streak: { current: 1, best: 2, trained_today: false },
  recap: {}, recommendations: [],
};
const EMPTY_DASHBOARD = { ...DASHBOARD, repertoires: 0, due_reviews: 0 };
const REPS = {
  repertoires: [{
    id: "rep-1", name: "Caro-Kann: Advance", color: "black",
    root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    notes: "", tags: [], is_active: true, team_id: null, visibility: "private",
    health: { trainable: 10, mastered: 5, weak: 1, due: 2, learning: 1, untrained: 1, mastery_pct: 50, shallow_lines: 0 },
  }],
  shared: [],
};

// handler(path) -> { status, body } | body
async function openPage({ width = 1440, height = 900, handler }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const apiCalls = [];
  const assetCalls = [];
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname.includes("/assets/")) assetCalls.push(u.pathname);
  });
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    apiCalls.push(u.pathname);
    let out = handler(u.pathname, route.request());
    if (!out || !("status" in out && "body" in out)) out = { status: 200, body: out ?? {} };
    await route.fulfill({
      status: out.status,
      contentType: "application/json",
      body: JSON.stringify(out.body),
    });
  });
  return { page, apiCalls, assetCalls, errors };
}

const guestHandler = (path) => {
  if (path.startsWith("/api/auth/me")) return {};
  if (path.startsWith("/api/auth/providers")) return { google: false, password: true };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (PUBLIC_API.some((re) => re.test(path))) return {};
  return { status: 401, body: { detail: "Not authenticated" } };
};

const ownerCalls = (calls) => calls.filter((p) => !PUBLIC_API.some((re) => re.test(p)));

// Short-timeout, non-throwing locator reads so one missing element reports a
// failure instead of aborting the whole run.
const T = { timeout: 2000 };
const attr = (loc, name) => loc.getAttribute(name, T).catch(() => null);
const text = async (loc) => (await loc.textContent(T).catch(() => null)) || "";
const tap = (loc) => loc.click(T).then(() => true, () => false);

async function statusOf(page) {
  return page.evaluate(() => {
    const el = document.getElementById("app-status");
    return { text: (el?.textContent || "").trim(), severity: el?.dataset.severity || "" };
  });
}

async function clickTab(page, view) {
  await page.locator(`.tab[data-view="${view}"]`).first().click();
  await page.waitForTimeout(700);
}

// 1 + 2: signed out ---------------------------------------------------------
{
  const S = "signed-out";
  const { page, apiCalls, errors } = await openPage({ handler: guestHandler });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  check(S, (await page.locator('[data-testid="library-signed-out"]').count()) === 1, "Library should render the signed-out onboarding card");
  const libCls = await attr(page.locator("#view-dashboard .lib-list"), "class");
  check(S, /\bis-empty\b/.test(libCls || ""), "signed-out Library should use the is-empty layout");
  check(S, !(await page.locator("#lib-cols").isVisible()), "signed-out Library should hide the column header");
  check(S, !(await page.locator(".lib-list .card-head .seg").isVisible()), "signed-out Library should hide the filter chips");
  check(S, !(await page.locator(".lib-hint").isVisible()), "signed-out Library should hide the row hint");
  check(S, (await page.locator("#dashboard-steps:not([hidden]) .step").count()) === 3, "signed-out Get started card should list 3 steps");
  check(S, ownerCalls(apiCalls).length === 0, `signed-out Library made owner-scoped calls: ${ownerCalls(apiCalls).join(", ")}`);

  for (const view of ["train", "settings"]) {
    const before = apiCalls.length;
    await clickTab(page, view);
    const calls = ownerCalls(apiCalls.slice(before));
    check(S, calls.length === 0, `signed-out ${view} made owner-scoped calls: ${calls.join(", ")}`);
    const st = await statusOf(page);
    check(S, st.severity !== "error", `signed-out ${view} should not raise an error status, got "${st.text}"`);
  }
  check(S, errors.filter((t) => !/Failed to load resource/.test(t)).length === 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
}

// 3: Library error state ------------------------------------------------------
for (const failing of ["/api/dashboard", "/api/repertoires"]) {
  const S = `library-error ${failing}`;
  let down = true;
  const { page, apiCalls } = await openPage({
    handler: (path) => {
      if (path.startsWith("/api/auth/me")) return SIGNED_IN;
      if (path.startsWith("/api/auth/providers")) return { google: false };
      if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
      if (down && path.startsWith(failing)) return { status: 500, body: { detail: `${failing} exploded` } };
      if (path.startsWith("/api/dashboard")) return DASHBOARD;
      if (path.startsWith("/api/repertoires")) return REPS;
      if (path.startsWith("/api/teams")) return { teams: [] };
      if (path.startsWith("/api/lichess")) return { accounts: [] };
      return {};
    },
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const card = page.locator('#dashboard-repertoires [data-testid="library-error"]');
  check(S, (await card.count()) === 1, "error card should render");
  check(S, (await attr(card, "role")) === "alert", "error card should be role=alert");
  check(S, (await text(card)).includes("exploded"), "error card should carry the server message");
  const cls = await attr(page.locator("#view-dashboard .lib-list"), "class");
  check(S, /\bis-empty\b/.test(cls || "") && /\bis-error\b/.test(cls || ""), `lib-list should be is-empty + is-error, got "${cls}"`);
  for (const [sel, label] of [
    ["#lib-cols", "column header"],
    [".lib-list .card-head .seg", "filter chips"],
    [".lib-list .card-head .search-field", "search"],
    [".lib-hint", "row hint"],
    ["#lib-preview", "preview pane"],
    ["#dashboard-today", "Today strip"],
    ["#dashboard-steps", "steps card"],
    ["#dashboard-rep-count", "count badge"],
  ]) {
    check(S, !(await page.locator(sel).isVisible()), `${label} should be hidden`);
  }
  check(S, (await page.locator("#dashboard-repertoires .lib-row").count()) === 0, "no rows under the error card");
  const sub = await text(page.locator("#topbar-sub"));
  check(S, !/Welcome/.test(sub), `a failed load is not an empty library — subtitle should not welcome, got "${sub}"`);
  // Let any trailing status write land, then confirm the error was not replaced.
  await page.waitForTimeout(500);
  const st = await statusOf(page);
  check(S, st.severity === "error" && st.text.includes("exploded"), `status should stay the error, got [${st.severity}] "${st.text}"`);

  down = false;
  const before = apiCalls.length;
  await tap(card.locator('[data-lib-action="retry"]'));
  await page.waitForTimeout(800);
  check(S, apiCalls.slice(before).some((p) => p.startsWith("/api/dashboard")), "Retry should rerun the dashboard load");
  check(S, (await page.locator("#dashboard-repertoires .lib-row").count()) === 1, "Retry should recover to the real table");
  const cls2 = await attr(page.locator("#view-dashboard .lib-list"), "class");
  check(S, !/\bis-error\b/.test(cls2 || "") && !/\bis-empty\b/.test(cls2 || ""), `recovered lib-list should drop is-empty/is-error, got "${cls2}"`);
  check(S, await page.locator("#lib-cols").isVisible(), "recovered table should show the column header");
  check(S, (await text(page.locator("#lib-preview-name"))).includes("Caro-Kann"), "recovered preview should show the first repertoire");
  const st2 = await statusOf(page);
  check(S, st2.severity !== "error", `status should leave the error after recovery, got "${st2.text}"`);
  await page.close();
}

// 4: resize never pulls the Analyze chunk -------------------------------------
{
  const S = "resize";
  const { page, assetCalls } = await openPage({
    handler: (path) => {
      if (path.startsWith("/api/auth/me")) return SIGNED_IN;
      if (path.startsWith("/api/dashboard")) return DASHBOARD;
      if (path.startsWith("/api/repertoires")) return REPS;
      if (path.startsWith("/api/teams")) return { teams: [] };
      return {};
    },
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const isAnalyze = (p) => /\/assets\/analyze-[^/]+\.(js|css)$/.test(p);
  check(S, !assetCalls.some(isAnalyze), "Library boot should not load the Analyze chunk");
  for (const [w, h] of [[1180, 900], [900, 800], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
  }
  await clickTab(page, "train");
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.waitForTimeout(400);
  const loaded = assetCalls.filter(isAnalyze);
  check(S, loaded.length === 0, `resizing outside Analyze loaded ${loaded.join(", ")}`);
  await page.close();
}

// 5: mobile More → account menu focus -----------------------------------------
{
  const S = "mobile-account";
  const { page } = await openPage({
    width: 390, height: 844,
    handler: (path) => {
      if (path.startsWith("/api/auth/me")) return SIGNED_IN;
      if (path.startsWith("/api/dashboard")) return DASHBOARD;
      if (path.startsWith("/api/repertoires")) return REPS;
      if (path.startsWith("/api/teams")) return { teams: [] };
      if (path.startsWith("/api/lichess")) return { accounts: [] };
      return {};
    },
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const item = page.locator("#sheet-account");
  await tap(page.locator("#more-nav-btn"));
  await page.waitForTimeout(150);
  check(S, (await attr(item, "aria-haspopup")) === "menu", "signed-in #sheet-account should have aria-haspopup=menu");
  check(S, (await attr(item, "aria-expanded")) === "false", "#sheet-account should start aria-expanded=false");
  await tap(item);
  await page.waitForTimeout(150);
  check(S, await page.locator("#account-menu").isVisible(), "account menu should open");
  check(S, (await attr(item, "aria-expanded")) === "true", "#sheet-account should be aria-expanded=true while open");
  const focusedInMenu = await page.evaluate(() => !!document.activeElement?.closest("#account-menu"));
  check(S, focusedInMenu, "focus should move into the account menu");
  // The menu must be the topmost layer (above the sheet scrim).
  const onTop = await page.evaluate(() => {
    const btn = document.querySelector('#account-menu [role="menuitem"]');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    return btn.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  check(S, onTop, "account menu should render above the More sheet");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(S, !(await page.locator("#account-menu").isVisible()), "Escape should close the account menu");
  check(S, await page.locator("#more-sheet").isVisible(), "the first Escape should leave the More sheet open");
  check(S, await page.evaluate(() => document.activeElement?.id === "sheet-account"), "focus should return to #sheet-account");
  check(S, (await attr(item, "aria-expanded")) === "false", "#sheet-account should be aria-expanded=false after close");

  // Toggling closed by the trigger also restores focus to it.
  await tap(item);
  await page.waitForTimeout(100);
  await tap(item);
  await page.waitForTimeout(100);
  check(S, !(await page.locator("#account-menu").isVisible()), "second trigger click should close the menu");
  check(S, await page.evaluate(() => document.activeElement?.id === "sheet-account"), "toggle-close should keep focus on #sheet-account");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(S, !(await page.locator("#more-sheet").isVisible()), "the next Escape should close the More sheet");
  check(S, await page.evaluate(() => document.activeElement?.id === "more-nav-btn"), "focus should return to the More button");

  // A menu action closes both layers.
  await tap(page.locator("#more-nav-btn"));
  await page.waitForTimeout(100);
  await tap(item);
  await page.waitForTimeout(100);
  await tap(page.locator('#account-menu [data-action="settings"]'));
  await page.waitForTimeout(400);
  check(S, !(await page.locator("#more-sheet").isVisible()), "a menu action should close the More sheet");
  check(S, !(await page.locator("#account-menu").isVisible()), "a menu action should close the account menu");
  await page.close();
}

// 6: Link Lichess lands on Settings → Connections -----------------------------
{
  const S = "link-lichess";
  const { page } = await openPage({
    handler: (path) => {
      if (path.startsWith("/api/auth/me")) return SIGNED_IN;
      if (path.startsWith("/api/dashboard")) return EMPTY_DASHBOARD;
      if (path.startsWith("/api/repertoires")) return { repertoires: [], shared: [] };
      if (path.startsWith("/api/teams")) return { teams: [] };
      if (path.startsWith("/api/lichess")) return { accounts: [] };
      return {};
    },
  });
  // Slow both readiness inputs well past the old fixed 300ms — the Settings
  // chunk (section nav binds on load) and the settings fetch Settings entry
  // triggers (boot's own fetch passes) — so only a real readiness wait lands
  // on Connections.
  await page.route(/\/assets\/settings-[^/]+\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  let settingsHits = 0;
  await page.route("**/api/settings", async (route) => {
    settingsHits += 1;
    if (settingsHits > 1) await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const link = page.locator('#dashboard-steps [data-lib-action="lichess"]');
  check(S, (await link.count()) === 1, "empty account should offer Link Lichess");
  await tap(link);
  await page.waitForTimeout(3500);
  check(S, await page.locator("#view-settings").isVisible(), "Settings view should be active");
  const active = await attr(page.locator(".settings-nav-link.is-active"), "href");
  check(S, active === "#set-connections", `Connections should be the active section, got ${active}`);
  const inView = await page.evaluate(() => {
    const el = document.getElementById("set-connections");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check(S, inView, "Connections section should be scrolled into view");
  await page.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("[states-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[states-smoke] ok — signed-out, Library error, resize, mobile account focus and Link Lichess states hold.");
