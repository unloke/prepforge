// Lazy-load chunk smoke: static asset checks + headless browser network capture.
// Run after `npm run build`. Serves static/ or LAZY_SMOKE_STATIC_DIR on localhost.
//
//   node scripts/lazy-chunk-smoke.mjs
//
// Requires: `npx playwright install chromium` (one-time, needs network).
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = process.env.LAZY_SMOKE_STATIC_DIR || join(ROOT, "src", "prepforge_chess", "web", "static");
const ASSETS_DIR = join(STATIC_DIR, "assets");
const PORT = Number(process.env.LAZY_SMOKE_PORT || 8791);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

// views/scout.js and the shared web-src/scout.js both emit scout-<hash>.js; the
// view is the one scout-controller imports lazily (set by staticChecks).
let scoutView = null;

function chunkKind(url) {
  const name = url.split("/").pop() || "";
  if (/^engine-widget-/.test(name)) return "engine-widget";
  if (/^analyze-/.test(name)) return "analyze";
  if (/^train-/.test(name)) return "train";
  if (/^replay-/.test(name)) return "replay";
  if (/^movetree-/.test(name)) return "movetree";
  if (/^build-P/.test(name) || /^build-[A-Za-z0-9]+\.js$/.test(name)) return "build-view";
  if (/^teams-/.test(name)) return "teams";
  if (name === scoutView) return "scout-view";
  if (/^settings-/.test(name)) return "settings";
  if (/^dashboard-/.test(name)) return "dashboard";
  if (/^index-/.test(name)) return "index";
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Files a minified chunk imports statically (`from"./x.js"` / `import"./x.js"`).
function staticImports(text) {
  return [...text.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
}

// Engine runtime and weights: never on the shell's critical path or the idle warm-up.
const HEAVY = /\.wasm$|\.onnx$|^\/static\/engine\/|\/maia3-worker-/;

async function readAsset(namePattern) {
  const files = await readdir(ASSETS_DIR);
  const hit = files.find((f) => namePattern.test(f) && f.endsWith(".js"));
  assert(hit, `missing asset matching ${namePattern}`);
  return { name: hit, text: await readFile(join(ASSETS_DIR, hit), "utf8") };
}

async function staticChecks() {
  console.log("[lazy-chunk-smoke] static checks…");
  const html = await readFile(join(STATIC_DIR, "index.html"), "utf8");
  const scriptRefs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  assert(scriptRefs.length === 1, `index.html should load one JS entry, got: ${scriptRefs.join(", ")}`);
  assert(/^\/static\/assets\/index-/.test(scriptRefs[0]), `unexpected entry script: ${scriptRefs[0]}`);

  // The build-view chunk is "build-<hash>.js" with an alphanumeric-only hash
  // (build-generate-runner-* is a different, hyphenated chunk).
  const build = await readAsset(/^build-[A-Za-z0-9]+\.js$/);
  assert(!/analyze-/.test(build.text), `${build.name} must not reference analyze chunk`);
  assert(!/movetree-/.test(build.text), `${build.name} must not reference movetree chunk`);

  // analyze-book is a helper chunk; filesystem order changes with view hashes.
  const analyze = await readAsset(/^analyze-(?!book-)/);
  assert(/movetree-/.test(analyze.text), `${analyze.name} must static-import movetree chunk`);

  const index = await readAsset(/^index-/);
  assert(/movetree-/.test(index.text), "index chunk should lazy-map movetree");
  assert(/analyze-/.test(index.text), "index chunk should lazy-map analyze");
  assert(/settings-/.test(index.text), "index chunk should lazy-map settings");
  assert(/dashboard-/.test(index.text), "index chunk should lazy-map dashboard");

  await readAsset(/^engine-widget-/);
  assert(/engine-widget-/.test(index.text), "index chunk should lazy-map engine-widget");
  const scoutController = await readAsset(/^scout-controller-/);
  scoutView = scoutController.text.match(/import\(\s*[`"']\.\/(scout-[A-Za-z0-9_-]+\.js)[`"']\s*\)/)?.[1];
  assert(scoutView, `${scoutController.name} should lazy-import the scout view chunk`);
  const dashboard = await readAsset(/^dashboard-/);
  // The shell statically imports the small engine modules (download state, the
  // Maia provider and its IndexedDB cache helpers); the heavy parts (ORT worker,
  // wasm, weights, engine widget) must stay behind dynamic import()/fetch.
  const indexStatic = staticImports(index.text);
  for (const heavy of ["maia3-worker-", "engine-widget-", "analyze-", "train-", "settings-", "replay-"]) {
    assert(!indexStatic.some((f) => f.startsWith(heavy)), `index chunk must not static-import ${heavy}*`);
  }
  for (const prefix of ["analyze-", "train-", "settings-", "build-"]) {
    assert(
      !new RegExp(`${prefix}[A-Za-z0-9_-]+\\.js`).test(dashboard.text),
      `${dashboard.name} must not reference ${prefix}* chunk asset`,
    );
  }
  assert(
    !/\.\/views\/(analyze|train|settings|build)\.js/.test(dashboard.text),
    `${dashboard.name} must not static-import other view modules`,
  );

  console.log("[lazy-chunk-smoke] static checks ok");
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
        let path = url.pathname;
        if (path === "/") path = "/index.html";
        const filePath = join(STATIC_DIR, path.replace(/^\/static\//, "").replace(/^\//, ""));
        const st = await stat(filePath);
        if (!st.isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function browserChecks() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn(
      "[lazy-chunk-smoke] playwright not installed — skipping browser capture.\n" +
        "  Run: npx playwright install chromium"
    );
    return;
  }

  console.log("[lazy-chunk-smoke] browser capture…");
  const server = await startStaticServer();

  let browser;
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch {
      /* try next channel */
    }
  }
  assert(browser, "no Chromium-based browser available for headless capture");
  const base = `http://127.0.0.1:${PORT}`;
  // Opens the shell and records chunk kinds and heavy engine requests. saveData
  // turns off the idle view warm-up (view-prefetch.js) so on-demand loading can
  // be checked view by view.
  async function open({ saveData }) {
    const context = await browser.newContext();
    if (saveData) {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "connection", { get: () => ({ saveData: true }) });
      });
    }
    const page = await context.newPage();
    const seen = { loaded: new Set(), heavy: new Set() };
    page.on("request", (request) => {
      const url = new URL(request.url()).pathname;
      if (HEAVY.test(url)) seen.heavy.add(url);
      if (!url.includes("/assets/") || !url.endsWith(".js")) return;
      const kind = chunkKind(url);
      if (kind) seen.loaded.add(kind);
    });
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    return { context, page, ...seen };
  }
  const noHeavy = (heavy, when) => assert(heavy.size === 0, `${when} fetched engine runtime/weights: ${[...heavy].join(", ")}`);

  try {
    // Idle warm-up: after first paint every view chunk is fetched, the engine is not.
    const warm = await open({ saveData: false });
    const warmKinds = ["dashboard", "build-view", "analyze", "movetree", "train", "replay", "settings", "teams"];
    // One view per idle slot (each capped at 4 s), so give the queue time to drain.
    for (let waited = 0; waited < 20000 && !warmKinds.every((k) => warm.loaded.has(k)); waited += 250) {
      await warm.page.waitForTimeout(250);
    }
    await warm.page.waitForTimeout(1000);
    for (const kind of warmKinds) assert(warm.loaded.has(kind), `idle warm-up should fetch ${kind} chunk`);
    assert(!warm.loaded.has("engine-widget"), "idle warm-up fetched engine widget chunk");
    noHeavy(warm.heavy, "idle warm-up");
    await warm.context.close();

    // On demand (warm-up off): each view's chunk loads when the view opens.
    const { page, loaded, heavy } = await open({ saveData: true });
    const afterInitialLoad = new Set(loaded);
    assert(!afterInitialLoad.has("engine-widget"), "initial dashboard load fetched engine widget chunk");
    assert(!afterInitialLoad.has("analyze"), "initial dashboard load fetched analyze chunk");
    assert(!afterInitialLoad.has("train"), "initial dashboard load fetched train chunk");
    assert(!afterInitialLoad.has("replay"), "initial dashboard load fetched replay chunk");
    assert(!afterInitialLoad.has("movetree"), "initial dashboard load fetched movetree chunk");
    assert(!afterInitialLoad.has("settings"), "initial dashboard load fetched settings chunk");
    // Dashboard is the initial active view, so its extracted chunk must load here
    // to bind the visible guest actions. Other view chunks remain deferred.
    assert(afterInitialLoad.has("dashboard"), "active dashboard should fetch dashboard chunk");
    assert(afterInitialLoad.has("index"), "dashboard load should fetch index chunk");
    noHeavy(heavy, "initial dashboard load");

    await page.click('[data-testid="nav-build"]');
    await page.waitForTimeout(1200);
    await page.click('[data-testid="nav-dashboard"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("dashboard"), "switching to dashboard tab should fetch dashboard chunk");
    const afterDashView = new Set(loaded);
    assert(!afterDashView.has("analyze"), "dashboard tab fetched analyze chunk");
    assert(!afterDashView.has("train"), "dashboard tab fetched train chunk");
    assert(!afterDashView.has("settings"), "dashboard tab fetched settings chunk");

    await page.click('[data-testid="nav-build"]');
    await page.waitForTimeout(1200);
    const afterBuild = new Set(loaded);
    assert(!afterBuild.has("analyze"), "build tab fetched analyze chunk");
    assert(!afterBuild.has("movetree"), "build tab (empty rep) fetched movetree chunk");
    assert(afterBuild.has("build-view"), "build tab should preload build view chunk");
    assert(!afterBuild.has("engine-widget"), "Build with engine off fetched engine widget chunk");
    noHeavy(heavy, "Build with engine off");

    await page.click('[data-testid="nav-analyze"]');
    await page.waitForTimeout(1200);
    const afterAnalyze = new Set(loaded);
    assert(afterAnalyze.has("analyze"), "analyze tab should fetch analyze chunk");
    assert(afterAnalyze.has("movetree"), "analyze tab should fetch movetree chunk");
    await page.click("#open-engine-widget");
    await page.waitForSelector("#engine-window.is-visible");
    assert(loaded.has("engine-widget"), "opening the engine should fetch engine widget chunk");
    await page.click("#open-engine-widget");
    await page.waitForSelector("#engine-window.is-visible", { state: "hidden" });

    await page.click('[data-testid="nav-train"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("train"), "train tab should fetch train chunk");

    await page.click('[data-testid="nav-replay"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("replay"), "replay tab should fetch replay chunk");
    assert(!loaded.has("scout-view"), "replay tab open must not fetch scout view chunk");

    console.log("[lazy-chunk-smoke] browser capture ok");
    console.log(`[lazy-chunk-smoke] chunks observed: ${[...loaded].sort().join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  await staticChecks();
  await browserChecks();
  console.log("[lazy-chunk-smoke] all checks passed.");
} catch (error) {
  console.error(`[lazy-chunk-smoke] FAIL: ${error.message}`);
  process.exit(1);
}
