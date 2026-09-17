
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
uvicorn.run("prepforge_chess.api.main:app", host="127.0.0.1", port=8766)
