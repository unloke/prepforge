"""Scan a Lichess account's games for Brilliant moves (the real server pipeline).

Fetches a user's recent games from Lichess, runs the production Stockfish +
Maia3 stack over **only that user's own moves**, and reports every move the
``BrilliantAnalyzer`` flags as Brilliant -- with a clickable lichess link, the
move in algebraic notation, and the underlying metrics -- so a human can label
each as a genuine brilliancy or a false positive.

    py -3.13 scripts/brilliant_scan_account.py anonymousub --count 200 --depth 16

Results stream to two files as they are found (so a long run is never lost):
    scripts/out/brilliant_<user>.md     human-readable, one row per hit
    scripts/out/brilliant_<user>.jsonl  one JSON object per hit (re-analysis)

A progress line prints per game. Re-running is cheap to resume: pass
``--skip N`` to skip the first N games already covered, or just raise --count.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from io import StringIO
from typing import List, Optional

import chess
import chess.pgn

from prepforge_chess.core.models import Color, MoveClassification
from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig
from prepforge_chess.services.classification import (
    ClassificationConfig,
    classify_move,
)
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.maia import Maia3Config, create_maia3_adapter

STOCKFISH = os.path.abspath(
    "engines/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe"
)
MAIA_RATING = 1900
ELIGIBLE = {"best", "excellent"}
LICHESS_URL = "https://lichess.org/api/games/user/{user}"


def fetch_pgns(username: str, count: int, token: Optional[str]) -> str:
    """Stream up to ``count`` of the user's games from Lichess as one PGN blob."""
    safe_user = urllib.parse.quote(username.strip(), safe="")
    url = LICHESS_URL.format(user=safe_user) + "?" + urllib.parse.urlencode({
        "max": count,
        "moves": "true",
        "clocks": "false",
        "evals": "false",
        "opening": "false",
        "literate": "false",
        "pgnInJson": "false",
    })
    headers = {
        "Accept": "application/x-chess-pgn",
        "User-Agent": "PrepForge-brilliant-scan/0.1",
    }
    if token:
        headers["Authorization"] = "Bearer {0}".format(token)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def split_games(pgn_text: str) -> List[chess.pgn.Game]:
    games = []
    stream = StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        games.append(game)
    return games


def user_color(game: chess.pgn.Game, username: str) -> Optional[Color]:
    needle = username.strip().lower()
    if (game.headers.get("White", "") or "").strip().lower() == needle:
        return Color.WHITE
    if (game.headers.get("Black", "") or "").strip().lower() == needle:
        return Color.BLACK
    return None


def game_id(game: chess.pgn.Game) -> Optional[str]:
    site = (game.headers.get("Site", "") or "").rstrip("/")
    if "lichess.org" not in site:
        return None
    return site.rsplit("/", 1)[-1] or None


def move_label(fullmove: int, is_white: bool, san: str) -> str:
    return "{0}.{1}{2}".format(fullmove, "" if is_white else "..", san)


