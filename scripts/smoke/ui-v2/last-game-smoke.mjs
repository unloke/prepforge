// Last game / "you just finished a game" smoke — real browser, real Analyze
// pipeline (server stubs, browser Stockfish), fixture /api/lichess/*.
//
// Covers the two ways a finished Lichess game reaches Analyze ("Last game" and
// the watcher's nudge) and the tab-return check:
//   1. orientation: white → black → white games are each oriented for the user,
//      through BOTH entry paths, including a `source_account` only identity
//   2. clicking Last game dismisses the nudge at once, and a probe already in
//      flight cannot put it back; a newer game still gets its own card
//   3. returning to the tab probes once per burst (focus + visibility + repeat)
//      and surfaces a game finished while away; cold start never pops
//
// Tracked UI-v2 smoke (scripts/smoke/ui-v2/run-all.mjs). Requires `npm run build`
// first. Optional LAST_GAME_SHOTS=<dir> saves screenshots per state for review.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { Chess } from "chess.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.LAST_GAME_SMOKE_PORT || 9753);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
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
for (const channel of [undefined, "msedge", "chrome"]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* next */ }
}
if (!browser) { console.error("[last-game-smoke] no chromium-based browser"); server.close(); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const failures = [];
const passes = [];
const check = (label, ok, detail) => {
  const line = `${ok ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`;
  console.log(`[last-game-smoke] ${line}`);
  (ok ? passes : failures).push(label);
};

// ---- fixtures -------------------------------------------------------------
const MOVETEXT = "1. e4 e5 2. Nf3 Nc6";
const SAN_LIST = MOVETEXT.split(" ").filter((t) => !/^\d+\.$/.test(t));
function derive(sans) {
  const chess = new Chess();
  const moves = [];
  for (let i = 0; i < sans.length; i++) {
    const fenBefore = chess.fen();
    const mv = chess.move(sans[i]);
    moves.push({
      ply: i + 1, move_number: Math.ceil((i + 1) / 2), side: mv.color === "w" ? "white" : "black",
      san: mv.san, uci: `${mv.from}${mv.to}${mv.promotion || ""}`,
      fen_before: fenBefore, fen_after: chess.fen(),
    });
  }
  return moves;
}
const MOVES = derive(SAN_LIST);

function pgn(white, black, id) {
  return `[Event "Rated blitz"]\n[Site "https://lichess.org/${id}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n\n${MOVETEXT} 1-0`;
}
const game = (id, white, black, source, minutesAgo = 2) => ({
  lichess_id: id, white, black, result: "1-0", source_account: source,
  finished_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  pgn: pgn(white, black, id),
});

// ---- page + API state ------------------------------------------------------
async function openPage() {
  const state = {
    latest: null,        // the newest game the server would report
    seen: null,          // server's stored last-seen id
    lightCalls: 0,
    fullCalls: 0,
    seenPosts: [],
    lightDelayMs: 0,
    fullStatus: 200,
    prepareCalls: 0,
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  // "Failed to load resource" is the browser echoing a status code; scenario E
  // fails a probe on purpose. Real page errors still count.
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const latestPayload = (withPgn) => {
    const g = state.latest;
    if (!g) return { has_game: false };
    const out = {
      has_game: true, lichess_id: g.lichess_id, white: g.white, black: g.black,
      result: g.result, is_new: g.lichess_id !== state.seen, finished_at: g.finished_at,
      source_account: g.source_account,
    };
    if (withPgn) out.pgn = g.pgn;
    return out;
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.startsWith("/api/auth/me")) return json({ id: "u1", display_name: "Tester", email: "t@x.test" });
    if (path.startsWith("/api/auth/providers")) return json({ google: false, password: true });
    if (path.startsWith("/api/csrf")) return json({ csrf_token: "x" });
    if (path === "/api/lichess") {
      return json({ linked: true, username: "me_user", accounts: [{ id: "a1", username: "me_user", is_primary: true }] });
    }
    if (path === "/api/lichess/latest") {
      const light = url.searchParams.get("light") === "1";
      const payload = latestPayload(!light);
      if (light) {
        state.lightCalls += 1;
        if (state.lightDelayMs) await new Promise((r) => setTimeout(r, state.lightDelayMs));
      } else {
        state.fullCalls += 1;
        if (state.fullStatus !== 200) return json({ detail: 'Lichess unavailable' }, state.fullStatus);
      }
      return json(payload);
    }
    if (path === "/api/lichess/seen") {
      const body = JSON.parse(req.postData() || "{}");
      state.seenPosts.push(body.lichess_id ?? null);
      if (body.lichess_id) state.seen = body.lichess_id;
      return json({ ok: true });
    }
    if (path === "/api/analyze/prepare") {
      state.prepareCalls += 1;
      return json({
        game_id: "smoke-game", depth: 4, engine: "stockfish (browser)",
        positions: [...new Set(MOVES.flatMap(m => [m.fen_before, m.fen_after]))],
        moves: MOVES,
        import_summary: { mode: 'single', total_games: 1, imported_count: 1, existing_count: 0, failed_count: 0, selected_index: 0, selected_game_id: 'smoke-game', games: [] },
        brilliant: { enabled: false, rating: null },
      });
    }
    if (path === "/api/analyze/classify-save") {
      const body = JSON.parse(req.postData() || "{}");
      const saved = new Map((body.positions || []).map((p) => [p.fen, p]));
      const moves = MOVES.map((m) => ({
        ...m,
        classification: "good",
        best_move_uci: (saved.get(m.fen_after) || {}).best_move_uci ?? null,
        score_cp: (saved.get(m.fen_after) || {}).score_cp ?? null,
        comment: "",
      }));
      return json({
        game_id: "smoke-game", engine: "stockfish (browser)", depth: 4, summary: {},
        position_evals: {}, moves,
        eval_graph: moves.map((m) => ({ ply: m.ply, san: m.san, score_cp: m.score_cp, bounded_score_cp: m.score_cp ?? 0, classification: m.classification })),
        critical_moments: [],
      });
    }
    if (path.startsWith("/api/repertoires")) return json({ repertoires: [], shared: [] });
    if (path.startsWith("/api/analyses")) return json({ analyses: [], next_cursor: null });
    if (path.startsWith("/api/dashboard")) {
      return json({ games: 0, repertoires: 0, training_sessions: 0, open_mistakes: 0, due_reviews: 0, due_soon: 0, streak: { current: 0, best: 0, trained_today: false }, recap: {}, recommendations: [] });
    }
    if (path.startsWith("/api/settings")) return json({ settings: {} });
    return json({});
  });
  return { page, state, errors };
}

