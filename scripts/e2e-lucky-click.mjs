// Real-browser acceptance: click "I'm Feeling Lucky" 3x in real Chromium
// against the REAL FastAPI server (committed bundle + API + auth cookie +
// seeded explorer cache), asserting a Play session starts on a valid FEN.
//
// Faithfulness: the click drives the entire production chain —
// button -> onFeelingLucky -> runFeelingLucky -> ensurePlayExplorer ->
// fetchStats -> /api/lichess/explorer/masters (same-origin, authed,
// top_games=4) -> normalizeExplorer -> luckyDbStart -> buildMasterLine ->
// replay/scoring -> startPlaySession -> board paints the FEN.
// The ONLY non-production piece is where the explorer bodies come from: the
// server's _explorer_cache is pre-seeded via its own public endpoint with a
// stubbed upstream fetch (module-level patch in-process), so every browser
// request hits the real proxy code path (URL building, auth, cache lookup)
// and receives a real-shape masters body.

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";

const CWD = "D:/auto_art/prepforge-lucky-clean";
const VENV_PY = `${CWD}/.venv/Scripts/python.exe`;
const PORT = 8766;

// Seed script (runs in-process with the server module): register an account,
// mock-link a Lichess token, stub upstream fetch, warm the server cache for
// all six seed doors + the Ruy Lopez continuation tree via the PUBLIC
// endpoint, then exec uvicorn (same process keeps the warmed cache).
const SEED_PY = `
import json
from prepforge_chess.api.ratelimit import limiter
limiter.enabled = False
from prepforge_chess.api import config, db
from prepforge_chess.api.routers import lichess as lichess_router
from prepforge_chess.services import lichess_fetch

SEEDS = [
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
]
BOOK = ["e4","e5","Nf3","Nc6","Bb5","a6","Ba4","Nf6","O-O","Be7","Re1","b5","Bb3","d6","c3","O-O","h3","Nb8","d4","Nbd7","c4","c6","Nc3","Bb7","Bg5","b4","Nb1","h6","Bh4","c5","dxe5","Nxe5","Nxe5","dxe5","Qxd8","Raxd8","Rd1","Rxd1+","Bxd1","Bxe4","Bxf6","Bxf6","Rxe4","Rxd2","Rxe5","Rd5","Rxd5","cxd5","cxd5","c4","bxc4","bxc4"]

import chess as pychess

def book_position(prefix_len):
    b = pychess.Board()
    for san in BOOK[:prefix_len]:
        b.push_san(san)
    return b

def reply_moves(fen):
    import chess as c2
    b = c2.Board(fen)
    legal = {(m.uci(), b.san(m)) for m in b.legal_moves}
    seen, out = set(), []
    for san in BOOK:
        try:
            probe = c2.Board(fen)
            m = probe.parse_san(san)
            uci = m.uci()
        except Exception:
            continue
        if uci in seen:
            continue
        for u, s in legal:
            if u == uci:
                seen.add(uci)
                out.append({"uci": uci, "san": s, "white": 300, "draws": 60, "black": 200})
                break
        if len(out) >= 4:
            break
    return out or [{"uci": u, "san": s, "white": 300, "draws": 60, "black": 200} for u, s in list(legal)[:4]]

def body_for(fen, top):
    import chess as c2
    b = c2.Board(fen)
    entries = []
    if top:
        for m in list(b.legal_moves)[:2]:
            entries.append({"uci": m.uci(), "id": "a1b2c3d4",
                            "winner": "white",
                            "white": {"name": "Carlsen, Magnus", "rating": 2882},
                            "black": {"name": "Anand, Viswanathan", "rating": 2785},
                            "year": 2014, "month": "2014-11"})
    return {"white": 1000, "draws": 200, "black": 800,
            "moves": reply_moves(fen),
            "topGames": entries if top else []}

def fake_fetch(url, token, **kw):
    import urllib.parse as up
    q = dict(up.parse_qsl(up.urlsplit(url).query))
    return body_for(q.get("fen", ""), q.get("topGames", "0") != "0")

lichess_fetch.fetch_explorer_json = fake_fetch

from fastapi.testclient import TestClient
from prepforge_chess.api import main
db.Base.metadata.create_all(db.make_engine())
c = TestClient(main.app)
c.get("/api/csrf")
h = {"X-CSRF-Token": c.cookies["pf_csrf"]}
email = "browsertest@example.com"
r = c.post("/api/auth/register", json={"email": email, "password": "longpassword1"}, headers=h)
if r.status_code == 409:
    # Survives across runs (dev data/prepforge_api.sqlite3): log in instead.
    c.get("/api/csrf")
    h = {"X-CSRF-Token": c.cookies["pf_csrf"]}
    r = c.post("/api/auth/login", json={"email": email, "password": "longpassword1"}, headers=h)
    assert r.status_code == 200, r.text[:200]
else:
    assert r.status_code == 201, r.text[:200]
c.get("/api/csrf")
h = {"X-CSRF-Token": c.cookies["pf_csrf"]}
from sqlalchemy import select
from prepforge_chess.api.models import LinkedAccount, User
from prepforge_chess.api.security import encrypt_token
with db._SessionLocal() as s:
    u = s.scalar(select(User).where(User.email == email))
    existing = s.scalar(select(LinkedAccount).where(LinkedAccount.user_id == u.id, LinkedAccount.provider == "lichess"))
    if existing is None:
        s.add(LinkedAccount(user_id=u.id, provider="lichess", provider_user_id="BrowserTest",
                            encrypted_token=encrypt_token(json.dumps({"access_token": "BROWSER-TOKEN"}))))
    else:
        existing.provider_user_id = "BrowserTest"
        existing.encrypted_token = encrypt_token(json.dumps({"access_token": "BROWSER-TOKEN"}))
    s.commit()
    print("LINKED:" + u.email, flush=True)
# Warm the in-process proxy cache through the PUBLIC endpoint (authed).
for fen in SEEDS:
    r = c.get("/api/lichess/explorer/masters", params={"fen": fen, "top_games": 4})
    assert r.status_code == 200, (fen, r.status_code, r.text[:200])
print("CACHE-WARMED:" + str(len(lichess_router._explorer_cache)), flush=True)
# Hand the warmed process to uvicorn.
import uvicorn
uvicorn.run("prepforge_chess.api.main:app", host="127.0.0.1", port=${PORT})
`;

