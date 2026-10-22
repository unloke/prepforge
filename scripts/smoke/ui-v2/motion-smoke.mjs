// Motion smoke: nothing on a page animates its entrance twice.
//
// Serves the built static/ tree with real-shape /api/* fixtures (answered after
// a short delay, the way a real backend lands after the view's cross-fade) and
// records every CSS `animationstart` and `Element.animate` per element while it
// walks Library, Build (Explorer + a new position), Train, Teams (directory,
// shared list, a team opened) and Settings at 1440x900 and 390x844, then a
// data refresh and a leave-and-return on each.
//
// An entrance is a keyframes rule whose first frame sets opacity below 1, read
// from the live stylesheets. Within one step the smoke fails on:
//   - the same node entering twice;
//   - the same place (path + sibling index) entering again from a re-render;
//   - an entrance stacked on its view's own cross-fade;
//   - any entrance on a refresh or on returning to a view (only the view's
//     cross-fade may play there).
// It also checks the Settings jump: the card lands under the sticky strip,
// the ring shows, and with reduced motion nothing travels.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.MOTION_SMOKE_PORT || 8812);
const DELAY = 250;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const node = (id, parent, depth, san, uci, fen, before, side, extra = {}) => ({
  id, parent_id: parent, depth, san, uci, fen, fen_before: before, fen_after: fen, move_number: Math.ceil(depth / 2), ply: depth,
  move_side: side, side_to_move: side === "white" ? "black" : "white", source: "manual", is_mainline: true, is_enabled: true,
  is_prepared: side === "black", mastery: null, maia_probability: null, arrows: [], circles: [], ...extra,
});
const F1 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const F2 = "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const F3 = "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2";
const BUILD_NODES = [
  { id: "n0", parent_id: null, depth: 0, san: null, uci: null, move_number: 1, ply: 0, move_side: "white", is_mainline: false, is_enabled: true, is_prepared: false, mastery: null, maia_probability: null },
  node("n1", "n0", 1, "e4", "e2e4", F1, START, "white"),
  node("n2", "n1", 2, "c6", "c7c6", F2, F1, "black", { mastery: "learning" }),
  node("n3", "n2", 3, "d4", "d2d4", F3, F2, "white"),
];
const HEALTH = { trainable: 10, mastered: 3, weak: 2, due: 4, learning: 1, untrained: 0, mastery_pct: 30, shallow_lines: 0 };
const REPS = {
  repertoires: [
    { id: "rep-1", name: "Caro-Kann: Advance", color: "black", root_fen: START, notes: "", tags: [], is_active: true, team_id: null, visibility: "private", health: HEALTH },
    { id: "rep-2", name: "London System", color: "white", root_fen: START, notes: "", tags: [], is_active: true, team_id: null, visibility: "private", health: { ...HEALTH, mastered: 6, mastery_pct: 60 } },
  ],
  shared: [{ id: "rep-8", name: "French Fort", color: "white", role: "view", team_id: "t1", owner_user_id: "u2" }],
};
const TEAM = {
  id: "t1", name: "Taipei Knights", role: "owner", member_count: 2,
  members: [
    { user_id: "u1", display_name: "Andrew", lichess_username: "tactician_aw", role: "owner" },
    { user_id: "u2", display_name: "Sam", lichess_username: "samqueen", role: "member" },
  ],
  shared_repertoires: [],
  invite: { exists: false },
};
const EXPLORER = {
  opening: { eco: "B12", name: "Caro-Kann Defense" },
  moves: [
    { uci: "d2d4", san: "d4", white: 6100, draws: 5600, black: 6540 },
    { uci: "b1c3", san: "Nc3", white: 1120, draws: 900, black: 1080 },
    { uci: "g1f3", san: "Nf3", white: 610, draws: 800, black: 700 },
  ],
};
const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/build/load")) return { repertoire_id: "rep-1", name: "Caro-Kann: Advance", color: "black", writable: true, selected_node_id: "n2", root_fen: START, nodes: BUILD_NODES };
  if (path.startsWith("/api/repertoires")) return REPS;
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 2, training_sessions: 0, open_mistakes: 0, due_reviews: 4, due_soon: 1, streak: { current: 3, best: 9, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess/explorer")) return EXPLORER;
  if (path.startsWith("/api/teams/t1")) return TEAM;
  if (path.startsWith("/api/teams")) return { teams: [TEAM] };
  if (path.startsWith("/api/train/smart/summary")) return { next_session: { cards: 4, weak: 1, due: 1, new: 1, polish: 1, resumed: 0 } };
  if (path.startsWith("/api/lichess")) return { accounts: [] };
  if (path.startsWith("/api/settings")) return {};
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url.pathname.startsWith("/api/")) {
    await new Promise((r) => setTimeout(r, DELAY));
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
    res.end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[motion-smoke] no chromium-based browser available"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

// Runs in the page before any app code.
function recorder() {
  const ids = new WeakMap();
  let n = 0;
  const uid = (el) => { if (!ids.has(el)) ids.set(el, ++n); return ids.get(el); };
  const one = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((c) => c && c !== "is-enter" && c !== "is-active") : [];
    const idx = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls.length ? `.${cls.slice(0, 2).join(".")}` : ""}:${idx}`;
  };
  const path = (el) => {
    const out = [];
    for (let e = el, k = 0; e?.tagName && k < 5; k += 1, e = e.parentElement) { out.unshift(one(e)); if (e.id) break; }
    return out.join(" > ");
  };
  let entrances = null;
  const isEntrance = (name) => {
    if (!entrances) {
      entrances = new Set();
      const walk = (rules) => { for (const r of rules) {
        if (r.type === 7) { const f = r.cssRules[0]; if (f && /^(from|0%)/.test(f.keyText) && f.style.opacity !== "" && Number(f.style.opacity) < 1) entrances.add(r.name); }
        else if (r.cssRules) walk(r.cssRules);
      } };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
    }
    return entrances.has(name);
  };
  window.__step = "boot";
  window.__anim = [];
  const ancestors = (el) => { const out = []; for (let a = el.parentElement; a; a = a.parentElement) out.push(uid(a)); return out; };
  document.addEventListener("animationstart", (e) => {
    const el = e.target;
    if (!isEntrance(e.animationName)) return;
    // The route cross-fade is a View Transition (view-swap.js): its animation
    // runs on a ::view-transition-* pseudo-element and covers the whole
    // workspace, not one .view.
    if (/^::view-transition/.test(e.pseudoElement || String(el.tagName || ""))) {
      window.__anim.push({ step: window.__step, t: performance.now(), name: e.animationName, uid: 0, path: `::view-transition (${e.animationName})`, anc: [], view: true, route: true });
      return;
    }
    if (!el.getClientRects().length) return;
    window.__anim.push({ step: window.__step, t: performance.now(), name: e.animationName, uid: uid(el), path: path(el), anc: ancestors(el), view: el.matches(".view"), inWorkspace: Boolean(el.closest(".workspace")) });
  }, true);
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const first = Array.isArray(frames) ? frames[0] : null;
    if (first && first.opacity !== undefined && Number(first.opacity) < 1) {
      window.__anim.push({ step: window.__step, t: performance.now(), name: "waapi-fade-in", uid: uid(this), path: path(this), anc: ancestors(this), view: false });
    }
    return animate.call(this, frames, options);
  };
}

function judge(vp, log) {
  const steps = new Map();
  for (const a of log) steps.set(a.step, [...(steps.get(a.step) || []), a]);
  for (const [step, list] of steps) {
    const fail = (msg) => failures.push(`${vp}: ${step}: ${msg}`);
    const byNode = new Map();
    const byPlace = new Map();
    for (const a of list) {
      byNode.set(a.uid, [...(byNode.get(a.uid) || []), a]);
      byPlace.set(a.path, [...(byPlace.get(a.path) || []), a]);
    }
    for (const [id, as] of byNode) if (id && as.length > 1) fail(`${as[0].path} entered ${as.length}x (${as.map((a) => a.name).join(", ")})`);
    for (const [place, as] of byPlace) if (new Set(as.map((a) => a.uid)).size > 1) fail(`${place} re-rendered and entered again`);
    const views = list.filter((a) => a.view);
    for (const a of list) {
      if (a.view) continue;
      const host = views.find((v) => (v.route ? a.inWorkspace : a.anc.includes(v.uid)) && a.t >= v.t - 1 && a.t - v.t < 200);
      if (host) fail(`${a.path} (${a.name}) stacked on its view's cross-fade`);
    }
    if (/:(refresh|return)$/.test(step)) for (const a of list) if (!a.view) fail(`${a.path} (${a.name}) entered on a ${step.split(":").pop()}`);
  }
}

