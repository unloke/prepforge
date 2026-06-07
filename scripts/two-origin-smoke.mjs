// Standalone TWO-ORIGIN CDN capture for the Maia3 browser path
// (docs/browser-engine-migration.md "Deploy/CDN path"). The single-origin smoke
// already proved asset-base override + sha256 against a *local* weight dir; this
// harness closes the one gap that local dir can't: the production split where the
// app and the .onnx weights live on DIFFERENT origins, behind COEP/CORS/CORP.
//
// It serves two real HTTP origins on localhost:
//
//   APP origin (default :8787) — the BUILT deploy image
//   (src/prepforge_chess/web/static), which already has the deploy shape: maia3/
//   holds ONLY the manifest, the .onnx are stripped (vite trim plugin). Every
//   response carries COOP:same-origin + COEP:require-corp (cross-origin isolation,
//   exactly what the production server sends and what the threaded-wasm worker will
//   need), and HTML gets window.__MAIA3_ASSET_BASE injected pointing at the WEIGHT
//   origin — the same seam server.py's _inject_asset_base uses, so resolveModelBase()
//   resolves the weights cross-origin with NO rebuild.
//
//   WEIGHT origin (default :8788) — the .onnx "CDN", served from the git-ignored
//   web-src/public/maia3/. It sends Access-Control-Allow-Origin + Cross-Origin-
//   Resource-Policy:cross-origin so the cross-origin-isolated app may load it under
//   COEP. Every request is logged, so the terminal is the CAPTURE evidence that the
//   ONNX was actually fetched from the second origin (not the app origin).
//
// What this proves that the single-origin smoke can't:
//   - asset-base override survives into a genuine cross-origin fetch,
//   - the weight CDN's CORS (ACAO) header lets the cors-mode fetch succeed under
//     cross-origin isolation, and a CDN that omits CORP is also covered,
//   - the sha256 gate still runs against the cross-origin bytes.
//
// Negative captures (two distinct, granular switches — the .onnx is loaded by a
// cors-mode `fetch()`, so the two headers gate DIFFERENT things and are NOT
// interchangeable):
//   - WEIGHT_NO_ACAO=1 — drop Access-Control-Allow-Origin. The cors-mode fetch FAILS
//     the CORS check (page FATALs "Failed to fetch"). This is the operative gate for
//     a `fetch()`; it would fail even WITHOUT cross-origin isolation, so it is a CORS
//     failure, not specifically a COEP block.
//   - WEIGHT_NO_CORP=1 — drop Cross-Origin-Resource-Policy. A cors-mode fetch is NOT
//     blocked by this (CORP gates *no-cors*/embedded loads, e.g. <img>/streamed wasm),
//     so the .onnx still loads — but a real CDN should send CORP anyway so other
//     no-cors load paths stay COEP-compatible. Capturing the still-passing run
//     documents that distinction.
//   - WEIGHT_NO_CORS=1 — convenience: drop BOTH (an unconfigured origin).
//
// Usage:
//   npm run build              # produce the deploy-shaped static/ (once)
//   node scripts/two-origin-smoke.mjs
//   # open http://localhost:8787/ in a browser; watch the page + this terminal.
//   WEIGHT_NO_ACAO=1 node scripts/two-origin-smoke.mjs   # capture the CORS failure
//
// No browser automation dep: the capture is a human-driven browser load (same as the
// single-origin smoke page), and the page already surfaces the verdict + raw report
// (window.__SMOKE_RESULT). This harness only stands up the two origins faithfully.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize, extname, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const WEIGHTS_DIR = process.env.WEIGHTS_DIR || join(ROOT, "web-src", "public", "maia3");

const APP_PORT = Number(process.env.APP_PORT || 8787);
const WEIGHT_PORT = Number(process.env.WEIGHT_PORT || 8788);
// Granular negative-capture switches (see the header comment). ACAO and CORP gate
// different load modes, so they are separate knobs; WEIGHT_NO_CORS drops both.
const NO_ACAO = !!process.env.WEIGHT_NO_ACAO || !!process.env.WEIGHT_NO_CORS;
const NO_CORP = !!process.env.WEIGHT_NO_CORP || !!process.env.WEIGHT_NO_CORS;

const WEIGHT_ORIGIN = `http://localhost:${WEIGHT_PORT}/`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
};
const mimeFor = (p) => MIME[extname(p).toLowerCase()] || "application/octet-stream";

// Resolve a URL path inside a base dir, refusing any traversal outside it.
function safeJoin(baseDir, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(baseDir, clean);
  if (full !== baseDir && !full.startsWith(baseDir + sep)) return null; // escaped base
  return full;
}

