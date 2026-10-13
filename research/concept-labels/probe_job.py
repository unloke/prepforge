"""Research only. Kaggle GPU script: train concept routers from GameKnot labels.

Inputs: labels.jsonl from freebuff.py (DeepSeek labels: positions before and after the
commented move, concepts and their categories; each category is also a tag: any of its concepts).
1. Audit: for tags a board rule can check, compare how often the rule holds with and
   without the tag (a lift well above 1 means the extraction tracks the board).
2. Features: Maia3-23M pooled activations (layers 3, 5, last) after the move vs a plain board
   encoding (one-hot) and a rich one (one-hot plus hand-made features: mobility, loose/pinned
   pieces, king zone, pawn structure, files, castling, captures and checks). "move" adds the
   activations before the move, after minus before, and the move itself (move_features).
3. Routers: linear and one-hidden-layer MLP, multi-label BCE, split by game 70/10/20.
4. Bootstrap over test games: 95% intervals for AUCs, maia minus rich and move minus maia. A fine concept is
   kept as its own output only if the router chosen on validation scores it at validation AUC
   0.65+ on 30+ validation positives; the rest live on in their category. The test split is
   used for the final evaluation only.
Writes RESULTS.json and router weights.
"""
import glob
import hashlib
import json
import subprocess
import sys
from collections import Counter, deque
from pathlib import Path

OUT = Path("/kaggle/working")
MIN_POSITIVES = 200  # training positives; rarer concepts are reported in RESULTS.json but get no router output
MIN_VAL_POSITIVES, MIN_VAL_AUC = 30, 0.65  # a fine concept is kept as its own output only with both
DIFFS = [("maia-mlp", "rich-mlp"), ("move-mlp", "maia-mlp")]
COACH = []  # package.py fills in production Coach positions: {id, fen, uci, bestUci}


def run(cmd):
    print("RUN", cmd, flush=True)
    subprocess.run(cmd, check=True)


def split(game):
    h = int(hashlib.sha1(game.encode()).hexdigest(), 16) % 10
    return "train" if h < 7 else "val" if h == 7 else "test"


def board_rules(chess, b):
    """Board facts for the audit. Keys match tag names."""
    sides = (chess.WHITE, chess.BLACK)
    pawns = {c: b.pieces(chess.PAWN, c) for c in sides}
    files = {c: [chess.square_file(s) for s in pawns[c]] for c in sides}

    def passed(c):
        for s in pawns[c]:
            f, r = chess.square_file(s), chess.square_rank(s)
            ahead = range(r + 1, 8) if c == chess.WHITE else range(0, r)
            if not any(chess.square(ff, rr) in pawns[not c]
                       for ff in (f - 1, f, f + 1) if 0 <= ff < 8 for rr in ahead):
                return True
        return False

    def doubled(c):
        return any(files[c].count(f) > 1 for f in files[c])

    def isolated(c):
        return any(f - 1 not in files[c] and f + 1 not in files[c] for f in files[c])

    pawn_files = {chess.square_file(p) for p in chess.SquareSet(b.pawns)}
    return {
        "pin": any(b.is_pinned(c, s) for c in sides for s in chess.SquareSet(b.occupied_co[c])
                   if b.piece_type_at(s) != chess.KING),
        "passed_pawn": passed(chess.WHITE) or passed(chess.BLACK),
        "doubled_pawns": doubled(chess.WHITE) or doubled(chess.BLACK),
        "isolated_pawn": isolated(chess.WHITE) or isolated(chess.BLACK),
        "open_file": any(chess.square_file(s) not in pawn_files for s in chess.SquareSet(b.rooks)),
        "bishop_pair": any(len(b.pieces(chess.BISHOP, c)) >= 2 for c in sides),
    }


