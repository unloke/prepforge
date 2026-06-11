"""Validation: phase + phase-relative sharpness BAND on named positions.

Confirms the calibrated SHARPNESS_BANDS (mirrored from web-src/coach/intuition.js)
classify familiar positions sensibly. Run: py -3.13 scripts/maia3_sharpness_validate.py
"""
from __future__ import annotations
import math, sys
import chess, torch
from prepforge_chess.services.maia import Maia3Adapter, Maia3Config
from maia3.uci import wdl_from_value_logits

BANDS = {
    "opening": {"calm": 260, "lively": 430, "sharp": 680},
    "middlegame": {"calm": 145, "lively": 370, "sharp": 460},
    "endgame": {"calm": 8, "lively": 50, "sharp": 85},
}
_MIX = {(0,0):0,(1,0):1,(2,0):2,(3,0):3,(4,0):3,(0,1):1,(1,1):5,(2,1):4,(3,1):3,
        (0,2):2,(1,2):4,(2,2):7,(0,3):3,(1,3):3,(0,4):3}

def mixedness(b):
    t=0
    for y in range(7):
        for x in range(7):
            w=k=0
            for dy in (0,1):
                for dx in (0,1):
                    p=b.piece_at(chess.square(x+dx,y+dy))
                    if p: w+=1 if p.color==chess.WHITE else 0; k+=0 if p.color==chess.WHITE else 1
            t+=_MIX.get((w,k),0)
    return t

def phase_of(b):
    mm=sum(1 for p in b.piece_map().values() if p.piece_type not in (chess.KING,chess.PAWN))
    if mm<=6: return "endgame"
    w1=sum(1 for f in range(8) if (p:=b.piece_at(chess.square(f,0))) and p.color==chess.WHITE)
    b8=sum(1 for f in range(8) if (p:=b.piece_at(chess.square(f,7))) and p.color==chess.BLACK)
    if mm<=10 or w1<4 or b8<4 or mixedness(b)>150: return "middlegame"
    return "opening"

def sharpness(w01,l01):
    eps=1e-3; w=min(max(w01,eps),1-eps); l=min(max(l01,eps),1-eps)
    d=math.log(1/w-1)+math.log(1/l-1)
    if abs(d)<1e-6: d=1e-6 if d>=0 else -1e-6
    return (2/d)**2

def band(s,ph):
    b=BANDS[ph]
    return "sharp" if s>=b["sharp"] else "lively" if s>=b["lively"] else "calm" if s<=b["calm"] else "normal"

POS=[
 ("Start position","rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
 ("Quiet Italian","r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"),
 ("Najdorf English Attack","rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R b KQkq - 1 6"),
 ("Najdorf Poisoned Pawn","rnbqkb1r/1p3ppp/p2ppn2/8/3NPP2/2N5/PPP3PP/R1BQKB1R w KQkq - 0 7"),
 ("Closed quiet middlegame","r1bq1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8"),
 ("Sharp tactical mess","r3k2r/pp1nqppp/2pbpn2/3p4/3P1B2/2NBPN2/PPPQ1PPP/2KR3R w kq - 0 10"),
 ("Up a queen (winning)","6k1/8/8/8/8/8/8/Q5K1 w - - 0 1"),
 ("Dead-drawn K vs K","8/8/8/4k3/8/4K3/8/8 w - - 0 1"),
 ("Opposite bishops","8/5k2/3b4/8/8/3B4/5K2/8 w - - 0 1"),
]

def main():
    eng=Maia3Adapter(Maia3Config())._ensure_engine()
    dev=eng.cfg.device; elos=torch.tensor([1500],dtype=torch.long,device=dev)
    print(f"\n{'position':28s} {'phase':11s} {'W':>4s}{'D':>5s}{'L':>5s} {'sharp':>8s}  band")
    print("-"*72)
    for name,fen in POS:
        b=chess.Board(fen); eng.board=b; eng._reset_history(); eng.self_elo=eng.oppo_elo=1500
        tok=eng._tokens_from_history(eng.history).unsqueeze(0).to(dev)
        with torch.no_grad(): _,vl,_=eng.model(tok,elos,elos)
        w,d,l=wdl_from_value_logits(vl[0]); ph=phase_of(b); s=sharpness(w/1000,l/1000)
        print(f"{name:28s} {ph:11s} {w:4d}{d:5d}{l:5d} {s:8.1f}  {band(s,ph)}")
    return 0

if __name__=="__main__": sys.exit(main())
