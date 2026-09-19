import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const staticDir = join(root, "src", "prepforge_chess", "web", "static");
const installedPackage = JSON.parse(
  await readFile(join(root, "node_modules", "stockfish", "package.json"), "utf8"),
);
const port = Number(process.env.STOCKFISH_SMOKE_PORT || 8792);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
        if (url.pathname === "/api/settings") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ stockfish_depth: 18, maia_rating: null }));
          return;
        }
        const relative = url.pathname.replace(/^\/static\//, "").replace(/^\//, "") || "index.html";
        const path = join(staticDir, relative);
        const info = await stat(path);
        if (!info.isFile()) throw new Error("not a file");
        response.writeHead(200, {
          "Content-Type": mime[extname(path)] || "application/octet-stream",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        response.end(await readFile(path));
      } catch {
        response.writeHead(404).end("not found");
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const server = await startServer();
let browser;
try {
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch {
      // Prefer an installed system browser locally; CI installs Playwright Chromium.
    }
  }
  assert(browser, "no Chromium-based browser is available");
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const manifest = await fetch("/static/engine/stockfish.manifest.json").then((r) => r.json());
    const lines = await new Promise((resolve, reject) => {
      const output = [];
      const worker = new Worker("/static/engine/stockfish-lite.js");
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`UCI timeout; output: ${output.join(" | ")}`));
      }, 30_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "Stockfish worker error"));
      };
      worker.onmessage = (event) => {
        const line = typeof event.data === "string" ? event.data : event.data?.data;
        if (typeof line !== "string") return;
        output.push(line);
        if (line === "uciok") worker.postMessage("isready");
        if (line === "readyok") {
          worker.postMessage("position startpos");
          worker.postMessage("go depth 1");
        }
        if (line.startsWith("bestmove ")) {
          clearTimeout(timer);
          worker.terminate();
          resolve(output);
        }
      };
      worker.postMessage("uci");
    });
    return { isolated: self.crossOriginIsolated, manifest, lines };
  });
  assert(result.isolated, "page is not cross-origin isolated");
  assert(
    result.manifest.packageVersion === installedPackage.version,
    "manifest does not match the installed Stockfish package",
  );
  assert(
    result.lines.some((line) =>
      line.startsWith(`id name Stockfish ${result.manifest.engineVersion}`),
    ),
    "UCI identity does not match the bundled manifest",
  );
  assert(result.lines.includes("uciok"), "UCI handshake did not complete");
  assert(result.lines.includes("readyok"), "isready handshake did not complete");
  assert(result.lines.some((line) => line.startsWith("bestmove ")), "depth-one search returned no bestmove");
  const more = page.locator("#more-nav > summary");
  if (await more.count()) await more.click();
  await page.locator('[data-testid="nav-settings"]').click();
  await page.waitForFunction(
    () => document.querySelector("#settings-stockfish-version")?.textContent?.trim() !== "checking…",
    null,
    { timeout: 10_000 },
  );
  const displayedVersion = await page.locator("#settings-stockfish-version").textContent();
  assert(
    displayedVersion?.trim() === `Stockfish ${installedPackage.version} lite (WASM)`,
    `Settings displayed an unexpected engine version: ${displayedVersion}`,
  );
  console.log(
    `[stockfish-browser-smoke] Stockfish ${result.manifest.packageVersion} UCI and Settings metadata passed`,
  );
} catch (error) {
  console.error(`[stockfish-browser-smoke] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