def plain(chess, np, b):
    v = np.zeros(781, dtype=np.float32)
    for sq, p in b.piece_map().items():
        v[(p.piece_type - 1 + 6 * (not p.color)) * 64 + sq] = 1
    v[768] = b.turn
    for k, c in enumerate((chess.WHITE, chess.BLACK)):
        for j, pt in enumerate(chess.PIECE_TYPES):
            v[769 + 6 * k + j] = len(b.pieces(pt, c)) / 8
    return v


def rich(chess, np, b):
    """plain() plus hand-made board features: mobility, loose and pinned pieces, king zone,
    pawn structure, files, bishop pair, castling, captures and checks for the side to move."""
    sides = (chess.WHITE, chess.BLACK)
    val = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
    pawn_files = {c: [chess.square_file(s) for s in b.pieces(chess.PAWN, c)] for c in sides}
    f = [b.is_check(), sum(val[p.piece_type] for p in b.piece_map().values() if p.piece_type != chess.PAWN)]
    for c in sides:
        other = b.copy(stack=False)
        other.turn = c
        own = [s for s in chess.SquareSet(b.occupied_co[c]) if b.piece_type_at(s) != chess.KING]
        attacked = [s for s in own if b.is_attacked_by(not c, s)]
        loose = [s for s in attacked if not b.is_attacked_by(c, s)]
        cheaper = [s for s in attacked if any(val[b.piece_type_at(a)] < val[b.piece_type_at(s)]
                                              for a in b.attackers(not c, s))]
        king = b.king(c)
        zone = chess.SquareSet(chess.BB_KING_ATTACKS[king]) if king is not None else chess.SquareSet()
        fs = pawn_files[c]
        passed = []
        for s in b.pieces(chess.PAWN, c):
            fl, r = chess.square_file(s), chess.square_rank(s)
            ahead = range(r + 1, 8) if c == chess.WHITE else range(0, r)
            if not any(chess.square(ff, rr) in b.pieces(chess.PAWN, not c)
                       for ff in (fl - 1, fl, fl + 1) if 0 <= ff < 8 for rr in ahead):
                passed.append(r if c == chess.WHITE else 7 - r)
        rook_files = [chess.square_file(s) for s in b.pieces(chess.ROOK, c)]
        f += [
            sum(val[b.piece_type_at(s)] for s in chess.SquareSet(b.occupied_co[c])) - sum(
                val[b.piece_type_at(s)] for s in chess.SquareSet(b.occupied_co[not c])),
            other.pseudo_legal_moves.count(),
            len(attacked), len(loose), len(cheaper),
            sum(b.is_pinned(c, s) for s in own),
            sum(b.is_attacked_by(not c, s) for s in zone),
            len({a for s in zone for a in b.attackers(not c, s)}),
            sum(fs.count(x) > 1 for x in set(fs)),
            sum(x - 1 not in fs and x + 1 not in fs for x in set(fs)),
            len(passed), max(passed, default=0),
            sum(x not in fs and x not in pawn_files[not c] for x in rook_files),
            sum(x not in fs and x in pawn_files[not c] for x in rook_files),
            len(b.pieces(chess.BISHOP, c)) >= 2,
            b.has_kingside_castling_rights(c), b.has_queenside_castling_rights(c),
        ]
    legal = list(b.legal_moves)
    f += [len(legal), sum(b.is_capture(m) for m in legal), sum(b.gives_check(m) for m in legal)]
    return np.concatenate([plain(chess, np, b), np.asarray(f, dtype=np.float32)])


def move_features(chess, np, b, m):
    """The move in the mover's frame (squares mirrored for Black): piece, from, to, what it
    takes, check, promotion, castling."""
    v = np.zeros(6 + 64 + 64 + 6 + 3, dtype=np.float32)
    flip = 0 if b.turn == chess.WHITE else 56
    v[b.piece_type_at(m.from_square) - 1] = 1
    v[6 + (m.from_square ^ flip)] = 1
    v[70 + (m.to_square ^ flip)] = 1
    taken = chess.PAWN if b.is_en_passant(m) else b.piece_type_at(m.to_square)
    if taken and not b.is_castling(m):
        v[134 + taken - 1] = 1
    v[140:] = b.gives_check(m), bool(m.promotion), b.is_castling(m)
    return v


