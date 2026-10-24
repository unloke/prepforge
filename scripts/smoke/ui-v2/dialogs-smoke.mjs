// UI v2 dialogs smoke — every overlay is a native <dialog> or popover, and the
// keyboard treats it as one. For each one, at 1440x900, 1000x528 and a 390x844
// phone:
//
//   - it opens as the one modal on the page (menus and the sign-in gate are
//     popovers) with an accessible name and focus inside it
//   - Tab and Shift+Tab cycle inside it; focus never reaches the page behind
//   - Escape closes it and focus returns to the control that opened it
//   - no hand-rolled overlay element (.modal-overlay, .sheet-scrim) is left
//   - on a phone a dialog rises from the bottom edge, full width (the More
//     sheet floats 8px in)
//
// Covers: command palette, More sheet (phone), repertoire ⋯ menu, Share,
// account menu → Sign out confirm, Build's Generate, Training history, Settings
// Change password, the first-run welcome and the sign-in gate.
//
// Serves the built static/ tree; every /api/* call is answered from fixtures
// through page.route (shapes copied from a local SQLite server). Tracked UI-v2
// smoke: part of `npm run smoke:ui-v2`. Requires `npm run build` first.
// UI_V2_SHOTS=<dir> saves a screenshot of every overlay.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.DIALOGS_SMOKE_PORT || 8813);
const SHOTS = process.env.UI_V2_SHOTS || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Cross-origin isolated like production: Build's Generate runs the browser
// engine and stays gated without it. Unknown paths are SPA routes: they get
// index.html, like the real server.
const ISOLATED = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  try {
    const file = await readFile(join(STATIC_DIR, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream", ...ISOLATED });
    res.end(file);
  } catch {
    if (extname(path)) { res.writeHead(404); res.end("nope"); return; }
    res.writeHead(200, { "Content-Type": MIME[".html"], ...ISOLATED });
    res.end(await readFile(join(STATIC_DIR, "index.html")));
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
if (!browser) { console.error("[dialogs-smoke] no chromium-based browser available"); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (scenario, ok, label) => { if (!ok) failures.push(`${scenario}: ${label}`); };

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const REP_ID = "rep-1";
const ROOT_NODE = "node-root";
const HEALTH = { trainable: 0, mastered: 0, weak: 0, due: 0, learning: 0, untrained: 0, mastery_pct: 0, shallow_lines: 0 };
const ME = { id: "u1", email: "dialogs@x.test", plan: "free", display_name: null, has_password: true };
const FIXTURES = {
  "/api/auth/me": ME,
  "/api/auth/providers": { google: false, password: true },
  "/api/csrf": { csrf_token: "x" },
  "/api/settings": { stockfish_depth: 16, stockfish_depth_range: { min: 1, max: 30, default: 16 }, maia_rating: null, maia_rating_range: { min: 600, max: 2600 }, compute: "browser" },
  "/api/billing/status": { plan: "free", billing_enabled: false, price_configured: false },
  "/api/teams": { teams: [{ id: "team-1", name: "Club", role: "owner", member_count: 1 }] },
  "/api/lichess": { linked: false, username: null, accounts: [] },
  "/api/dashboard": {
    games: 0, repertoires: 1, training_sessions: 0, due_reviews: 0, due_soon: 0,
    streak: { current: 0, best: 0, trained_today: false },
    recap: { week_start: "2026-10-19", moves_reviewed_7d: 0, mastered_now: 0, mastered_delta: 0, weak_now: 0, weak_delta: 0 },
  },
  "/api/repertoires": { repertoires: [{ id: REP_ID, name: "Italian", color: "white", health: HEALTH, is_active: true, shared: false }], shared: [] },
  "/api/repertoires/access": { repertoire_id: REP_ID, link: { share_enabled: false, share_rev: 0, share_expires_at: null, share_role: "view" }, grants: [] },
  "/api/build/load": {
    repertoire_id: REP_ID, name: "Italian", color: "white", selected_node_id: ROOT_NODE, selected_fen: START_FEN,
    summary: { added_nodes: 0, updated_nodes: 0, high_probability_unprepared: 0 }, nodes_total: 1, revision: 1,
    health: { ...HEALTH, revision: 1 }, role: "owner", writable: true,
    nodes: [{
      id: ROOT_NODE, parent_id: null, depth: 0, san: "root", uci: null, fen: START_FEN, fen_before: null, fen_after: START_FEN,
      move_number: 1, ply: 0, move_side: null, side_to_move: "white", source: "manual", is_mainline: true, is_prepared: false,
      is_enabled: true, maia_probability: null, engine_evaluation: null, tags: [], comment: null, arrows: [], circles: [], mastery: null,
    }],
  },
  "/api/build/changes": { revision: 1, role: "owner" },
  "/api/train/smart/summary": { health: HEALTH, due_tomorrow: 0, day_streak: { current: 0, best: 0, trained_today: false } },
};

const signedIn = (path) => FIXTURES[path] ?? {};
const guest = (path) => {
  if (path === "/api/auth/me") return { status: 401, body: { detail: "not authenticated" } };
  if (path === "/api/auth/providers" || path === "/api/csrf") return FIXTURES[path];
  if (/^\/api\/(engine|lichess\/explorer|opening|health)/.test(path)) return {};
  return { status: 401, body: { detail: "not authenticated" } };
};

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "short-1000", width: 1000, height: 528 },
  { name: "phone-390", width: 390, height: 844, mobile: true },
];

async function openPage(vp, { handler, welcome = false }) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    ...(vp.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  // Nothing leaves the fixture origin (the Lichess explorer, fonts, CDNs).
  await ctx.route((u) => !String(u).startsWith(base), (route) => route.abort());
  await ctx.route("**/api/**", async (route) => {
    let out = await handler(new URL(route.request().url()).pathname);
    if (!out || !("status" in out && "body" in out)) out = { status: 200, body: out ?? {} };
    await route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
  });
  await ctx.addInitScript((welcome) => {
    localStorage.setItem("prepforge.engine-profile", JSON.stringify({ profile: { net: "lite", workers: 2, source: "user" }, consent: "no" }));
    // The welcome stays out of automated sessions; this one asks for it.
    if (welcome) Object.defineProperty(navigator, "webdriver", { get: () => false });
    else localStorage.setItem("prepforge.welcome", "done");
  }, welcome);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

// The top overlay: what is open, where focus is, its name, any legacy scrim.
const probe = (page) => page.evaluate(() => {
  const modals = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
  const pops = [...document.querySelectorAll(":popover-open")];
  const top = modals.at(-1) || pops.at(-1) || null;
  const a = document.activeElement;
  const labelledby = top?.getAttribute("aria-labelledby");
  const r = top?.getBoundingClientRect();
  return {
    modals: modals.length,
    top: top ? (top.id || top.className) : null,
    dialog: !!top?.matches("dialog.modal"),
    sheet: !!top?.matches("dialog.modal:not(.sheet)"),
    rect: r ? { left: r.left, right: r.right, bottom: r.bottom } : null,
    label: top?.getAttribute("aria-label") || (labelledby && document.getElementById(labelledby)?.textContent.trim()) || "",
    focusInTop: !!(top && a && top.contains(a)),
    active: !a || a === document.body ? "BODY" : (a.id || a.getAttribute("data-testid") || a.getAttribute("aria-label") || a.textContent.trim().slice(0, 24) || a.tagName),
    legacy: document.querySelectorAll(".modal-overlay, .sheet-scrim").length,
  };
});
const nameOf = (loc) => loc.evaluate((e) => e.id || e.getAttribute("data-testid") || e.getAttribute("aria-label") || e.textContent.trim().slice(0, 24));

async function overlay(vp, page, name, { opener = null, open, modal = true, tabs = 10 }) {
  const S = `${vp.name} ${name}`;
  let openerName = null;
  if (opener) {
    const el = page.locator(opener).first();
    await el.focus();
    openerName = await nameOf(el);
  }
  await open();
  await page.waitForTimeout(450);
  const p0 = await probe(page);
  if (!p0.top) { check(S, false, "nothing opened"); return; }
  check(S, p0.modals === (modal ? 1 : 0), `expected ${modal ? "one modal dialog" : "a popover"}, saw ${p0.modals} modal(s)`);
  check(S, !!p0.label, "no accessible name");
  check(S, !p0.legacy, "a hand-rolled overlay element is on the page");
  check(S, p0.focusInTop, `focus starts outside the overlay (${p0.active})`);
  // On a phone every dialog rises from the bottom edge and spans the width;
  // the More sheet floats 8px in on each side.
  if (vp.mobile && p0.dialog) {
    check(S, p0.rect.bottom >= vp.height - 16, `a phone dialog sits on the bottom edge: ${JSON.stringify(p0.rect)}`);
    const inset = p0.sheet ? 0 : 8;
    check(S, Math.abs(p0.rect.left - inset) <= 0.5 && Math.abs(vp.width - p0.rect.right - inset) <= 0.5,
      `a phone dialog spans the width${inset ? ` less ${inset}px a side` : ""}: ${JSON.stringify(p0.rect)}`);
  }
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `dialogs-${name}-${vp.name}.png`) });
  // Past the last control Chromium hands focus to its own UI (BODY here) once,
  // then back to the first control: the native modal cycle. The page behind
  // never gets it.
  for (const key of tabs ? ["Tab", "Shift+Tab"] : []) {
    for (let i = 0; i < tabs; i++) {
      await page.keyboard.press(key);
      const p = await probe(page);
      if (!p.top) { check(S, false, `${key} #${i + 1} closed the overlay`); break; }
      if (p.active !== "BODY" && !p.focusInTop) { check(S, false, `${key} #${i + 1} reached the page (${p.active})`); break; }
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  const p1 = await probe(page);
  check(S, p1.top !== p0.top, "Escape did not close it");
  if (openerName) check(S, p1.active === openerName, `focus returned to ${p1.active}, not ${openerName}`);
}

async function viaMore(page, item) {
  await page.click("#more-nav-btn");
  await page.waitForTimeout(400);
  await page.click(item);
}

for (const vp of VIEWPORTS) {
  const { ctx, page, errors } = await openPage(vp, { handler: signedIn });
  const go = async (hash) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(1500);
  };
  await go("#/dashboard");
  const repMenu = "#dashboard-repertoires [data-row-menu]";
  if (vp.mobile) {
    await overlay(vp, page, "more-sheet", { opener: "#more-nav-btn", open: () => page.keyboard.press("Enter") });
    await overlay(vp, page, "palette", { open: () => viaMore(page, "#sheet-palette") });
  } else {
    await overlay(vp, page, "palette", { opener: "#open-palette", open: () => page.keyboard.press("Enter") });
  }
  await overlay(vp, page, "rep-menu", { opener: repMenu, modal: false, tabs: 0, open: () => page.keyboard.press("Enter") });
  await overlay(vp, page, "share", { opener: repMenu, open: async () => {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.locator('#repertoire-context-menu [data-action="share"]').click();
    await page.waitForTimeout(800);
  } });
  await overlay(vp, page, "confirm-signout", { opener: vp.mobile ? null : "#account-chip", open: async () => {
    if (vp.mobile) await viaMore(page, "#sheet-account");
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `dialogs-account-menu-${vp.name}.png`) });
    await page.locator('#account-menu [data-action="signout"]').click();
  } });

  await page.goto(`${base}/#/build?rep=${REP_ID}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Generate opens from the ⋯ menu; the dialog hands focus back to the menu button.
  const menu = page.locator('[data-testid="build-menu"]');
  if (await menu.isVisible().catch(() => false)) {
    await overlay(vp, page, "generate", { opener: '[data-testid="build-menu"]', open: async () => {
      await page.keyboard.press("Enter");
      await page.locator('#repertoire-context-menu [data-action="build-generate"]').click();
    } });
  } else check(`${vp.name} generate`, false, "Build's menu button is not visible");

  await go("#/train");
  const history = page.locator("[data-train-history]:visible").first();
  if (await history.count()) {
    await history.evaluate((e) => e.setAttribute("data-smoke-opener", ""));
    await overlay(vp, page, "history", { opener: "[data-smoke-opener]", open: () => page.keyboard.press("Enter") });
  } else check(`${vp.name} history`, false, "no visible Training history button");

  await go("#/settings");
  if (await page.locator('[data-acct="password"]:visible').count()) {
    await overlay(vp, page, "password", { opener: '[data-acct="password"]:visible', open: () => page.keyboard.press("Enter") });
  } else check(`${vp.name} password`, false, "no visible Change password button");
  check(`${vp.name} signed in`, errors.length === 0, `page errors: ${errors.join(" | ")}`);
  await ctx.close();

  // Guest: the first-run welcome (modal), then the sign-in gate (a manual
  // popover, so the tabs stay clickable through its dim).
  const g = await openPage(vp, { handler: guest, welcome: true });
  if ((await probe(g.page)).top) await overlay(vp, g.page, "welcome", { open: async () => {} });
  else check(`${vp.name} welcome`, false, "the welcome did not open");
  await overlay(vp, g.page, "sign-in", { opener: vp.mobile ? null : "#account-chip", modal: false, tabs: 0, open: async () => {
    if (vp.mobile) await viaMore(g.page, "#sheet-account");
    else await g.page.keyboard.press("Enter");
  } });
  check(`${vp.name} guest`, g.errors.length === 0, `page errors: ${g.errors.join(" | ")}`);
  await g.ctx.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("[dialogs-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[dialogs-smoke] ok — every dialog and menu opens native, keeps Tab inside, closes on Escape and hands focus back, at 1440, 1000x528 and a phone.");