// Board orientation as the user sees it: the square drawn at the top-left.
const orientation = (page) => page.evaluate(() =>
  (document.querySelector("#analysis-board .square") || {}).dataset?.square || null);
const ORIENT_FIRST = { white: "a8", black: "h1" };

const goAnalyze = async (page) => {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.location.hash = "");
  await page.locator('[data-testid="nav-analyze"]').click();
  await page.waitForTimeout(500);
};

// The watcher's silent baseline is the first probe after the watch starts: wait
// for it so a test focus is never mistaken for the cold start.
async function waitForBaseline(state) {
  await waitUntil(() => state.lightCalls > 0, 20_000, "baseline probe");
}
const waitUntil = async (fn, timeout, label) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

// "Last game": the Analyze button. Waits for the import + analysis to settle.
async function clickLastGame(page) {
  await page.locator("#fetch-my-game").click();
  await page.waitForFunction(
    () => document.getElementById("fetch-my-game").disabled === false,
    null, { timeout: 90_000 },
  );
}
// The nudge's own action.
async function clickNudgeAnalyze(page, expectedId) {
  await page.locator('#notices .notice', { hasText: "You just finished a game!" })
    .locator("button.notice-action", { hasText: "Analyze" }).click();
  await page.waitForFunction(id => document.getElementById('pgn-input').value.includes(`https://lichess.org/${id}`), expectedId);
  await page.waitForFunction(
    () => document.querySelectorAll("#analysis-moves .mtree-move, #analysis-moves button").length > 0,
    null, { timeout: 90_000 },
  );
  await page.waitForTimeout(400);
}
const returnToTab = page => page.evaluate(() => {
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
});

const nudgeText = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#notices .notice")]
    .filter((el) => !el.classList.contains("is-leaving") && !el.classList.contains("is-docked"))
    .map((el) => (el.querySelector(".notice-title") || {}).textContent || "")
    .filter(Boolean));