def bootstrap(np, auc, preds, yt, games, tags, reps=200):
    """95% intervals over test games (resampled with replacement) for each tag's AUC in the MLP
    routers and for the DIFFS between them, plus the macro AUCs."""
    rng = np.random.default_rng(0)
    by_game = {}
    for i, g in enumerate(games):
        by_game.setdefault(g, []).append(i)
    groups = list(by_game.values())
    keys = [k for k in preds if k.endswith("-mlp")]
    draws = {k: [] for k in keys + [f"{a} - {b}" for a, b in DIFFS]}
    for _ in range(reps):
        ix = np.concatenate([groups[g] for g in rng.integers(0, len(groups), len(groups))])
        y = yt[ix]
        a = {k: np.full(len(tags), np.nan) for k in keys}
        for j in range(len(tags)):
            if 0 < y[:, j].sum() < len(y):
                for k in keys:
                    a[k][j] = auc(y[:, j], preds[k][ix, j])
        for k in keys:
            draws[k].append(a[k])
        for x, z in DIFFS:
            draws[f"{x} - {z}"].append(a[x] - a[z])
    pct = lambda xs: [round(float(v), 4) for v in np.nanpercentile(xs, [2.5, 97.5])]
    return {"reps": reps,
            "macro": {k: pct([np.nanmean(d) for d in draws[k]]) for k in draws},
            "per_tag": {t: {k: pct([d[j] for d in draws[k]]) for k in draws} for j, t in enumerate(tags)}}


