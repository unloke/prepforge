// Coach reliability under rapid move navigation, in headless Chromium against a
// running Vite dev server (COOP/COEP on, real browser Stockfish):
//
//   node scripts/bench/coach-rapid-nav.mjs [baseUrl] [trials] [stepMs] [engineOn]
//
// Loads a game into Analyze, clicks "next" quickly through a burst of moves,
// stops, and measures whether (and how fast) the Coach replaces its instant
// sentence with the engine verdict on the move it stopped on. Also reports the
// number of Stockfish workers the page constructed.
import { chromium } from "playwright";

const baseUrl = process.argv[2] || "http://localhost:5180/static/";
const trials = Number(process.argv[3] || 6);
const stepMs = Number(process.argv[4] || 90);
const engineOn = process.argv[5] === "1";
const WAIT_MS = 15000;
// Optional: PF_LOGIN_JSON=<file with {email,password}> signs in so RUN_ANALYSIS=1 can start a
// whole-game review first and navigate while it runs (the contended case).
const loginFile = process.env.PF_LOGIN_JSON || "";
const runAnalysis = process.env.RUN_ANALYSIS === "1";

const PGN = "1. d4 e6 2. e4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 7. O-O Be7 8. Bg5 O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 13. Bh3 Rae8 14. Qd2 Bb4 15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8 21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3 24. Qxg3 Ne2+ 25. Kh1 Nxg3+ 26. Kg1 Ne2+ 27. Kh1 Rc3 0-1";

let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* try the next channel */ }
}
if (!browser) throw new Error("no Chromium-based browser is available");
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(({ engineOn }) => {
    const Native = globalThis.Worker;
    globalThis.__engineWorkers = 0;
    globalThis.Worker = class extends Native {
      constructor(url, opts) { super(url, opts); if (String(url).includes("stockfish")) globalThis.__engineWorkers += 1; }
    };
    try {
      const key = "prepforge.prefs";
      const prefs = JSON.parse(localStorage.getItem(key) || "{}");
      prefs.engineAnalyze = engineOn;
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch { /* prefs are optional */ }
  }, { engineOn });
  page.on("pageerror", (err) => failures.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (/Coach:|engine|Stockfish|memory/i.test(msg.text()) && (msg.type() === "warning" || msg.type() === "error")) failures.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
  });
  if (loginFile) {
    const { readFileSync } = await import("node:fs");
    const creds = JSON.parse(readFileSync(loginFile, "utf8"));
    await page.goto(baseUrl);
    const status = await page.evaluate(async ({ email, password }) => {
      const csrf = (await fetch("/api/csrf").then((r) => r.json())).csrf_token;
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ email, password }) });
      return r.status;
    }, creds);
    if (status !== 200) throw new Error(`login failed: ${status}`);
  }
  const throttle = Number(process.env.CPU_THROTTLE || 1);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.goto(`${baseUrl}#/analyze`);
  await page.reload(); // a hash-only goto would keep the signed-out boot state
  await page.waitForSelector("#pgn-input", { state: "attached" });
  await page.evaluate((pgn) => {
    document.getElementById("pgn-drawer").open = true;
    const input = document.getElementById("pgn-input");
    input.value = pgn;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, PGN);
  await page.waitForFunction(() => document.querySelectorAll("#analysis-moves [data-ply], #analysis-moves .mv").length > 0 || /Initial|position/.test(document.getElementById("analysis-board-label")?.textContent || ""));
  await page.waitForTimeout(800);
  if (runAnalysis) {
    await page.click("#run-analysis");
    await page.waitForTimeout(400);
  }
  const results = [];
  for (let trial = 0; trial < trials; trial += 1) {
    await page.click("#analysis-start");
    await page.waitForTimeout(300);
    // Bursts of different length so the stop ply varies (white and black moves).
    const burst = 6 + trial * 3;
    for (let i = 0; i < burst; i += 1) {
      await page.click("#analysis-next");
      await page.waitForTimeout(stepMs);
    }
    // The Coach marks its engine-grounded paint with data-state="engine"; text equality
    // would miss a verdict that was already painted before the burst ended.
    const t0 = Date.now();
    const instant = await page.textContent("#coach-prose");
    let verdict = null;
    while (Date.now() - t0 < WAIT_MS) {
      const state = await page.getAttribute("#coach-prose", "data-state");
      if (state === "engine") { verdict = await page.textContent("#coach-prose"); break; }
      await page.waitForTimeout(100);
    }
    const label = await page.textContent("#analysis-board-label");
    const job = ((await page.textContent("#analysis-job-dock")) || "").trim().slice(0, 40);
    results.push({ trial, burst, label, job, ms: verdict ? Date.now() - t0 : null, ok: !!verdict, prose: (verdict || instant || "").slice(0, 90) });
    console.log(JSON.stringify(results.at(-1)));
  }
  const workers = await page.evaluate(() => globalThis.__engineWorkers);
  const ok = results.filter((r) => r.ok);
  console.log(JSON.stringify({
    summary: true, engineOn, stepMs, trials, ok: ok.length, workers,
    medianMs: ok.length ? ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null,
    errors: failures,
  }));
} finally {
  await browser.close();
}