async function shot(page, name) {
  const dir = process.env.LAST_GAME_SHOTS;
  if (!dir) return;
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

// ===========================================================================
// Scenario A — orientation through the Last game button (white → black → white)
// ===========================================================================
async function scenarioButtonOrientation() {
  const { page, state, errors } = await openPage();
  state.latest = game("g-w", "me_user", "opp_a", "me_user");
  await goAnalyze(page);
  await waitForBaseline(state);
  // First game: Self is White.
  await clickLastGame(page);
  check("A1 button white game → board shown from White", await orientation(page) === ORIENT_FIRST.white, await orientation(page));
  await shot(page, "A1-white");

  // Second game: Self is Black. The previous perspective must not survive.
  state.latest = game("g-b", "opp_b", "me_user", "me_user");
  await clickLastGame(page);
  check("A2 button black game → board flips to Black", await orientation(page) === ORIENT_FIRST.black, await orientation(page));
  await shot(page, "A2-black");

  // Third game: White again, and the account that owns it is named only by
  // source_account (the linked list does not carry it) — the extra identity
  // must still be enough to orient.
  state.latest = game("g-w2", "me_user", "opp_c", "me_user");
  await clickLastGame(page);
  check("A3 button white game → board returns to White", await orientation(page) === ORIENT_FIRST.white, await orientation(page));
  await shot(page, "A3-white-again");

  // source_account only: neither player is in the linked list, only the
  // identity the game came from names Self.
  state.latest = game("g-src", "opp_d", "alt_handle", "alt_handle");
  await clickLastGame(page);
  check("A4 source_account-only identity orients to Black", await orientation(page) === ORIENT_FIRST.black,
    { orientation: await orientation(page), note: "alt_handle is the source_account, not a linked username" });

  check("A5 no console errors", errors.length === 0, errors.slice(0, 3));
  await page.close();
}

// ===========================================================================
// Scenario B — the nudge's own action orients too (black after a white game)
// ===========================================================================
async function scenarioNudgeOrientation() {
  const { page, state, errors } = await openPage();
  state.latest = game("b-w", "me_user", "opp_a", "me_user");
  await goAnalyze(page);
  await waitForBaseline(state);
  await clickLastGame(page);
  const before = await orientation(page);

  // A black game finishes while the app is open; returning to the tab surfaces it.
  state.latest = game("b-b", "opp_b", "me_user", "me_user");
  await returnToTab(page);
  await page.waitForFunction(
    () => [...document.querySelectorAll("#notices .notice")]
      .some((el) => (el.querySelector(".notice-title") || {}).textContent === "You just finished a game!"),
    null, { timeout: 20_000 },
  ).catch(() => {});
  check("B1 a game finished while away surfaces the nudge", (await nudgeText(page)).includes("You just finished a game!"), await nudgeText(page));

  await clickNudgeAnalyze(page, 'b-b');
  check("B2 nudge import orients to Black (was White from the previous game)",
    await orientation(page) === ORIENT_FIRST.black, { before, after: await orientation(page) });
  await shot(page, "B2-nudge-black");
  check("B3 nudge is gone after its own action ran", (await nudgeText(page)).length === 0, await nudgeText(page));
  check('B4 nudge acknowledges its loaded game exactly once', JSON.stringify(state.seenPosts) === JSON.stringify(['b-w', 'b-b']), state.seenPosts);
  state.latest = game('b-w2', 'me_user', 'opp_c', 'me_user');
  await returnToTab(page);
  await page.locator('#notices .notice', { hasText: 'You just finished a game!' }).waitFor();
  await clickNudgeAnalyze(page, 'b-w2');
  check('B5 the next nudge returns the board from Black to White', await orientation(page) === ORIENT_FIRST.white, await orientation(page));
  check("B6 no console errors", errors.length === 0, errors.slice(0, 3));
  await page.close();
}

// ===========================================================================
// Scenario C — clicking Last game dismisses the nudge; a late probe can't
// re-show it; a NEWER game still gets its own card.
// ===========================================================================
async function scenarioNudgeDismissal() {
  const { page, state, errors } = await openPage();
  state.latest = game("c-1", "me_user", "opp_a", "me_user", 30);
  await goAnalyze(page);
  // The watcher's baseline is the cold-start latest game (never popped).
  await waitForBaseline(state);
  state.latest = game("c-2", "me_user", "opp_b", "me_user");
  await returnToTab(page);
  await page.waitForFunction(
    () => [...document.querySelectorAll("#notices .notice")]
      .some((el) => (el.querySelector(".notice-title") || {}).textContent === "You just finished a game!"),
    null, { timeout: 20_000 },
  ).catch(() => {});
  check("C1 nudge for the new game appears", (await nudgeText(page)).includes("You just finished a game!"), await nudgeText(page));
  await shot(page, "C1-nudge");

  // A slow probe is in flight when the user presses Last game: its response
  // arrives afterwards and must not put the same card back.
  state.lightDelayMs = 1500;
  await returnToTab(page);
  await page.waitForTimeout(150);
  await clickLastGame(page);
  const goneAt = (await nudgeText(page)).length === 0;
  check("C2 Last game dismisses the nudge at once", goneAt, await nudgeText(page));
  await page.waitForTimeout(2200); // let the delayed probe land
  check("C3 the in-flight probe does not re-show the same nudge", (await nudgeText(page)).length === 0, await nudgeText(page));
  state.lightDelayMs = 0;

  // The handled game is the one loaded; the seen POST names it exactly once.
  check("C4 seen POST names the loaded game only", JSON.stringify(state.seenPosts) === JSON.stringify(["c-2"]), state.seenPosts);

  // A genuinely newer game still earns its own card.
  state.latest = game("c-3", "opp_c", "me_user", "me_user");
  await returnToTab(page);
  await page.waitForFunction(
    () => [...document.querySelectorAll("#notices .notice")]
      .some((el) => (el.querySelector(".notice-title") || {}).textContent === "You just finished a game!"),
    null, { timeout: 20_000 },
  ).catch(() => {});
  check("C5 a newer game still surfaces its own nudge", (await nudgeText(page)).includes("You just finished a game!"), await nudgeText(page));
  // ...and its text is the new game, not the handled one.
  const sub = await page.evaluate(() => [...document.querySelectorAll("#notices .notice")]
    .map((el) => (el.querySelector(".notice-text") || {}).textContent || ""));
  check("C6 the new nudge names the new game", sub.some((t) => t.includes("opp_c")), sub);
  check("C7 no console errors", errors.length === 0, errors.slice(0, 3));
  await page.close();
}

// ===========================================================================
// Scenario D — returning to the tab probes once per burst, cold start is silent
// ===========================================================================
async function scenarioFocusReturn() {
  const { page, state, errors } = await openPage();
  state.latest = game("d-old", "me_user", "opp_a", "me_user", 180);
  await goAnalyze(page);
  // Cold start: the pre-existing game is the baseline, so no card.
  await waitForBaseline(state);
  await page.waitForTimeout(400);
  check("D1 cold start does not pop the existing latest game", (await nudgeText(page)).length === 0, await nudgeText(page));

  // The user finishes a game elsewhere and comes back: one burst of signals.
  state.latest = game("d-new", "opp_b", "me_user", "me_user", 0.2);
  const before = state.lightCalls;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1500);
  const burst = state.lightCalls - before;
  check("D2 focus + visibility + repeat = one probe", burst === 1, { probes: burst });
  check("D3 the fresh game is offered", (await nudgeText(page)).includes("You just finished a game!"), await nudgeText(page));

  // A second burst shortly after is coalesced too (no fast polling).
  const before2 = state.lightCalls;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(600);
  check("D4 an immediate second burst adds no request", state.lightCalls - before2 === 0, { probes: state.lightCalls - before2 });

  // After the gap, focus probes again (the user may have played another game).
  await page.waitForTimeout(2200);
  const before3 = state.lightCalls;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  check("D5 a later focus probes again", state.lightCalls - before3 === 1, { probes: state.lightCalls - before3 });
  check("D6 no console errors", errors.length === 0, errors.slice(0, 3));
  await page.close();
}