def main():
    if not OUT.is_dir():
        raise RuntimeError("Kaggle only")
    run([sys.executable, "-m", "pip", "install", "-q", "chess", "git+https://github.com/CSSLab/maia3.git"])
    import chess
    import numpy as np
    import torch
    from maia3.dataset import tokenize_board
    from maia3.uci import Maia3UCIEngine, parse_args
    from sklearn.metrics import average_precision_score, roc_auc_score
    DEV = "cuda" if torch.cuda.is_available() else "cpu"

    path = glob.glob("/kaggle/input/**/labels.jsonl", recursive=True)[0]
    rows = [json.loads(line) for line in open(path, encoding="utf-8")]
    for r in rows:  # a category is a tag of its own: any of its concepts
        r["tags"] = r["tags"] + [f"[{c}]" for c in r["cats"]]
    count = Counter(t for r in rows for t in r["tags"])
    train_count = Counter(t for r in rows if split(r["game"]) == "train" for t in r["tags"])
    tags = sorted(t for t, n in train_count.items() if n >= MIN_POSITIVES)
    print("rows", len(rows), "tags", tags, flush=True)
    results = {"rows": len(rows), "tags": tags, "counts": dict(count.most_common()), "train_counts": dict(train_count),
               "positive_rate": {t: round(sum(t in r["tags"] for r in rows) / len(rows), 4) for t in tags}}

    boards = [chess.Board(r["fen"]) for r in rows]
    befores = [chess.Board(r["before"]) for r in rows]
    moves = [b.parse_san(r["move"]) for b, r in zip(befores, rows)]
    facts = [board_rules(chess, b) for b in boards]
    audit = {}
    for t in facts[0]:
        if t not in tags:
            continue
        on = [f[t] for f, r in zip(facts, rows) if t in r["tags"]]
        off = [f[t] for f, r in zip(facts, rows) if t not in r["tags"]]
        p_on, p_off = sum(on) / max(1, len(on)), sum(off) / max(1, len(off))
        audit[t] = {"n_tagged": len(on), "rule_rate_tagged": round(p_on, 3),
                    "rule_rate_untagged": round(p_off, 3), "lift": round(p_on / max(p_off, 1e-9), 2)}
    results["audit"] = audit
    print(json.dumps(audit, indent=1), flush=True)

    eng = Maia3UCIEngine(parse_args(["--model", "maia3-23m", "--device", DEV]))
    eng.ensure_model_loaded()
    model = eng.model.eval()
    layers = model.transformer.layers
    pick = [3, 5, len(layers) - 1]
    grabbed = {}
    for i in pick:
        layers[i].register_forward_hook(lambda m, a, o, i=i: grabbed.__setitem__(i, o))
    B = 512

    def maia_features(bs):
        out = []
        for s in range(0, len(bs), B):
            toks = torch.stack([eng._tokens_from_history(deque([tokenize_board(b)], maxlen=eng.cfg.history))
                                for b in bs[s:s + B]]).to(DEV)
            elo = torch.full((len(toks),), 1500, dtype=torch.long, device=DEV)
            with torch.no_grad():
                model(toks, elo, elo)
            out.append(torch.cat([torch.cat([grabbed[i].mean(1), grabbed[i].amax(1)], 1) for i in pick], 1).float().cpu())
            if s // B % 40 == 0:
                print("maia", s, flush=True)
        return torch.cat(out)

    def move_set(after, before, mv):
        return torch.cat([after, before, after - before, mv], 1)

    maia = maia_features(boards)
    move = move_set(maia, maia_features(befores),
                    torch.tensor(np.stack([move_features(chess, np, b, m) for b, m in zip(befores, moves)])))
    base = torch.tensor(np.stack([rich(chess, np, b) for b in boards]))
    print("board features", tuple(base.shape), flush=True)
    y = torch.tensor([[t in r["tags"] for t in tags] for r in rows], dtype=torch.float32)
    sp = [split(r["game"]) for r in rows]
    idx = {k: torch.tensor([i for i, s in enumerate(sp) if s == k]) for k in ("train", "val", "test")}

    def fit(x, hidden):
        mu, sd = x[idx["train"]].mean(0), x[idx["train"]].std(0) + 1e-4
        x = ((x - mu) / sd).to(DEV)
        yy = y.to(DEV)
        net = (torch.nn.Linear(x.shape[1], len(tags)) if not hidden else
               torch.nn.Sequential(torch.nn.Linear(x.shape[1], hidden), torch.nn.ReLU(), torch.nn.Dropout(0.2),
                                   torch.nn.Linear(hidden, len(tags)))).to(DEV)
        pos = yy[idx["train"]].mean(0).clamp(1e-3)
        loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=((1 - pos) / pos).sqrt())
        opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-2)
        tr, va = idx["train"].to(DEV), idx["val"].to(DEV)
        best, best_state, bad = 1e9, None, 0
        for epoch in range(60):
            net.train()
            perm = tr[torch.randperm(len(tr), device=DEV)]
            for s in range(0, len(perm), 1024):
                bi = perm[s:s + 1024]
                opt.zero_grad()
                loss_fn(net(x[bi]), yy[bi]).backward()
                opt.step()
            net.eval()
            with torch.no_grad():
                v = loss_fn(net(x[va]), yy[va]).item()
            if v < best - 1e-4:
                best, bad = v, 0
                best_state = {k: t.clone() for k, t in net.state_dict().items()}
            else:
                bad += 1
                if bad >= 5:
                    break
        net.load_state_dict(best_state)
        with torch.no_grad():
            pv = torch.sigmoid(net(x[va])).cpu().numpy()
            p = torch.sigmoid(net(x[idx["test"].to(DEV)])).cpu().numpy()
        yv, yt = y[idx["val"]].numpy(), y[idx["test"]].numpy()
        val_auc = {t: round(float(roc_auc_score(yv[:, j], pv[:, j])), 4)
                   for j, t in enumerate(tags) if 0 < yv[:, j].sum() < len(yv)}
        per = {}
        for j, t in enumerate(tags):
            if 0 < yt[:, j].sum() < len(yt):
                per[t] = {"auc": round(float(roc_auc_score(yt[:, j], p[:, j])), 4),
                          "ap": round(float(average_precision_score(yt[:, j], p[:, j])), 4),
                          "base_rate": round(float(yt[:, j].mean()), 4)}
        macro = sum(v["auc"] for v in per.values()) / len(per)
        return {"macro_auc": round(macro, 4), "val_macro_auc": round(sum(val_auc.values()) / len(val_auc), 4),
                "val_auc": val_auc, "epochs": epoch + 1, "per_tag": per}, net, (mu, sd), p

    results["routers"] = {}
    nets, preds = {}, {}
    for name, x in (("plain", base[:, :781]), ("rich", base), ("maia", maia), ("both", torch.cat([base, maia], 1)),
                    ("move", move)):
        for hidden in (0, 512):
            key = f"{name}-{'mlp' if hidden else 'linear'}"
            res, net, norm, preds[key] = fit(x, hidden)
            results["routers"][key] = res
            nets[key] = (name, net, norm)
            print(key, res["macro_auc"], flush=True)
            torch.save({"state": net.state_dict(), "mu": norm[0], "sd": norm[1], "tags": tags, "layers": pick},
                       OUT / f"router-{key}.pt")
    results["split_sizes"] = {k: len(v) for k, v in idx.items()}
    yt = y[idx["test"]].numpy()
    results["bootstrap"] = bootstrap(np, roc_auc_score, preds, yt, [rows[i]["game"] for i in idx["test"].tolist()], tags)
    # Chosen on validation only; the test split above is the final evaluation.
    best = max(results["routers"], key=lambda k: results["routers"][k]["val_macro_auc"])
    yv = y[idx["val"]].numpy()
    val_auc = results["routers"][best]["val_auc"]
    results["chosen_router"] = best
    results["kept"] = [t for j, t in enumerate(tags) if t.startswith("[") or (
        yv[:, j].sum() >= MIN_VAL_POSITIVES and val_auc.get(t, 0) >= MIN_VAL_AUC)]
    print("chosen", best, "kept", len(results["kept"]), "of", len(tags), json.dumps(results["bootstrap"]["macro"]), flush=True)

    # Production Coach positions: concept scores after the played move and after the best move, from
    # the router chosen on validation (and the rich board one, to compare).
    if COACH:
        before, mv, after = [], [], []
        for c in COACH:
            for uci in (c["uci"], c["bestUci"]):
                b = chess.Board(c["fen"])
                before.append(b.copy())
                mv.append(move_features(chess, np, b, chess.Move.from_uci(uci)))
                b.push_uci(uci)
                after.append(b)
        feats = {"rich": torch.tensor(np.stack([rich(chess, np, b) for b in after]))}
        feats["plain"] = feats["rich"][:, :781]  # rich() starts with plain()
        feats["maia"] = maia_features(after)
        feats["both"] = torch.cat([feats["rich"], feats["maia"]], 1)
        feats["move"] = move_set(feats["maia"], maia_features(before), torch.tensor(np.stack(mv)))
        scores = {}
        for key in {best, "rich-mlp", "maia-mlp", "move-mlp"}:
            name, net, (mu, sd) = nets[key]
            with torch.no_grad():
                scores[key] = torch.sigmoid(net(((feats[name] - mu) / sd).to(DEV))).cpu().numpy()
        with open(OUT / "coach-concepts.jsonl", "w", encoding="utf-8") as f:
            for i, c in enumerate(COACH):
                row = {"id": c["id"], "router": best}
                for key, sc in scores.items():
                    for side, j in (("played", 2 * i), ("best", 2 * i + 1)):
                        row[f"{key}:{side}"] = {t: round(float(sc[j, k]), 3) for k, t in enumerate(tags)}
                f.write(json.dumps(row) + "\n")
        results["coach_router"] = best
    (OUT / "RESULTS.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print("done", flush=True)


if __name__ == "__main__":
    main()