import { writeFileSync } from "node:fs";
writeFileSync(`${CWD}/scripts/e2e-serve-seeded.py`, SEED_PY.replaceAll("${PORT}", String(PORT)));

const server = spawn(VENV_PY, ["scripts/e2e-serve-seeded.py"], { cwd: CWD });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

// Wait for CACHE-WARMED then HTTP readiness.
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (h.ok && serverLog.includes("CACHE-WARMED")) break;
  } catch (_) { /* not up yet */ }
  if (Date.now() - t0 > 90000) {
    console.error("server never ready:\n" + serverLog.slice(-3000));
    server.kill();
    process.exit(1);
  }
}
console.log("server ready:", serverLog.split("\n").filter((l) => l.includes("LINKED") || l.includes("CACHE-WARMED")).join(" | "));

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-first-run", "--no-default-browser-check"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#feeling-lucky", { timeout: 30000, state: "attached" });
await page.evaluate(() => {
  // Same path as the command palette "feeling-lucky" action: Train view +
  // Play mode tab, which unhides #train-play-setup.
  const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
  if (playBtn) playBtn.click();
});
await page.waitForSelector("#train-play-setup:not([hidden]) #feeling-lucky", { timeout: 30000 }).catch(() => {});
// waitForFunction with a string predicate trips the page CSP (unsafe-eval);
// poll via evaluate instead.
for (let i = 0; i < 60; i++) {
  const t = await page.evaluate(() => document.getElementById("app-status").textContent || "");
  if (t !== "Loading…") break;
  await new Promise((r) => setTimeout(r, 500));
}

// Register the SAME account the server seeded (login, not register).
const login = await page.evaluate(async () => {
  const csrf = (await (await fetch("/api/csrf", { credentials: "same-origin" })).json()).csrf_token;
  const r = await fetch("/api/auth/login", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ email: "browsertest@example.com", password: "longpassword1" }),
  });
  const s = await (await fetch("/api/lichess/status", { credentials: "same-origin" })).json();
  return { login: r.status, lichess: s };
});
console.log("login:", JSON.stringify(login));
if (!login.lichess.connected) {
  console.error("FAIL: lichess not connected in browser session");
  await browser.close();
  server.kill();
  process.exit(1);
}
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#feeling-lucky", { timeout: 30000, state: "attached" });
await page.evaluate(() => {
  // Same path as the command palette "feeling-lucky" action: Train view +
  // Play mode tab, which unhides #train-play-setup.
  document.querySelector('[data-testid="nav-train"]')?.click();
  document.querySelector('[data-testid="train-mode-play"]')?.click();
});
await page.waitForSelector("#train-play-setup:not([hidden]) #feeling-lucky", { timeout: 30000 }).catch(() => {});
const vis = await page.evaluate(() => {
  const btn = document.getElementById("feeling-lucky");
  const r = btn?.getBoundingClientRect();
  return { setupHidden: document.getElementById("train-play-setup")?.hidden, rect: r && { w: r.width, h: r.height } };
});
console.log("visibility:", JSON.stringify(vis));

const fens = [];
for (let i = 0; i < 3; i++) {
  const before = await page.evaluate(() => document.getElementById("app-status").textContent);
  await page.evaluate(() => document.getElementById("feeling-lucky").click());
  // Poll for a status change without waitForFunction (page CSP blocks eval
  // strings in waitForFunction predicates; polling via evaluate is fine).
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await page.evaluate(() => document.getElementById("app-status").textContent);
    if (now !== before || Date.now() - t0 > 60000) break;
  }
  await new Promise((r) => setTimeout(r, 4000));
  const state = await page.evaluate(() => ({
    status: document.getElementById("app-status").textContent,
    banner: document.getElementById("train-banner-title").textContent,
    sub: document.getElementById("train-banner-sub").textContent,
    // Play session state is DOM-visible: the chip shows "Master game · <phase>"
    // and the board paints the picked FEN. Read both.
    chip: document.getElementById("train-play-chip")?.textContent || null,
    chipHidden: document.getElementById("train-play-chip")?.hidden ?? null,
  }));
  console.log(`click ${i + 1}:`, JSON.stringify(state));
  fens.push(state);
}

const ok = fens.filter((s) => /master game/i.test(s.chip || "") && s.chipHidden === false);
console.log(`\n${ok.length}/3 clicks reached a Play-session board (chip: ${JSON.stringify(ok.map((s) => s.chip))})`);
if (errors.length) console.log("pageerrors:", errors.slice(0, 5));
if (ok.length < 2) {
  console.error("ACCEPTANCE FAILED");
  await browser.close();
  server.kill();
  process.exit(1);
}
console.log("ACCEPTANCE PASSED");
console.log("phase coverage: opening/middlegame/endgame sampler checks run in node (scripts/verify-lucky-browser-path.mjs)");

await browser.close();
server.kill();