// ===========================================================================
// Scenario E — error recovery: a baseline exists, one probe fails, the next one
// still surfaces the game (a failed probe must not poison the watch).
// ===========================================================================
async function scenarioErrorRecovery() {
  const { page, state, errors } = await openPage();
  state.latest = game("e-old", "me_user", "opp_a", "me_user", 60);
  let failLight = false;
  let failLightCalls = 0;
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  await page.route("**/api/lichess/latest?light=1", async (route) => {
    if (failLight) {
      failLightCalls += 1;
      await failureGate;
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ detail: "lichess unavailable" }) });
    }
    state.lightCalls += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      has_game: true, lichess_id: state.latest.lichess_id, white: state.latest.white, black: state.latest.black,
      result: state.latest.result, is_new: state.latest.lichess_id !== state.seen,
      finished_at: state.latest.finished_at, source_account: state.latest.source_account,
    }) });
  });
  await goAnalyze(page);
  await waitForBaseline(state);
  // Keep the failed response pending until the recovery signal is dispatched.
  failLight = true;
  await returnToTab(page);
  await waitUntil(() => failLightCalls > 0, 20_000, "the failing probe");
  failLight = false;
  state.latest = game("e-new", "me_user", "opp_b", "me_user", 0.2);
  const beforeRecovery = state.lightCalls;
  // A real return must queue one fresh check even while the 502 is pending.
  // Request arrival above does not mean the browser has handled its rejection.
  await returnToTab(page);
  releaseFailure();
  await page.waitForFunction(
    () => [...document.querySelectorAll("#notices .notice")]
      .some((el) => (el.querySelector(".notice-title") || {}).textContent === "You just finished a game!"),
    null, { timeout: 20_000 },
  ).catch(() => {});
  check("E1 a failed probe does not stop the next one surfacing the game", (await nudgeText(page)).includes("You just finished a game!"), await nudgeText(page));
  check("E2 no console errors beyond the deliberate 502", errors.length === 0, errors.slice(0, 3));
  check('E3 the pending failure is followed by exactly one fresh probe', failLightCalls === 1 && state.lightCalls - beforeRecovery === 1,
    { failures: failLightCalls, freshProbes: state.lightCalls - beforeRecovery });
  await page.close();
}

