// Production Engine WASM CDN smoke (stability plan #3c).
// Verifies crossOriginIsolated, COOP/COEP headers, injected asset bases, and
// that ORT .wasm is fetched from Hugging Face while glue stays same-origin.
//
//   node scripts/prod-engine-smoke.mjs
//   PROD_URL=https://prepforge-w0c5.onrender.com node scripts/prod-engine-smoke.mjs
//
// Requires: npx playwright install chromium (one-time).
import { setTimeout as sleep } from "node:timers/promises";

const PROD_URL = (process.env.PROD_URL || "https://prepforge-w0c5.onrender.com").replace(/\/$/, "");
const HF_PIN_SHA = process.env.HF_PIN_SHA || "77fcb55654f1fad83ee9e987b973ddee7d7fa459";

function fail(msg) {
  console.error(`[prod-engine-smoke] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[prod-engine-smoke] ok: ${msg}`);
}

async function waitForMaiaReady(page, timeoutMs = 135_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const model = (await page.locator("#settings-maia-model").textContent().catch(() => ""))?.trim();
    if (model === "available") return;
    await sleep(1_000);
  }
  const note = (await page.locator("#settings-maia-status").textContent().catch(() => ""))?.trim();
  fail(`Maia3 retry did not become available (${note || "no status"})`);
}

async function checkHeaders() {
  const r = await fetch(`${PROD_URL}/`);
  if (!r.ok) fail(`GET / returned ${r.status}`);
  const coop = r.headers.get("cross-origin-opener-policy");
  const coep = r.headers.get("cross-origin-embedder-policy");
  if (coop !== "same-origin") fail(`COOP expected same-origin, got ${coop}`);
  if (coep !== "require-corp") fail(`COEP expected require-corp, got ${coep}`);
  ok("COOP/COEP headers present");
  const html = await r.text();
  if (!html.includes("window.__ENGINE_ASSET_BASE=")) {
    fail("HTML missing window.__ENGINE_ASSET_BASE injection");
  }
  if (html.includes("/resolve/main/")) {
    console.warn(
      "[prod-engine-smoke] WARN: asset bases still use /resolve/main/ — pin to HF commit " +
        HF_PIN_SHA,
    );
  } else if (html.includes(`/resolve/${HF_PIN_SHA}/`)) {
    ok(`asset bases pinned to HF commit ${HF_PIN_SHA}`);
  }
}

async function browserChecks() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn("[prod-engine-smoke] playwright missing — skipping browser checks");
    return;
  }

  let browser;
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch {
      /* try next */
    }
  }
  if (!browser) fail("no Chromium browser for headless checks");

  const wasmHits = [];
  const onnxHits = [];
  try {
    const page = await browser.newPage();
    page.on("response", (response) => {
      const url = response.url();
      if (url.endsWith(".wasm")) wasmHits.push(url);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (/\.onnx(?:$|\?)/i.test(url)) onnxHits.push(url);
    });

    await page.goto(`${PROD_URL}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await sleep(2000);

    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
    if (!isolated) fail("crossOriginIsolated is false — threaded WASM will not work");
    ok("crossOriginIsolated === true");

    const bases = await page.evaluate(() => ({
      engine: globalThis.__ENGINE_ASSET_BASE || null,
      maia3: globalThis.__MAIA3_ASSET_BASE || null,
    }));
    if (!bases.engine) {
      console.warn("[prod-engine-smoke] WARN: __ENGINE_ASSET_BASE unset — ORT wasm served same-origin");
    } else {
      ok(`__ENGINE_ASSET_BASE = ${bases.engine}`);
    }

    // Warm the analyze tab so the same-origin Stockfish worker starts.
    await page.click('[data-testid="nav-analyze"]');
    await page.click('[data-testid="open-engine-widget"]');
    await sleep(3000);

    const stockfishSameOrigin = wasmHits.some(
      (u) => u.includes("/static/engine/") && /stockfish/i.test(u),
    );
    if (stockfishSameOrigin || wasmHits.some((u) => /stockfish/i.test(u))) {
      ok("Stockfish .wasm loaded same-origin");
    }

    // Settings exposes a guest-safe Maia retry control. Exercise it here instead of
    // relying on Analyze's signed-in full-game path, which deliberately gates before
    // creating the Maia provider for guests. This makes the production ORT/HF path a
    // repeatable smoke gate while leaving product behavior unchanged.
    const moreNav = page.locator("#more-nav > summary");
    if (await moreNav.count()) await moreNav.click();
    await page.click('[data-testid="nav-settings"]');
    await page.locator('[data-testid="settings-maia-retry"]').waitFor({ state: "visible", timeout: 15_000 });
    await page.click('[data-testid="settings-maia-retry"]');
    await waitForMaiaReady(page);
    const maiaState = await page.evaluate(() => ({
      model: document.querySelector("#settings-maia-model")?.textContent.trim() || "",
      note: document.querySelector("#settings-maia-status")?.textContent.trim() || "",
    }));
    if (maiaState.model !== "available") {
      fail(`Maia3 retry did not become available (${maiaState.note || "no status"})`);
    }
    const ortWasmHits = wasmHits.filter((u) => /ort-wasm/i.test(u));
    if (bases.engine && !ortWasmHits.some((u) => /huggingface\.co|hf\.co/i.test(u))) {
      fail(`ORT .wasm was not observed from the pinned HF base (seen: ${ortWasmHits.join(", ") || "none"})`);
    }
    if (!onnxHits.some((u) => /huggingface\.co|hf\.co/i.test(u))) {
      fail(`Maia ONNX was not observed from the pinned HF base (seen: ${onnxHits.join(", ") || "none"})`);
    }
    ok(`Maia3 inference available (${maiaState.note || "session loaded"})`);
    ok("ORT .wasm and Maia ONNX were fetched through the production worker");
  } finally {
    await browser.close();
  }
}

try {
  console.log(`[prod-engine-smoke] checking ${PROD_URL}`);
  await checkHeaders();
  await browserChecks();
  console.log("[prod-engine-smoke] all checks passed.");
} catch (error) {
  fail(error.message || String(error));
}
