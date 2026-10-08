// Settings viewport smoke — fixture-backed (same stack as the teams smokes).
// Serves the committed static/ tree, intercepts /api/*, and at
// 1440x900 / 1180x900 / 390x844 / 320x660 checks:
//   - no horizontal overflow, no console errors
//   - section nav (prototype 180px): lists all sections, marks the active one,
//     and scroll-spies as the user clicks through sections
//   - theme segment renders with System active and switches to Dark (real pref)
//   - engine card shows the real browser-Stockfish availability + version
//   - Maia3 card shows a real state line (no fake "Ready")
//   - switches (pf-switch) toggle with aria-checked kept in sync
// Tracked UI-v2 smoke: run the whole eight-view suite with
// `npm run smoke:ui-v2` (scripts/smoke/ui-v2/run-all.mjs).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.SETTINGS_SMOKE_PORT || 8808);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const api = (path) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path.startsWith("/api/repertoires")) return { repertoires: [], shared: [] };
  if (path.startsWith("/api/dashboard")) return { games: 0, repertoires: 0, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] };
  if (path.startsWith("/api/lichess")) return { linked: true, accounts: [{ id: "a1", username: "me_user", is_primary: true }] };
  if (path.startsWith("/api/settings")) return {};
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
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
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
if (!browser) { console.error("[settings-smoke] no browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };
  // Optional review screenshots (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after); the
  // pointer is parked bottom-right so the hover rail stays collapsed.
  const shot = async (state) => {
    if (!process.env.UI_V2_SHOTS) return;
    await page.mouse.move(vp.width - 4, vp.height - 4);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `settings-${state}-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000); // boot + signed-in hydration

  // Navigate the way users do: desktop rail (Settings sits in the rail foot),
  // mobile More sheet.
  if (vp.width > 760) {
    await page.mouse.move(30, 300);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-testid="rail-settings"]').boundingBox();
    check(!!box, "rail-settings should expose a bounding box on the expanded rail");
    if (box) {
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.mouse.up();
    }
  } else {
    await page.evaluate(() => document.querySelector('[data-testid="bottom-more"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-nav-mirror="settings"]').click());
  }
  await page.waitForFunction(() => document.getElementById("view-settings")?.classList.contains("is-active"), null, { timeout: 8000 });
  await page.waitForFunction(
    () => {
      const v = document.getElementById("settings-stockfish-version");
      const m = document.getElementById("settings-maia-model");
      return v && v.textContent !== "checking…" && m && m.textContent !== "checking…";
    },
    null,
    { timeout: 10000 },
  );

  // Exercise wider font metrics as well as the platform default.
  if (vp.font) await page.addStyleTag({ content: `:root { --font: ${vp.font}; }` });

  await shot("top");

  // Section nav (prototype 180px column): all prototype sections present, first active.
  const navLabels = await page.locator(".settings-nav .settings-nav-link").allTextContents();
  for (const expected of ["Account", "Appearance", "Engine", "Maia3", "Playing strength", "Board"]) {
    check(navLabels.some((l) => l.trim() === expected), `section nav should list "${expected}", got [${navLabels.map((l) => l.trim()).join(", ")}]`);
  }
  const firstActive = await page.locator('.settings-nav .settings-nav-link.is-active').textContent().catch(() => "");
  // Account is deliberately the first Settings section (sign-in, plan, export, delete).
  check(firstActive.trim() === "Account", `first section should start active, got "${firstActive}"`);

  // Theme segment: System starts active; clicking Dark flips the real pref
  // (documentElement data-theme follows).
  const systemActive = await page.locator('#settings-theme-seg .seg-btn[data-theme-value="system"]').getAttribute("aria-pressed");
  check(systemActive === "true", "System theme should start active");
  await page.locator('#settings-theme-seg .seg-btn[data-theme-value="dark"]').click();
  await page.waitForTimeout(300);
  const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
  check(themeAttr === "dark", `clicking Dark should apply the dark theme, got "${themeAttr}"`);
  const darkPressed = await page.locator('#settings-theme-seg .seg-btn[data-theme-value="dark"]').getAttribute("aria-pressed");
  check(darkPressed === "true", "Dark seg button should be pressed after the click");
  // Back to system so later viewports start clean (localStorage persists).
  await page.locator('#settings-theme-seg .seg-btn[data-theme-value="system"]').click();

  // Engine card: real availability (COOP/COEP are set) + real version text.
  const engineStatus = await page.locator("#settings-browser-engine-status").textContent().catch(() => "");
  check(engineStatus === "available", `browser Stockfish should read available, got "${engineStatus}"`);
  const sfVersion = await page.locator("#settings-stockfish-version").textContent().catch(() => "");
  check(/Stockfish .+ lite \(WASM\)/.test(sfVersion || ""), `engine version should render from the manifest, got "${sfVersion}"`);
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  check(isolated, "page should be cross-origin isolated (COOP/COEP)");

  // Maia3 card: a REAL state line (manifest is served, so state is on-demand/cache/off — never a canned "Ready").
  const maiaModel = await page.locator("#settings-maia-model").textContent().catch(() => "");
  check(maiaModel.length > 0 && maiaModel !== "checking…", `Maia3 state should render, got "${maiaModel}"`);

  // Switches: the Maia-analysis pf-switch toggles and keeps aria-checked in sync.
  const maiaSwitch = page.locator("#settings-maia-analysis");
  const before = await maiaSwitch.getAttribute("aria-checked");
  await maiaSwitch.click();
  await page.waitForTimeout(200);
  const after = await maiaSwitch.getAttribute("aria-checked");
  check(before !== after, `switch click should flip aria-checked (${before} → ${after})`);
  const isOn = await maiaSwitch.evaluate((el) => el.classList.contains("is-on"));
  check((after === "true") === isOn, "aria-checked and the is-on class must agree");

  // Phones hide the section nav and stack the cards as one grouped list.
  if (vp.width > 760) {
    // Section nav click: the target section must actually scroll into view and
    // the nav must stay operable. The active marker follows the visible section
    // (scrollspy) — we don't assert the animation path or that the marker equals
    // the clicked label at every instant.
    // (Connections merged into the Account card — "Chess accounts" is a block
    // inside it now, navigated via its own deep link, see states-smoke.)
    await page.locator('.settings-nav .settings-nav-link', { hasText: "Board" }).click();
    await page.waitForTimeout(900); // smooth-scroll settles
    const boardActive = await page.locator('.settings-nav .settings-nav-link.is-active').textContent().catch(() => "");
    check(/Board|Playing strength/.test(boardActive || ""), `nav should remain operable with a sane active section, got "${boardActive}"`);
    // Jump back to Account: the Chess accounts block must come on screen.
    await page.locator('.settings-nav .settings-nav-link', { hasText: "Account" }).click();
    await page.waitForTimeout(900);
    await shot("connections");
    // True viewport intersection: after the nav click the target card must be on
    // screen (top above the fold line, bottom below the top edge). The card fully
    // fits on desktop when the page can scroll far enough — assert full visibility
    // only when the document actually allows it.
    const connVis = await page.locator('[data-testid="settings-connections"]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const intersects = r.top < window.innerHeight && r.bottom > 0;
      const fullyVisible = r.top >= 0 && r.bottom <= window.innerHeight;
      const canFullyScroll = document.documentElement.scrollHeight - window.innerHeight >= Math.max(0, r.top);
      return { intersects, fullyVisible, canFullyScroll };
    });
    check(connVis.intersects, "Connections card should intersect the viewport after the nav click");
    if (connVis.canFullyScroll) {
      check(connVis.fullyVisible, "Connections card should be fully visible when scroll room allows");
    }
    // Grid sanity (single-column via grid-template-columns computed style, not a
    // media-query guess): on desktop every card sits right of the nav column; in
    // the stacked single-column layout every card starts BELOW the chip row.
    // Measured in document coordinates so page scroll doesn't skew them.
    const columnBug = await page.evaluate(() => {
      const nav = document.querySelector(".settings-nav").getBoundingClientRect();
      const navDocBottom = nav.bottom + window.scrollY;
      const singleColumn = getComputedStyle(document.querySelector("#view-settings .settings")).gridTemplateColumns.split(" ").length === 1;
      return [...document.querySelectorAll("#view-settings .settings-content .card[id]")]
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { id: c.id, left: Math.round(r.left), docTop: Math.round(r.top + window.scrollY) };
        })
        .filter((c) => (singleColumn ? c.docTop < navDocBottom : c.left < nav.right));
    });
    check(columnBug.length === 0, `all cards should sit in the content column, offending: ${JSON.stringify(columnBug)}`);
  }
  const connRow = await page.locator("#settings-lichess-accounts .conn-row").first().textContent().catch(() => "");
  check(/me_user/.test(connRow || ""), `connections should list the real linked account, got "${connRow}"`);

  // Overflow + console errors.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|favicon|net::|wasm|AbortError/i.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();
}

try {
  for (const vp of [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1180", width: 1180, height: 900 },
    { name: "mobile-390", width: 390, height: 844 },
    { name: "mobile-320-wide-font", width: 320, height: 660, font: "Arial, sans-serif" },
  ]) await runViewport(vp);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error("[settings-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[settings-smoke] ok — all four viewports render Settings (section nav, theme segment, engine/Maia3 real status, switches) with no overflow and no console errors.");