async function scenarioCanonicalFullGame() {
  const { page, state, errors } = await openPage();
  state.latest = game('ffbase01', 'me_user', 'old_opponent', 'me_user');
  await goAnalyze(page);
  await waitForBaseline(state);
  state.latest = game('ffhint01', 'me_user', 'hint_opponent', 'me_user');
  await returnToTab(page);
  await page.locator('#notices .notice', { hasText: 'You just finished a game!' }).waitFor();
  state.latest = game('ffnew002', 'new_opponent', 'alt_handle', 'alt_handle');
  await clickNudgeAnalyze(page, 'ffnew002');
  check('F1 light G1 → full G2 uses G2 PGN', (await page.locator('#pgn-input').inputValue()).includes('ffnew002'));
  check('F2 light G1 → full G2 uses G2 Black orientation', await orientation(page) === ORIENT_FIRST.black, await orientation(page));
  check('F3 light G1 → full G2 acknowledges G2 exactly once', JSON.stringify(state.seenPosts) === JSON.stringify(['ffnew002']), state.seenPosts);
  check('F4 no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

async function scenarioFailedNudgeImport() {
  const { page, state, errors } = await openPage();
  state.latest = game('ggbase01', 'me_user', 'old_opponent', 'me_user');
  await goAnalyze(page);
  await waitForBaseline(state);
  state.latest = game('ggfail01', 'opponent', 'me_user', 'me_user');
  await returnToTab(page);
  const nudge = page.locator('#notices .notice', { hasText: 'You just finished a game!' });
  await nudge.waitFor();
  state.fullStatus = 502;
  await nudge.locator('button.notice-action', { hasText: 'Analyze' }).click();
  await page.getByText('Lichess unavailable', { exact: false }).first().waitFor();
  check('G1 failed nudge fetch sends no seen mutation', state.seenPosts.length === 0, state.seenPosts);
  check('G2 failed nudge fetch starts no analysis', state.prepareCalls === 0, state.prepareCalls);
  state.fullStatus = 200;
  await clickLastGame(page);
  check('G3 Last game can retry and acknowledge after successful loading', JSON.stringify(state.seenPosts) === JSON.stringify(['ggfail01']), state.seenPosts);
  check('G4 retried game is oriented for Black', await orientation(page) === ORIENT_FIRST.black, await orientation(page));
  check('G5 no console errors beyond the deliberate 502', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

async function scenarioInvalidPgn() {
  const { page, state, errors } = await openPage();
  state.latest = game('hhbad001', 'me_user', 'opponent', 'me_user');
  state.latest.pgn = state.latest.pgn.replace('Nf3', 'Qa9');
  await goAnalyze(page);
  await clickLastGame(page);
  check('H1 rejected PGN sends no seen mutation', state.seenPosts.length === 0, state.seenPosts);
  check('H2 rejected PGN starts no analysis', state.prepareCalls === 0, state.prepareCalls);
  check('H3 rejected PGN offers a retry action', await page.getByText('Could not load this game. Try Last game again.', { exact: false }).count() > 0);
  check('H4 no console errors', errors.length === 0, errors.slice(0, 3));
  await page.close();
}

const scenarios = [scenarioButtonOrientation, scenarioNudgeOrientation, scenarioNudgeDismissal, scenarioFocusReturn, scenarioErrorRecovery, scenarioCanonicalFullGame, scenarioFailedNudgeImport, scenarioInvalidPgn];
for (const run of scenarios) {
  console.log(`[last-game-smoke] ${run.name}`);
  try { await run(); }
  catch (error) { failures.push(`${run.name}: threw ${error && error.message}`); console.log(`[last-game-smoke] FAIL ${run.name}: ${error && error.message}`); }
}

await browser.close();
server.close();
console.log(`[last-game-smoke] ${passes.length}/${passes.length + failures.length} checks passed`);
if (failures.length) {
  for (const f of failures) console.log(`[last-game-smoke]   failed: ${f}`);
  process.exit(1);
}
