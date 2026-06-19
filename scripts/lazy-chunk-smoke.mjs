// Lazy-load chunk smoke: static asset checks + headless browser network capture.
// Run after `npm run build`. Serves the committed static/ tree on localhost.
//
//   node scripts/lazy-chunk-smoke.mjs
//
// Requires: `npx playwright install chromium` (one-time, needs network).
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const ASSETS_DIR = join(STATIC_DIR, "assets");
const PORT = Number(process.env.LAZY_SMOKE_PORT || 8791);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

function chunkKind(url) {
  const name = url.split("/").pop() || "";
  if (/^analyze-/.test(name)) return "analyze";
  if (/^train-/.test(name)) return "train";
  if (/^replay-/.test(name)) return "replay";
  if (/^movetree-/.test(name)) return "movetree";
  if (/^build-P/.test(name) || /^build-[A-Za-z0-9]+\.js$/.test(name)) return "build-view";
  if (/^teams-/.test(name)) return "teams";
  if (/^scout-/.test(name) && !/^scout-engine-/.test(name)) return "scout-view";
  if (/^settings-/.test(name)) return "settings";
  if (/^index-/.test(name)) return "index";
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

  const build = await readAsset(/^build-P/);
  assert(!/analyze-/.test(build.text), `${build.name} must not reference analyze chunk`);
  assert(!/movetree-/.test(build.text), `${build.name} must not reference movetree chunk`);

  const analyze = await readAsset(/^analyze-/);
  assert(/movetree-/.test(analyze.text), `${analyze.name} must static-import movetree chunk`);

  const index = await readAsset(/^index-/);
  assert(/movetree-/.test(index.text), "index chunk should lazy-map movetree");
  assert(/analyze-/.test(index.text), "index chunk should lazy-map analyze");
  assert(/settings-/.test(index.text), "index chunk should lazy-map settings");

  await readAsset(/^settings-/);
  assert(!/maia3-weight-cache/.test(index.text), "index chunk must not static-import maia3-weight-cache");

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
  const loaded = new Set();

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
  try {
    const page = await browser.newPage();
    page.on("response", (response) => {
      const url = response.url();
      if (!url.includes("/assets/") || !url.endsWith(".js")) return;
      const kind = chunkKind(url);
      if (kind) loaded.add(kind);
    });

    const base = `http://127.0.0.1:${PORT}`;
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    const afterDashboard = new Set(loaded);
    assert(!afterDashboard.has("analyze"), "dashboard load fetched analyze chunk");
    assert(!afterDashboard.has("train"), "dashboard load fetched train chunk");
    assert(!afterDashboard.has("replay"), "dashboard load fetched replay chunk");
    assert(!afterDashboard.has("movetree"), "dashboard load fetched movetree chunk");
    assert(!afterDashboard.has("settings"), "dashboard load fetched settings chunk");
    assert(afterDashboard.has("index"), "dashboard load should fetch index chunk");

    await page.click('[data-testid="nav-build"]');
    await page.waitForTimeout(1200);
    const afterBuild = new Set(loaded);
    assert(!afterBuild.has("analyze"), "build tab fetched analyze chunk");
    assert(!afterBuild.has("movetree"), "build tab (empty rep) fetched movetree chunk");
    assert(afterBuild.has("build-view"), "build tab should preload build view chunk");

    await page.click('[data-testid="nav-analyze"]');
    await page.waitForTimeout(1200);
    const afterAnalyze = new Set(loaded);
    assert(afterAnalyze.has("analyze"), "analyze tab should fetch analyze chunk");
    assert(afterAnalyze.has("movetree"), "analyze tab should fetch movetree chunk");

    await page.click('[data-testid="nav-train"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("train"), "train tab should fetch train chunk");

    await page.click('[data-testid="nav-replay"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("replay"), "replay tab should fetch replay chunk");
    assert(!loaded.has("scout-view"), "replay tab open must not fetch scout view chunk");

    await page.click('[data-testid="nav-settings"]');
    await page.waitForTimeout(1200);
    assert(loaded.has("settings"), "settings tab should fetch settings chunk");

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