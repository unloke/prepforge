// Playwright smoke: Scout streaming flow on a running PrepForge server.
// Invoked by tests/e2e/test_scout_smoke.py after uvicorn boots locally.
//
// Env:
//   E2E_BASE_URL   — default http://127.0.0.1:9876
//   E2E_SCOUT_USER — upstream username (fixture default: E2E-Opponent)
//   E2E_SCOUT_UPSTREAM=live — bypass the deterministic fixture and use Lichess
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const USE_LIVE_UPSTREAM = process.env.E2E_SCOUT_UPSTREAM === "live";
const SCOUT_FIXTURE_USER = "E2E-Opponent";
const SCOUT_USER =
  process.env.E2E_SCOUT_USER || (USE_LIVE_UPSTREAM ? "DrNykterstein" : SCOUT_FIXTURE_USER);
const TIMEOUT_MS = Number(process.env.E2E_SCOUT_TIMEOUT_MS || 90_000);

const SCOUT_FIXTURE_BLOCKS = [
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0001"]
[UTCDate "2026.09.18"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 1-0`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0002"]
[UTCDate "2026.09.17"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "0-1"]
[TimeControl "600+5"]
[Termination "Normal"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 0-1`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0003"]
[UTCDate "2026.09.16"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "1/2-1/2"]
[TimeControl "600+5"]
[Termination "Normal"]

1. Nf3 d5 2. g3 Nf6 3. Bg2 e6 4. O-O Be7 5. d4 O-O 1/2-1/2`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0004"]
[UTCDate "2026.09.15"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e5 1-0`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0005"]
[UTCDate "2026.09.14"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "0-1"]
[TimeControl "600+5"]
[Termination "Normal"]

1. c4 e5 2. Nc3 Nf6 3. g3 d5 4. cxd5 Nxd5 5. Bg2 Nb6 0-1`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0006"]
[UTCDate "2026.09.13"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "0-1"]
[TimeControl "600+5"]
[Termination "Normal"]

1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 0-1`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0007"]
[UTCDate "2026.09.12"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. e5 Nfd7 5. f4 c5 1-0`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0008"]
[UTCDate "2026.09.11"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "1/2-1/2"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 1/2-1/2`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0009"]
[UTCDate "2026.09.10"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. d4 d5 2. Nf3 Nf6 3. c4 e6 4. Nc3 c5 5. e3 Nc6 1-0`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0010"]
[UTCDate "2026.09.09"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "0-1"]
[TimeControl "600+5"]
[Termination "Normal"]

1. Nf3 Nf6 2. c4 e6 3. g3 d5 4. Bg2 Be7 5. O-O O-O 0-1`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0011"]
[UTCDate "2026.09.08"]
[UTCTime "10:00:00"]
[White "${SCOUT_FIXTURE_USER}"]
[Black "PrepForge Fixture"]
[Result "1-0"]
[TimeControl "600+5"]
[Termination "Normal"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0`,
  `[Event "E2E Scout"]
[Site "https://lichess.org/e2e0012"]
[UTCDate "2026.09.07"]
[UTCTime "10:00:00"]
[White "PrepForge Fixture"]
[Black "${SCOUT_FIXTURE_USER}"]
[Result "1/2-1/2"]
[TimeControl "600+5"]
[Termination "Normal"]

1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Ba6 5. b3 Bb4+ 1/2-1/2`,
];
const SCOUT_FIXTURE_PGN = SCOUT_FIXTURE_BLOCKS.join("\n\n");

function fail(msg) {
  console.error(`[scout-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `scout-e2e-${Date.now()}@example.com`;
  const password = "scout-e2e-pass-12";
  await page.request.get(`${BASE}/api/csrf`);
  const csrfCookie = (await page.context().cookies()).find((c) => c.name === "pf_csrf");
  const csrf = csrfCookie?.value || "";
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password, display_name: "Scout E2E" },
  });
  if (!reg.ok()) fail(`register failed: ${reg.status()} ${await reg.text()}`);
  const session = (await page.context().cookies()).find((c) => c.name === "pf_session");
  if (!session) fail("pf_session cookie missing after register");
}

async function waitForCounterAtLeast(page, min, timeoutMs) {
  const counter = page.locator('[data-testid="scout-live-count"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await counter.textContent()) || "0";
    const n = Number.parseInt(text.trim(), 10);
    if (Number.isFinite(n) && n >= min) return n;
    await sleep(250);
  }
  const finalText = await counter.textContent();
  fail(`live counter did not reach ${min} (got "${finalText}")`);
}

async function installScoutFixture(page) {
  if (USE_LIVE_UPSTREAM) return;
  await page.addInitScript(
    ({ fixturePgn }) => {
      const nativeFetch = window.fetch.bind(window);
      const blocks = fixturePgn.split(/\n\s*\n(?=\[Event )/);

      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (!url.startsWith("https://lichess.org/api/games/user/")) {
          return nativeFetch(input, init);
        }

        let timer = null;
        let index = 0;
        const stream = new ReadableStream({
          start(controller) {
            const abort = () => {
              if (timer !== null) clearTimeout(timer);
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (init.signal?.aborted) {
              abort();
              return;
            }
            init.signal?.addEventListener("abort", abort, { once: true });

            const emit = () => {
              if (init.signal?.aborted) return;
              if (index >= blocks.length) {
                init.signal?.removeEventListener("abort", abort);
                controller.close();
                return;
              }
              controller.enqueue(
                new TextEncoder().encode(`${index === 0 ? "" : "\n\n"}${blocks[index++]}`),
              );
              timer = setTimeout(emit, 250);
            };
            emit();
          },
          cancel() {
            if (timer !== null) clearTimeout(timer);
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-chess-pgn" },
        });
      };
    },
    { fixturePgn: SCOUT_FIXTURE_PGN },
  );
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright not installed — run npm ci && npx playwright install chromium");
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
  if (!browser) fail("no Chromium browser available");

  try {
    const page = await browser.newPage();
    await installScoutFixture(page);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await registerSession(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#dashboard-repertoires > *").first().waitFor({ timeout: TIMEOUT_MS });

    await page.click('[data-testid="nav-scout"]');
    await page.locator("#view-replay.is-active").waitFor({ timeout: 10_000 });
    await page.locator('.replay-card-scout:not([hidden])').waitFor({ timeout: 10_000 });
    await page.selectOption("#scout-color", "both");
    await page.click('[data-testid="scout-source-add"]');
    await page.locator(".src-popover [data-src-add]").fill(SCOUT_USER);
    await page.locator(".src-popover [data-src-add-btn]").click();
    await page.locator(".src-popover [data-src-done]").click();
    await page.click('[data-testid="scout-btn"]');

    const profile = page.locator(".scout-profile-card");
    try {
      await profile.waitFor({ timeout: TIMEOUT_MS });
    } catch {
      const errText = await page.locator(".scout-error, .scout-results").first().textContent();
      fail(`scout report did not render: ${(errText || "").trim() || "no output"}`);
    }

    const countAfterStart = await waitForCounterAtLeast(page, 1, TIMEOUT_MS);
    if (countAfterStart < 1) fail("live counter did not increment after Start");

    await page.waitForSelector(".scout-coverage-bar", { timeout: TIMEOUT_MS });

    const scoutBtn = page.locator('[data-testid="scout-btn"]');
    await scoutBtn.filter({ hasText: /^Stop$/ }).waitFor({ timeout: TIMEOUT_MS });
    await scoutBtn.click();
    await scoutBtn.filter({ hasText: /^Resume$/ }).waitFor({ timeout: 15_000 });
    const countAfterStop = Number.parseInt(
      (await page.locator('[data-testid="scout-live-count"]').textContent()) || "0",
      10,
    );
    if (!Number.isFinite(countAfterStop) || countAfterStop < 1) {
      fail(`counter invalid after Stop (${countAfterStop})`);
    }

    const colorDisabledWhilePaused = await page.locator("#scout-color").isDisabled();
    if (!colorDisabledWhilePaused) {
      fail("colour selector should be disabled while paused — use Reset to change colour");
    }

    await page.click('[data-testid="scout-btn"]');
    await page
      .locator('[data-testid="scout-btn"]')
      .filter({ hasText: /^(Stop|Resume)$/ })
      .waitFor({ timeout: TIMEOUT_MS });
    await sleep(1500);
    const countAfterResume = Number.parseInt(
      (await page.locator('[data-testid="scout-live-count"]').textContent()) || "0",
      10,
    );
    if (!Number.isFinite(countAfterResume) || countAfterResume < countAfterStop) {
      fail(`counter regressed after Resume (${countAfterResume} < ${countAfterStop})`);
    }

    const firstLine = page.locator(".scout-line").first();
    await firstLine.waitFor({ timeout: TIMEOUT_MS });
    const prepText = (await firstLine.textContent()) || "";
    if (!/When they play/i.test(prepText) || !/(you play|needs prep)/i.test(prepText)) {
      fail(`prep row missing when-they-play framing (got: ${prepText.trim().slice(0, 120) || "(empty)"})`);
    }
    await firstLine.click();
    const detail = page.locator(".scout-line-detail").first();
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator(".scout-action-analyze").click();

    await page.waitForSelector("#view-analyze.is-active", { timeout: 10_000 });
    const pgn = await page.inputValue("#pgn-input");
    if (!pgn || !pgn.includes(SCOUT_USER)) {
      fail(`Analyze tab PGN missing scout line (got: ${pgn?.slice(0, 80) || "(empty)"})`);
    }

    console.log("[scout-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
