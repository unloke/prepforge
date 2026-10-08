"""Parity fixture for the browser router (web-src/engine/deepening-router.js).

Three short games with made-up screen reads go through the research pipeline: features.mjs
for the position features, train.py's own move functions for the move features, and
predict.mjs on the frozen model for the score. The browser test replays the same games
from browser-shaped evals and must reproduce the rows and scores.

    python fixture.py <frozen3-models.json> <out.json>
"""
import ast, json, math, pathlib, random, subprocess, sys, tempfile

import chess
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
models_path, out_path = sys.argv[1:3]

# Only the move functions of train.py (it imports sklearn and reads Kaggle inputs at the top).
src = (HERE / 'train.py').read_text(encoding='utf8')
wanted = {'white_win', 'terminal_read', 'read_from_row', 'grade', 'move_between', 'make_move', 'move_vector'}
tree = ast.parse(src)
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in wanted)
        or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in ('TERMINAL', 'MOVE_EXTRA') for t in n.targets))]
ns = dict(chess=chess, np=np, math=math)
exec(compile(ast.Module(body=body, type_ignores=[]), 'train.py', 'exec'), ns)

rng = random.Random(20261008)


def random_game(plies):
    b = chess.Board()
    while not b.is_game_over() and len(b.move_stack) < plies:
        b.push(rng.choice(list(b.legal_moves)))
    return b


def scripted(sans):
    b = chess.Board()
    for s in sans:
        b.push_san(s)
    return b


GAMES = [
    random_game(90),
    scripted(['f3', 'e5', 'g4', 'Qh4#']),
    scripted(['e4', 'a6', 'e5', 'd5', 'exd6', 'Nc6', 'dxc7', 'Nf6', 'cxd8=Q+', 'Kxd8']),
]


def history(b, played):
    """Made-up iteration rows [depth, cp, mate, best, nodes, timeMs, seldepth, bounds], side-to-move POV."""
    if b.is_checkmate():
        return [[0, None, 0, None, None, None, None, 0]]
    if b.is_stalemate():
        return [[0, 0, None, None, None, None, None, 0]]
    legal = [m.uci() for m in b.legal_moves]
    top = rng.choice([played] * 3 + legal) if played else rng.choice(legal)
    cp, nodes, rows = rng.randint(-300, 300), 20, []
    last = 12 if rng.random() > 0.1 else rng.randint(6, 11)  # some reads stop at the node cap
    mate_from = rng.randint(9, 12) if rng.random() < 0.08 else 99
    for d in range(1, last + 1):
        cp += rng.randint(-40, 40)
        nodes = int(nodes * rng.uniform(1.4, 2.6))
        best = top if d >= rng.randint(4, 12) else rng.choice(legal)
        mate = rng.choice([1, 2, 3, -2]) if d >= mate_from else None
        rows.append([d, None if mate else cp, mate, best, nodes, d * 7, d + rng.randint(0, 9), 0])
    return rows


games, reads = [], {}
for g in GAMES:
    b = chess.Board()
    moves = []
    for mv in g.move_stack:
        reads.setdefault(b.fen(), history(b, mv.uci()))
        fb = b.fen()
        b.push(mv)
        moves.append((fb, b.fen()))
    reads.setdefault(b.fen(), history(b, None))
    games.append(moves)

with tempfile.TemporaryDirectory() as tmp:
    rp, fp = pathlib.Path(tmp, 'reads.ndjson'), pathlib.Path(tmp, 'features.ndjson')
    rp.write_text(''.join(json.dumps(dict(fen=f, it=it)) + '\n' for f, it in reads.items()))
    subprocess.run(['node', str(HERE / 'features.mjs'), str(rp), str(fp)], cwd=ROOT, check=True, capture_output=True)
    pf = {}
    for line in fp.read_text().splitlines():
        fen, v = json.loads(line)
        pf[fen] = np.array(v, dtype=np.float32)

S = {}
for fen, it in reads.items():
    S[fen] = ns['read_from_row'](fen, it[-1], it[-1][3], 0)

rows, fixture_games = [], []
for moves in games:
    prev, out_moves = None, []
    for fb, fa in moves:
        m = ns['make_move'](fb, fa, prev)
        rows.append([float(x) for x in ns['move_vector'](m, pf, S)])
        out_moves.append(dict(side='white' if m['white'] else 'black', uci=m['uci'], fen_before=fb, fen_after=fa))
        prev = (m['fen_before'], m['uci'])
    fixture_games.append(out_moves)

with tempfile.TemporaryDirectory() as tmp:
    xp = pathlib.Path(tmp, 'rows.json')
    xp.write_text(json.dumps(rows))
    (model,) = json.loads(pathlib.Path(models_path).read_text()).values()  # the frozen rule's one model
    mp = pathlib.Path(tmp, 'model.json')
    mp.write_text(json.dumps(model))
    res = subprocess.run(['node', str(HERE / 'predict.mjs'), str(mp), str(xp)], cwd=ROOT, check=True, capture_output=True, text=True)
    scores = json.loads(res.stdout)


def browser_eval(fen, it):
    """What the browser game pass hands the router: a White-POV eval plus the history rows."""
    b = chess.Board(fen)
    if b.is_checkmate():
        return dict(score_cp=-100000 if b.turn == chess.WHITE else 100000, mate_in=None, best_move_uci=None, depth=0)
    if b.is_stalemate():
        return dict(score_cp=0, mate_in=None, best_move_uci=None, depth=0)
    sign = 1 if b.turn == chess.WHITE else -1
    last = it[-1]
    return dict(score_cp=None if last[1] is None else last[1] * sign, mate_in=None if last[2] is None else last[2] * sign,
                best_move_uci=last[3], depth=last[0],
                iterations=[dict(depth=r[0], cp=r[1], mate=r[2], best=r[3], nodes=r[4], seldepth=r[6]) for r in it])


pathlib.Path(out_path).write_text(json.dumps(dict(
    games=fixture_games, evals={f: browser_eval(f, it) for f, it in reads.items()}, rows=rows, scores=scores,
)))
print(json.dumps(dict(moves=len(rows), positions=len(reads))))