// Mirror of server.py _inject_asset_base: drop window.__MAIA3_ASSET_BASE right after
// <head> so it runs before the module scripts that read the global. JSON-encode and
// escape "</" to prevent a </script> breakout. Only the smoke page needs it, but
// injecting into any HTML is harmless.
function injectAssetBase(html, base) {
  const literal = JSON.stringify(base).replace(/<\//g, "<\\/");
  const tag = `<script>window.__MAIA3_ASSET_BASE=${literal};</script>`;
  const idx = html.indexOf("<head>");
  if (idx === -1) return html;
  return html.slice(0, idx + "<head>".length) + tag + html.slice(idx + "<head>".length);
}

async function sendFile(res, filePath, headers) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeFor(filePath), ...headers });
    res.end(body);
    return true;
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 ${filePath}`);
    return false;
  }
}

// ---- APP origin: the cross-origin-isolated deploy image ---------------------
const appServer = createServer(async (req, res) => {
  // Cross-origin isolation on EVERY response — the production header set, and what
  // the COEP:require-corp gate keys off when the cross-origin weight load happens.
  const coiHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };

  let urlPath = new URL(req.url, `http://localhost:${APP_PORT}`).pathname;
  if (urlPath === "/") urlPath = "/maia3-smoke.html"; // root → the smoke page
  // The built app references assets under /static/* (vite base); map that prefix onto
  // the static dir so absolute /static/... URLs (manifest, ort wasm, chunks) resolve.
  const rel = urlPath.startsWith("/static/") ? urlPath.slice("/static".length) : urlPath;

  const filePath = safeJoin(STATIC_DIR, rel);
  if (!filePath) {
    res.writeHead(400, coiHeaders);
    res.end("bad path");
    return;
  }

  // Inject the runtime asset base into HTML; serve everything else verbatim.
  if (filePath.endsWith(".html")) {
    try {
      const html = await readFile(filePath, "utf-8");
      const out = injectAssetBase(html, WEIGHT_ORIGIN);
      res.writeHead(200, { "Content-Type": MIME[".html"], ...coiHeaders });
      res.end(out);
    } catch {
      res.writeHead(404, coiHeaders);
      res.end(`404 ${filePath}`);
    }
    return;
  }
  await sendFile(res, filePath, coiHeaders);
});

// ---- WEIGHT origin: the .onnx "CDN" -----------------------------------------
const weightServer = createServer(async (req, res) => {
  const origin = req.headers.origin || "*";
  // The headers a real CDN/object store should send so a cross-origin-isolated app can
  // load the weights. ACAO is what the cors-mode .onnx fetch actually checks; CORP is
  // for no-cors load paths. The two negative switches drop them independently.
  const corsHeaders = {};
  if (!NO_ACAO) {
    corsHeaders["Access-Control-Allow-Origin"] = origin;
    corsHeaders["Vary"] = "Origin";
  }
  if (!NO_CORP) corsHeaders["Cross-Origin-Resource-Policy"] = "cross-origin";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  const urlPath = new URL(req.url, WEIGHT_ORIGIN).pathname;
  const filePath = safeJoin(WEIGHTS_DIR, urlPath);
  const tag = NO_ACAO
    ? "  [NO-ACAO: expect CORS failure]"
    : NO_CORP
      ? "  [NO-CORP: cors fetch still passes]"
      : "";
  console.log(`[weight] ${req.method} ${urlPath}${tag}`); // capture evidence
  if (!filePath) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  await sendFile(res, filePath, corsHeaders);
});

appServer.listen(APP_PORT, () => {
  weightServer.listen(WEIGHT_PORT, () => {
    console.log("Two-origin Maia3 CDN smoke harness");
    const hdrState = NO_ACAO
      ? "ACAO OFF — CORS failure capture"
      : NO_CORP
        ? "CORP OFF — cors fetch still passes"
        : "ACAO+CORP on";
    console.log(`  APP origin     http://localhost:${APP_PORT}/   (COOP/COEP, deploy image ${STATIC_DIR})`);
    console.log(`  WEIGHT origin  ${WEIGHT_ORIGIN}  (${hdrState}, ${WEIGHTS_DIR})`);
    console.log(`  asset base injected into HTML: ${WEIGHT_ORIGIN}`);
    console.log("");
    console.log(`  → open http://localhost:${APP_PORT}/ in a browser; weight-origin GETs log below.`);
    console.log("    Pass: page reads DONE + modelBase = the weight origin; .onnx GETs appear here.");
    console.log("    WEIGHT_NO_ACAO=1: the cors-mode .onnx fetch fails the CORS check; the page FATALs.");
  });
});