def scan_game(game, side, gid, engine, maia, analyzer, depth):
    """Yield a dict for every Brilliant move the user played in this game."""
    cfg = EngineAnalysisConfig(depth=depth, multipv=1)
    ccfg = ClassificationConfig()
    board = game.board()
    want_white = side is Color.WHITE
    ply = 0
    hits = []
    for mv in game.mainline_moves():
        ply += 1
        is_white = board.turn == chess.WHITE
        if is_white != want_white:
            board.push(mv)
            continue
        fen_before = board.fen()
        san = board.san(mv)
        fullmove = board.fullmove_number
        uci = mv.uci()

        pa = engine.analyze_position(fen_before, cfg)
        board.push(mv)
        eval_after = engine.analyze_position(board.fen(), cfg).evaluation
        best_after = pa.best_evaluation_after or eval_after
        cls = classify_move(
            side_to_move=side,
            played_move_uci=uci,
            best_move_uci=pa.best_move_uci,
            played_eval_after=eval_after,
            best_eval_after=best_after,
            config=ccfg,
        )
        if cls.classification.value not in ELIGIBLE:
            continue
        result = analyzer.evaluate(
            classification=cls.classification,
            fen_before=fen_before,
            played_move_uci=uci,
            side_to_move=side,
            stockfish_eval_before=pa.evaluation,
            stockfish_eval_after=eval_after,
        )
        if result is None or not result.is_brilliant:
            continue
        anchor = "{0}#{1}".format(gid, ply) if gid else ""
        url = "https://lichess.org/{0}".format(anchor) if gid else "(local game)"
        hits.append({
            "game_id": gid,
            "url": url,
            "ply": ply,
            "move": move_label(fullmove, is_white, san),
            "uci": uci,
            "side": side.value,
            "fen_before": fen_before,
            "human_p": round(result.human_probability, 4),
            "maia_glance": round(result.maia_glance_wc, 4),
            "sf_truth": round(result.sf_truth_wc, 4),
            "sf_before": round(result.sf_before_wc, 4),
            "reveal": round(result.reveal_score, 4),
            "trap_gap": round(result.trap_gap, 4) if result.trap_gap is not None else None,
            "white": game.headers.get("White"),
            "black": game.headers.get("Black"),
            "result": game.headers.get("Result"),
        })
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("--count", type=int, default=100, help="how many recent games to fetch")
    ap.add_argument("--skip", type=int, default=0, help="skip the first N fetched games")
    ap.add_argument("--depth", type=int, default=16)
    ap.add_argument("--token", default=os.environ.get("LICHESS_TOKEN"),
                    help="optional Lichess OAuth token (faster, fewer rate limits)")
    args = ap.parse_args()

    out_dir = os.path.abspath("scripts/out")
    os.makedirs(out_dir, exist_ok=True)
    md_path = os.path.join(out_dir, "brilliant_{0}.md".format(args.username.lower()))
    jl_path = os.path.join(out_dir, "brilliant_{0}.jsonl".format(args.username.lower()))

    print("Fetching up to {0} games for '{1}'...".format(args.count, args.username))
    raw = fetch_pgns(args.username, args.count, args.token)
    games = split_games(raw)
    print("Fetched {0} games.".format(len(games)))
    if args.skip:
        games = games[args.skip:]
        print("Skipping first {0}; {1} remain.".format(args.skip, len(games)))

    engine = StockfishEngine(STOCKFISH)
    maia = create_maia3_adapter(config=Maia3Config(default_rating=MAIA_RATING))
    if not maia.is_available():
        print("ERROR: Maia3 is not available -- brilliant detection is disabled. "
              "Run under py 3.13/3.11 with maia3 installed.")
        engine.close()
        sys.exit(1)
    analyzer = BrilliantAnalyzer(
        maia=maia,
        engine=engine,
        engine_config=EngineAnalysisConfig(depth=args.depth, multipv=1),
        config=BrilliantConfig(),
    )

    md = open(md_path, "a", encoding="utf-8")
    jl = open(jl_path, "a", encoding="utf-8")
    md.write("\n# Brilliant scan: {0} ({1} games, depth {2}) -- {3}\n\n".format(
        args.username, len(games), args.depth, time.strftime("%Y-%m-%d %H:%M")))
    md.write("| # | link | move | human_p | glance | truth | reveal | game |\n")
    md.write("|---|------|------|---------|--------|-------|--------|------|\n")
    md.flush()

    total_hits = 0
    started = time.time()
    try:
        for i, game in enumerate(games, 1):
            side = user_color(game, args.username)
            gid = game_id(game)
            if side is None:
                print("  [{0}/{1}] {2}: user not a player, skip".format(i, len(games), gid))
                continue
            hits = scan_game(game, side, gid, engine, maia, analyzer, args.depth)
            for h in hits:
                total_hits += 1
                jl.write(json.dumps(h, ensure_ascii=False) + "\n")
                md.write("| {0} | {1} | **{2}** | {3:.3f} | {4:.3f} | {5:.3f} | {6:+.3f} | {7} vs {8} |\n".format(
                    total_hits, h["url"], h["move"], h["human_p"], h["maia_glance"],
                    h["sf_truth"], h["reveal"], h["white"], h["black"]))
            jl.flush()
            md.flush()
            elapsed = time.time() - started
            rate = i / elapsed if elapsed else 0
            eta = (len(games) - i) / rate if rate else 0
            tag = "  <-- {0} BRILLIANT".format(len(hits)) if hits else ""
            print("  [{0}/{1}] {2} ({3}) hits={4} total={5} {6:.1f}g/min ETA {7:.0f}m{8}".format(
                i, len(games), gid, side.value, len(hits), total_hits,
                rate * 60, eta / 60, tag))
    finally:
        engine.close()
        md.write("\n**Total brilliant: {0}** over {1} games.\n".format(total_hits, len(games)))
        md.close()
        jl.close()

    print("\nDone. {0} brilliant moves found.".format(total_hits))
    print("  Markdown: {0}".format(md_path))
    print("  JSONL:    {0}".format(jl_path))


if __name__ == "__main__":
    main()