async function run({ name, width, height, mobile }) {
  const context = await browser.newContext({
    viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" : undefined,
  });
  await context.addInitScript(recorder);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const step = (s) => page.evaluate((s) => { window.__step = s; }, s);
  const go = (hash) => page.evaluate((h) => { location.hash = h; }, hash);
  const settle = (ms = 1400) => page.waitForTimeout(ms);
  const refreshAndReturn = async (id, hash) => {
    await step(`${id}:refresh`);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("resize")); });
    await settle(900);
    await step(`${id}:away`);
    await go(hash === "#/settings" ? "#/dashboard" : "#/settings");
    await settle(900);
    await step(`${id}:return`);
    await go(hash);
    await settle();
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"]').waitFor({ timeout: 15000 });
  await settle();
  await refreshAndReturn("library", "#/dashboard");

  await step("build:enter");
  await go("#/build?rep=rep-1");
  // The phone keeps the Explorer behind its own tab; the desktop shows it.
  if (!mobile) await page.locator("#explorer-rows .explorer-row").first().waitFor({ timeout: 15000 }).catch(() => failures.push(`${name}: the Explorer never listed its rows`));
  else await page.locator("#builder-tree .mtree-move").first().waitFor({ timeout: 15000 }).catch(() => failures.push(`${name}: the tree never painted`));
  await settle();
  // A new position is one arrival: its rows enter once.
  await step("build:new-position");
  await page.locator('#builder-tree .mtree-move[data-node-id="n3"], #builder-tree [data-node-id="n3"]').first().click().catch(() => {});
  await settle();
  await refreshAndReturn("build", "#/build?rep=rep-1");

  await step("train:enter");
  await go("#/train");
  await settle();
  await refreshAndReturn("train", "#/train");

  await step("teams:enter");
  await go("#/teams");
  await page.locator('#teams-list .team-row[data-team-id="t1"]').waitFor({ timeout: 15000 }).catch(() => failures.push(`${name}: the team directory never listed its team`));
  await settle();
  await step("teams:open");
  await page.locator('#teams-list .team-row[data-team-id="t1"]').click();
  await page.locator("#team-members .mem-row:not(.is-skeleton)").first().waitFor({ timeout: 15000 }).catch(() => {});
  await settle();
  await refreshAndReturn("teams", "#/teams");

  await step("settings:enter");
  await go("#/settings");
  await settle();
  await refreshAndReturn("settings", "#/settings");

  // The Settings jump lands the card under the sticky strip and marks it.
  await step("settings:jump");
  const link = page.locator(".settings-nav .settings-nav-link", { hasText: "Board" });
  await link.click();
  await page.waitForFunction(() => document.querySelector("#set-board")?.classList.contains("is-landed"), null, { timeout: 3000 })
    .catch(() => failures.push(`${name}: the Board card never showed its landing ring`));
  const landing = await page.evaluate(() => {
    const nav = document.querySelector(".settings-nav").getBoundingClientRect();
    const card = document.querySelector("#set-board").getBoundingClientRect();
    const ring = getComputedStyle(document.querySelector("#set-board"), "::after");
    const room = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    return { navBottom: nav.bottom, cardTop: card.top, ring: ring.boxShadow, anim: ring.animationName, room, active: document.querySelector(".settings-nav-link.is-active")?.textContent };
  });
  if (landing.cardTop < landing.navBottom - 1) failures.push(`${name}: the Board card landed under the sticky strip (top ${Math.round(landing.cardTop)} < strip ${Math.round(landing.navBottom)})`);
  if (!/inset/.test(landing.ring)) failures.push(`${name}: the landing ring is missing (${landing.ring})`);
  if (landing.anim !== "set-land") failures.push(`${name}: the landing ring should fade (animation ${landing.anim})`);
  if (!/Board/.test(landing.active || "")) failures.push(`${name}: the strip should mark Board, got "${landing.active}"`);
  await page.waitForTimeout(1700);
  if (await page.locator("#set-board.is-landed").count()) failures.push(`${name}: the landing ring should clear itself`);

  judge(name, await page.evaluate(() => window.__anim));
  for (const e of errors) failures.push(`${name}: pageerror ${e}`);
  await context.close();

  // Reduced motion: the ring shows without fading; the view does not travel.
  const reduced = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
  const rp = await reduced.newPage();
  await rp.goto(`${base}/#/settings`, { waitUntil: "domcontentloaded" });
  await rp.locator(".settings-nav .settings-nav-link").first().waitFor({ timeout: 15000 });
  await rp.waitForTimeout(800);
  await rp.locator(".settings-nav .settings-nav-link", { hasText: "Board" }).click();
  await rp.waitForTimeout(150);
  const still = await rp.evaluate(() => {
    const ring = getComputedStyle(document.querySelector("#set-board"), "::after");
    return { landed: document.querySelector("#set-board").classList.contains("is-landed"), anim: ring.animationName, opacity: ring.opacity };
  });
  if (!still.landed || still.anim !== "none" || still.opacity !== "1") failures.push(`${name} reduced motion: the ring should show still, got ${JSON.stringify(still)}`);
  await reduced.close();
}

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "390x844", width: 390, height: 844, mobile: true },
];
try {
  for (const vp of VIEWPORTS) await run(vp);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`[motion-smoke] ${failures.length} failure(s):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("[motion-smoke] OK: no element entered twice in any step, at 1440x900 and 390x844");
