"""Deepening router: labels, features, models and the end-to-end benchmark (PROTOCOL.md).

Runs on Kaggle (job.py train), never locally: python train.py <code-root> <out-dir>
"""
import hashlib, json, math, os, pathlib, random, subprocess, sys, time
from collections import defaultdict

import numpy as np

root, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
HERE = root / 'research/analyze-router'
T0 = time.time()


def log(**kw):
    print(json.dumps({'t': round(time.time() - T0), **kw}), flush=True)


def pip(*pkgs):
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', *pkgs], check=True)


try:
    import chess
except ImportError:
    pip('chess==1.11.2'); import chess
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score


def roots():
    return [pathlib.Path(p) for p in os.environ.get('ROUTER_INPUT', '/kaggle/input').split(os.pathsep)]


def find_input(name):
    """The largest match across the input roots (a re-filled run is a superset of its source)."""
    hits = sorted((p for r in roots() for p in r.rglob(name)), key=lambda p: -p.stat().st_size)
    assert hits, f'missing input {name}'
    return hits[0]


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


# ---- reads ----------------------------------------------------------------------------------
# A read: dict(w=White win 0..100, mate=White-POV mate or None, best=uci or None, nodes, ms).
def white_win(cp, mate):
    c = (1000 if mate > 0 else -1000) if mate is not None else max(-1000, min(1000, cp or 0))
    return 100 / (1 + math.exp(-0.00368208 * c))


def parse_info(line):
    if not line.startswith('info ') or ' depth ' not in line or ' score ' not in line:
        return None
    tok = line.split()
    def num(k):
        return int(tok[tok.index(k) + 1]) if k in tok else None
    if num('multipv') not in (None, 1):
        return None
    return dict(depth=num('depth'), seldepth=num('seldepth'), cp=num('cp'), mate=num('mate'),
                bound='lowerbound' in tok or 'upperbound' in tok, nodes=num('nodes'), time=num('time'),
                best=tok[tok.index('pv') + 1] if 'pv' in tok else None)


def iterations(lines):
    """Same rows as engine-runs.mjs iterations(): [depth, cp, mate, best, nodes, timeMs, seldepth, bounds]."""
    by = {}
    for line in lines:
        p = parse_info(line)
        if not p or p['depth'] is None:
            continue
        row = by.setdefault(p['depth'], [None, 0])
        if p['bound']:
            row[1] += 1
        else:
            row[0] = p
    return [[d, r[0]['cp'], r[0]['mate'], r[0]['best'], r[0]['nodes'], r[0]['time'], r[0]['seldepth'], r[1]]
            for d, r in sorted(by.items()) if r[0]]


TERMINAL = {}


def terminal_read(fen):
    if fen not in TERMINAL:
        b = chess.Board(fen)
        if b.is_checkmate():
            TERMINAL[fen] = dict(w=0.0 if b.turn == chess.WHITE else 100.0, mate=0, best=None, nodes=0, ms=0, depth=0)
        elif b.is_stalemate():
            TERMINAL[fen] = dict(w=50.0, mate=None, best=None, nodes=0, ms=0, depth=0)
        else:
            TERMINAL[fen] = None
    return TERMINAL[fen]


def read_from_row(fen, row, best, ms):
    """A read from one iteration row (side-to-move POV) plus its bestmove."""
    t = terminal_read(fen)
    if t:
        return t
    sign = 1 if fen.split()[1] == 'w' else -1
    cp = None if row[1] is None else row[1] * sign
    mate = None if row[2] is None else row[2] * sign
    return dict(w=white_win(cp, mate), mate=mate, best=best, nodes=row[4] or 0, ms=ms, depth=row[0])


def load_runs(path, depth_of=None):
    """engine-runs.mjs output → {fen: read}; depth_of picks an iteration (e.g. depth 12 of a depth-16 search)."""
    reads, iters = {}, {}
    with open(path, encoding='utf8') as f:
        for line in f:
            r = json.loads(line)
            it = r['it']
            if not it and not terminal_read(r['fen']):
                continue
            if depth_of is None:
                row = it[-1] if it else [0, 0, None, None, 0, 0, 0, 0]
                reads[r['fen']] = read_from_row(r['fen'], row, r['best'], r['ms'])
                iters[r['fen']] = it
            else:
                row = next((x for x in it if x[0] == depth_of), None)
                if row is not None or terminal_read(r['fen']):
                    reads[r['fen']] = read_from_row(r['fen'], row or [0, 0, None, None, 0, 0, 0, 0],
                                                    row[3] if row else None, row[5] if row else 0)
    return reads, iters


def grade(m, rb, ra):
    """Server classification (classification.py) of move m from its two reads."""
    white = m['white']
    loss = (rb['w'] - ra['w']) if white else (ra['w'] - rb['w'])
    loss = max(0.0, loss)
    if rb['best'] is not None and rb['best'] == m['uci']:
        return 0, loss
    tier = 1 if loss <= 2 else 2 if loss <= 5 else 3 if loss <= 10 else 4 if loss <= 15 else 5
    return tier, loss


def err_group(tier):
    return max(0, tier - 2)


def mate_state(r):
    return None if r['mate'] is None else (r['mate'] > 0) - (r['mate'] < 0)


def gb_inputs(m, rb, ra):
    tier, loss = grade(m, rb, ra)
    truth = (ra['w'] if m['white'] else 100 - ra['w']) / 100
    before = (rb['w'] if m['white'] else 100 - rb['w']) / 100
    return tier <= 1, truth, before


def gb_free_flip(m, rx, ry):
    """Could Great/Brilliant differ between two read pairs? ('elig'|'live'|'drift'|None).

    Maia-free, so it over-counts: the human-probability gates are not applied, and the reveal gate
    (which needs Maia's glance) is left out. Reported as a check, never a training label (Amendment 3)."""
    if m['sane'] is False:
        return None
    ex, tx, bx = gb_inputs(m, *rx)
    ey, ty, by = gb_inputs(m, *ry)
    if ex != ey:
        return 'elig'
    if not ex:
        return None
    if (tx >= 0.25 and bx <= 0.97) != (ty >= 0.25 and by <= 0.97):
        return 'live'
    if abs(tx - ty) > 0.10:
        return 'drift'
    return None


def compare(m, rbx, rax, rbd, rad):
    """Components where the outputs from reads X differ from the deep reads D. Returns (core set, strict set).
    Core: eval swing, mate state, error group, best status. Strict adds tier, best move, swing ≥ 5."""
    l1, l2 = set(), set()
    swing = max(abs(rbx['w'] - rbd['w']), abs(rax['w'] - rad['w']))
    if swing >= 10: l1.add('swing')
    if swing >= 5: l2.add('swing5')
    if mate_state(rbx) != mate_state(rbd) or mate_state(rax) != mate_state(rad): l1.add('mate')
    tx, _ = grade(m, rbx, rax)
    td, _ = grade(m, rbd, rad)
    if err_group(tx) != err_group(td): l1.add('error')
    if (tx == 0) != (td == 0): l1.add('bestStatus')
    if tx != td: l2.add('tier')
    if rbx['best'] != rbd['best']: l2.add('bestMove')
    return l1, l1 | l2


# ---- moves ------------------------------------------------------------------------------------
def move_between(fb, fa):
    b = chess.Board(fb)
    key = ' '.join(fa.split()[:3])
    for mv in b.legal_moves:
        b.push(mv)
        if ' '.join(b.fen().split()[:3]) == key:
            b.pop()
            return mv, b
        b.pop()
    return None, b


def make_move(fb, fa, prev):
    mv, b = move_between(fb, fa)
    if mv is None:
        return None
    sane = True
    if b.legal_moves.count() == 1:
        sane = False
    elif prev and b.is_capture(mv):
        pb, pmv = chess.Board(prev[0]), chess.Move.from_uci(prev[1])
        if pb.is_capture(pmv) and pmv.to_square == mv.to_square:
            sane = False
    return dict(fen_before=fb, fen_after=fa, uci=mv.uci(), white=b.turn == chess.WHITE, sane=sane,
                capture=int(b.is_capture(mv)), check=int(b.gives_check(mv)), promo=int(mv.promotion is not None))


def whole_games(path):
    games = json.loads(pathlib.Path(path).read_text())
    for g in games:
        g['moves_'] = []
        prev = None
        for i in range(len(g['moves'])):
            m = make_move(g['positions'][i], g['positions'][i + 1], prev)
            m.update(game=g['id'], ply=i)
            g['moves_'].append(m)
            prev = (m['fen_before'], m['uci'])
    return games


# ---- features -----------------------------------------------------------------------------------
FEAT = None


def position_features(reads_path):
    global FEAT
    dest = out / (pathlib.Path(reads_path).stem + '.features.ndjson')
    res = subprocess.run(['node', str(HERE / 'features.mjs'), str(reads_path), str(dest)], cwd=root, check=True,
                         capture_output=True, text=True)
    log(features=json.loads(res.stdout.strip().splitlines()[-1]))
    if FEAT is None:
        names = subprocess.run(['node', '-e', f'import("{(HERE / "features.mjs").as_uri()}").then(m=>console.log(JSON.stringify(m.FEATURES)))'],
                               cwd=root, check=True, capture_output=True, text=True)
        FEAT = json.loads(names.stdout)
    table = {}
    with dest.open(encoding='utf8') as f:
        for line in f:
            fen, v = json.loads(line)
            table[fen] = np.array(v, dtype=np.float32)
    return table


def move_vector(m, pf, S):
    rb, ra = S[m['fen_before']], S[m['fen_after']]
    tier, loss = grade(m, rb, ra)
    mover_b = rb['w'] if m['white'] else 100 - rb['w']
    mover_a = ra['w'] if m['white'] else 100 - ra['w']
    extra = [loss, float(tier == 0), float(tier), m['capture'], m['check'], m['promo'], float(m['sane']),
             mover_b, mover_a, abs(rb['w'] - ra['w']), float(rb['mate'] is not None or ra['mate'] is not None)]
    return np.concatenate([pf[m['fen_before']], pf[m['fen_after']], np.array(extra, dtype=np.float32)])


POS_EXTRA = ['lossIn', 'lossOut', 'bestOut', 'tierIn', 'tierOut', 'hasIn', 'hasOut']


def pos_extra(m_in, m_out, S):
    gi = grade(m_in, S[m_in['fen_before']], S[m_in['fen_after']]) if m_in else (0, 0.0)
    go = grade(m_out, S[m_out['fen_before']], S[m_out['fen_after']]) if m_out else (0, 0.0)
    return [gi[1], go[1], float(bool(m_out) and go[0] == 0), float(gi[0]), float(go[0]), float(bool(m_in)), float(bool(m_out))]


def pos_vector(g, i, pf, S):
    m_in = g['moves_'][i - 1] if i > 0 else None
    m_out = g['moves_'][i] if i < len(g['moves_']) else None
    return np.concatenate([pf[g['positions'][i]], np.array(pos_extra(m_in, m_out, S), dtype=np.float32)])


def pos_table(moves, pf, S, D):
    """Position rows from a move list: a position is critical when an adjacent move is core-critical and its
    own read changed (win >= 1 point, best move, or mate state)."""
    into, outof = {}, {}
    for m in moves:
        into.setdefault(m['fen_after'], m); outof.setdefault(m['fen_before'], m)
    crit = set()
    for m in moves:
        if compare(m, S[m['fen_before']], S[m['fen_after']], D[m['fen_before']], D[m['fen_after']])[0]:
            crit.update((m['fen_before'], m['fen_after']))
    X, y = [], []
    for f in set(into) | set(outof):
        X.append(np.concatenate([pf[f], np.array(pos_extra(into.get(f), outof.get(f), S), dtype=np.float32)]))
        changed = abs(S[f]['w'] - D[f]['w']) >= 1 or S[f]['best'] != D[f]['best'] or mate_state(S[f]) != mate_state(D[f])
        y.append(f in crit and changed)
    return np.stack(X), np.array(y)


MOVE_EXTRA = ['loss', 'screenBest', 'tier', 'capture', 'check', 'promo', 'sane', 'moverBefore', 'moverAfter', 'absDeltaW', 'anyMate']


# ---- routers and simulation -------------------------------------------------------------------
def tiered_flags(moves, S, loss_flag=1.0, extra=None):
    """Production deepFlags (loss ≥ loss_flag or a mate on either side), optionally OR'd with extra(m)."""
    flagged = set()
    for m in moves:
        rb, ra = S[m['fen_before']], S[m['fen_after']]
        loss = (rb['w'] - ra['w']) if m['white'] else (ra['w'] - rb['w'])
        if loss >= loss_flag or rb['mate'] is not None or ra['mate'] is not None or (extra and extra(m)):
            flagged.add(m['fen_before']); flagged.add(m['fen_after'])
    return flagged


NATIVE = {}  # native depth-16 reads (first 300 games): defines the noise-robust label


def simulate(games, S, D, flagged):
    """Final reads = D on flagged positions, S elsewhere. Residual product differences vs all-deep.

    Robust: core changes on which both deep engines (lite 16 and native 16) agree, so the screen
    differs from both; only for games with native reads."""
    res = dict(moves=0, crit1=0, crit2=0, miss1=0, miss2=0, induced1=0, critGB=0, missGB=0, critNB=0, missNB=0, critRobust=0, missRobust=0, robustGames=0, positions=0, deep=0, fn=[],
               screen_nodes=0, deep_nodes=0, full_nodes=0, screen_ms=0.0, deep_ms=0.0, full_ms=0.0)
    for g in games:
        fens = g['positions']
        res['positions'] += len(fens)
        deep_list = [f for f in fens if f in flagged]
        res['deep'] += len(deep_list)
        res['screen_nodes'] += sum(S[f]['nodes'] for f in fens)
        res['deep_nodes'] += sum(D[f]['nodes'] for f in deep_list)
        res['full_nodes'] += sum(D[f]['nodes'] for f in fens)
        res['screen_ms'] += pool_wall([S[f]['ms'] for f in fens])
        res['deep_ms'] += pool_wall([D[f]['ms'] for f in deep_list])
        res['full_ms'] += pool_wall([D[f]['ms'] for f in fens])
        native = all(f in NATIVE for f in fens)
        res['robustGames'] += native
        for m in g['moves_']:
            fb, fa = m['fen_before'], m['fen_after']
            F = lambda f: D[f] if f in flagged else S[f]
            l1, l2 = compare(m, S[fb], S[fa], D[fb], D[fa])
            r1, r2 = compare(m, F(fb), F(fa), D[fb], D[fa])
            res['moves'] += 1
            res['crit1'] += bool(l1); res['crit2'] += bool(l2)
            res['miss1'] += bool(l1 and r1); res['miss2'] += bool(l2 and r2)
            res['induced1'] += bool(r1 and not l1)
            nb, rnb = l1 - {'bestStatus'}, r1 - {'bestStatus'}
            res['critNB'] += bool(nb); res['missNB'] += bool(nb and rnb)
            gb = gb_free_flip(m, (S[fb], S[fa]), (D[fb], D[fa]))
            res['critGB'] += bool(gb); res['missGB'] += bool(gb and gb_free_flip(m, (F(fb), F(fa)), (D[fb], D[fa])))
            if native:
                N = NATIVE
                robust = (l1 & compare(m, S[fb], S[fa], N[fb], N[fa])[0]) - compare(m, D[fb], D[fa], N[fb], N[fa])[0]
                res['critRobust'] += bool(robust); res['missRobust'] += bool(robust & r1)
            if r1:
                res['fn'].append(dict(game=g['id'], ply=m['ply'], uci=m['uci'], why=sorted(r1), critical=sorted(l1),
                                      deepBefore=fb in flagged, deepAfter=fa in flagged))
    return res


def pool_wall(times, workers=4):
    """Wall time of a shared forward queue over `workers` (the browser pool shape)."""
    if not times:
        return 0.0
    free = [0.0] * workers
    for t in times:
        k = min(range(workers), key=free.__getitem__)
        free[k] += t
    return max(free)


def summary(res):
    r = {k: v for k, v in res.items() if k != 'fn'}
    r['recall1'] = 1 - res['miss1'] / max(1, res['crit1'])
    r['recall2'] = 1 - res['miss2'] / max(1, res['crit2'])
    r['recallGB'] = 1 - res['missGB'] / max(1, res['critGB'])
    r['recallNoBest'] = 1 - res['missNB'] / max(1, res['critNB'])
    r['recallRobust'] = 1 - res['missRobust'] / max(1, res['critRobust'])
    r['shallowShare'] = 1 - res['deep'] / max(1, res['positions'])
    r['nodesVsFull'] = (res['screen_nodes'] + res['deep_nodes']) / max(1, res['full_nodes'])
    r['wallVsFull'] = (res['screen_ms'] + res['deep_ms']) / max(1e-9, res['full_ms'])
    r['residual1'] = res['miss1'] + res['induced1']
    return r


def bootstrap(games, S, D, flagged, n=500, seed=7):
    per = [summary(simulate([g], S, D, flagged)) for g in games]
    rng = random.Random(seed)
    rec, sh = [], []
    for _ in range(n):
        pick = [per[rng.randrange(len(per))] for _ in per]
        crit = sum(p['crit1'] for p in pick); miss = sum(p['miss1'] for p in pick)
        rec.append(1 - miss / max(1, crit))
        sh.append(1 - sum(p['deep'] for p in pick) / sum(p['positions'] for p in pick))
    q = lambda xs: [float(np.percentile(xs, 2.5)), float(np.percentile(xs, 97.5))]
    return dict(recall1CI=q(rec), shallowShareCI=q(sh))


# ---- main ---------------------------------------------------------------------------------------
SHARDS = ('whole', 'gamesA', 'gamesB')


def load_shards(shards):
    """Screen and deep reads of whole-game shards → (S, L16, complete games de-duplicated by id, shard_of)."""
    S, L16, games, shard_of = {}, {}, [], {}
    for shard in shards:
        gj = sorted(p for r in roots() for p in r.rglob(f'{shard}/games.json'))
        if not gj:
            log(missingShard=shard)
            continue
        s, _ = load_runs(find_input(f'{shard}-lite12.ndjson'))
        d, _ = load_runs(find_input(f'{shard}-lite16.ndjson'))
        S.update(s); L16.update(d)
        for g in whole_games(gj[0]):
            shard_of[g['id']] = shard
            games.append(g)
    games = [g for g in games if all(f in S and f in L16 for f in g['positions'])]
    return S, L16, list({g['id']: g for g in games}.values()), shard_of


def split_games(games):
    """By game hash: 60% train, 15% validation, 25% test."""
    rank = sorted(games, key=lambda g: h('router:' + g['id']))
    n = len(rank)
    split = {g['id']: 'train' if i < 0.60 * n else 'val' if i < 0.75 * n else 'test' for i, g in enumerate(rank)}
    return {s_: [g for g in games if split[g['id']] == s_] for s_ in ('train', 'val', 'test')}


def main():
    random.seed(0)
    # Reads: whole games only (PROTOCOL.md amendments 1 and 4).
    S, L16, games, shard_of = load_shards(SHARDS)
    N16, _ = load_runs(find_input('whole-native16.ndjson'))
    NATIVE.update(N16)
    L16i12, _ = load_runs(find_input('whole-lite16.ndjson'), depth_of=12)
    nat_games = [g for g in games if shard_of[g['id']] == 'whole' and all(f in N16 for f in g['positions'])]
    nat_ids = {g['id'] for g in nat_games}
    log(reads=dict(screen=len(S), lite16=len(L16), native16=len(N16)),
        games=len(games), moves=sum(len(g['moves_']) for g in games), byShard=dict(_count(shard_of[g['id']] for g in games)))

    # Calibration.
    def same(a, b):
        return a['best'] == b['best'] and abs(a['w'] - b['w']) < 1e-9 and a['mate'] == b['mate']
    def pos_diff(a, b):
        return dict(n=len(a), swing10=sum(abs(a[f]['w'] - b[f]['w']) >= 10 for f in a),
                    bestMove=sum(a[f]['best'] != b[f]['best'] for f in a), mate=sum(mate_state(a[f]) != mate_state(b[f]) for f in a))
    calib = {}
    common = [f for f in L16i12 if f in S and not terminal_read(f)]
    calib['lite12FreshVsInfoLine'] = dict(n=len(common), identical=sum(same(S[f], L16i12[f]) for f in common))
    k = [f for f in N16 if f in S and f in L16 and not terminal_read(f)]
    calib['wholeGame'] = dict(
        lite12VsLite16=pos_diff({f: S[f] for f in k}, {f: L16[f] for f in k}),
        lite12VsNative16=pos_diff({f: S[f] for f in k}, {f: N16[f] for f in k}),
        lite16VsNative16=pos_diff({f: L16[f] for f in k}, {f: N16[f] for f in k}))
    log(calibration=calib)

    G = split_games(games)

    # Features (screen reads only).
    pf = {}
    for shard in SHARDS:
        try:
            pf.update(position_features(find_input(f'{shard}-lite12.ndjson')))
        except AssertionError:
            pass
    feat_names = [f'b_{n_}' for n_ in FEAT] + [f'a_{n_}' for n_ in FEAT] + MOVE_EXTRA

    def label(m, X, D):
        return bool(compare(m, X[m['fen_before']], X[m['fen_after']], D[m['fen_before']], D[m['fen_after']])[0])

    # Label base rates.
    rates = {}
    every = [m for g in games for m in g['moves_']]
    nat = [m for g in nat_games for m in g['moves_']]
    for name, moves, X, D in (('lite12→lite16 (production)', every, S, L16),
                              ('lite12→native16 (300 games)', nat, S, N16),
                              ('lite16→native16 noise floor (300 games)', nat, L16, N16)):
        c = defaultdict(int)
        for m in moves:
            l1, l2 = compare(m, X[m['fen_before']], X[m['fen_after']], D[m['fen_before']], D[m['fen_after']])
            c['moves'] += 1; c['core'] += bool(l1); c['strict'] += bool(l2)
            gb = gb_free_flip(m, (X[m['fen_before']], X[m['fen_after']]), (D[m['fen_before']], D[m['fen_after']]))
            if gb: c['gbFree:' + gb] += 1
            for k_ in l1: c[k_] += 1
            for k_ in l2 - l1: c['strict:' + k_] += 1
        rates[name] = dict(c)
    log(labelRates=rates)

    # Models.
    def fit(kind, X, y):
        if kind == 'logreg':
            sc = StandardScaler().fit(X)
            return (sc, LogisticRegression(max_iter=2000, class_weight='balanced', C=1.0).fit(sc.transform(X), y))
        if kind == 'tree':
            return (None, DecisionTreeClassifier(max_depth=6, min_samples_leaf=50, class_weight='balanced', random_state=0).fit(X, y))
        if kind == 'gbt':
            w = np.where(y, (len(y) - y.sum()) / max(1, y.sum()), 1.0)
            return (None, HistGradientBoostingClassifier(max_iter=60, max_depth=3, learning_rate=0.1, random_state=0).fit(X, y, sample_weight=w))
        if kind == 'mlp':
            sc = StandardScaler().fit(X)
            idx = np.arange(len(y)); pos = idx[y]; neg = idx[~y]
            bal = np.concatenate([neg, np.resize(pos, len(neg))]) if len(pos) else idx
            return (sc, MLPClassifier(hidden_layer_sizes=(16,), max_iter=60, early_stopping=True, random_state=0).fit(sc.transform(X[bal]), y[bal]))

    def score(model, X):
        sc, mdl = model
        return mdl.predict_proba(sc.transform(X) if sc is not None else X)[:, 1]

    XG = {g['id']: np.stack([move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    YG = {g['id']: np.array([label(m, S, L16) for m in g['moves_']]) for g in games}
    PG = {g['id']: np.stack([pos_vector(g, i, pf, S) for i in range(len(g['positions']))]) for g in games}

    def move_flags(gs, model, thr):
        flagged = set()
        for g in gs:
            for m, sc_ in zip(g['moves_'], score(model, XG[g['id']])):
                if sc_ >= thr:
                    flagged.add(m['fen_before']); flagged.add(m['fen_after'])
        return flagged

    def pos_flags(gs, model, thr):
        return {f for g in gs for f, sc_ in zip(g['positions'], score(model, PG[g['id']])) if sc_ >= thr}

    def pick_threshold(model, target, flags=None):
        """Highest threshold whose validation core recall reaches target (binary search over score quantiles)."""
        flags = flags or move_flags
        Xv = np.vstack([(XG if flags is move_flags else PG)[g['id']] for g in G['val']])
        qs = np.unique(np.quantile(score(model, Xv), np.linspace(0, 1, 801)))
        lo, hi, best = 0, len(qs) - 1, float(qs[0])
        while lo <= hi:
            mid = (lo + hi) // 2
            r = summary(simulate(G['val'], S, L16, flags(G['val'], model, qs[mid])))
            if r['recall1'] >= target:
                best, lo = float(qs[mid]), mid + 1
            else:
                hi = mid - 1
        return best

    results = {}
    def report(name, flagged_fn, meta=None):
        val = summary(simulate(G['val'], S, L16, flagged_fn(G['val'])))
        flagged = flagged_fn(G['test'])
        res = simulate(G['test'], S, L16, flagged)
        results[name] = dict(meta or {}, val=val, test=summary(res), ci=bootstrap(G['test'], S, L16, flagged),
                             fn=res['fn'][:300], fnByWhy=dict(_count(r for f in res['fn'] for r in f['why'])))
        t = results[name]['test']
        log(router=name, recall1=round(t['recall1'], 4), gb=round(t['recallGB'], 4), robust=round(t['recallRobust'], 4), recall2=round(t['recall2'], 4),
            shallow=round(t['shallowShare'], 4), nodes=round(t['nodesVsFull'], 3), wall=round(t['wallVsFull'], 3),
            miss1=t['miss1'], induced=t['induced1'])

    # Heuristics.
    moves_of = lambda gs: [m for g in gs for m in g['moves_']]
    report('allScreen', lambda gs: set())
    report('allDeep', lambda gs: {f for g in gs for f in g['positions']})
    for k_ in (0.5, 1, 2, 3, 5):
        report(f'tiered loss>={k_}', lambda gs, k_=k_: tiered_flags(moves_of(gs), S, k_), dict(kind='heuristic'))
    def unstable(r_thr):
        return lambda m: max(pf[m['fen_before']][FEAT.index('range8')], pf[m['fen_after']][FEAT.index('range8')]) >= r_thr
    for k_, r_thr in ((1, 3), (1, 5), (2, 3), (2, 5), (3, 3)):
        report(f'tiered loss>={k_} or range8>={r_thr}', lambda gs, k_=k_, r_thr=r_thr: tiered_flags(moves_of(gs), S, k_, unstable(r_thr)),
               dict(kind='heuristic'))

    # Learned move-level routers, plus a learning curve on the training games.
    exported, auc, models, learning = {}, {}, {}, []
    Xt = np.vstack([XG[g['id']] for g in G['test']]); yt = np.concatenate([YG[g['id']] for g in G['test']])
    for frac in (0.25, 0.5, 1.0):
        tr = G['train'][:max(1, int(len(G['train']) * frac))]
        X = np.vstack([XG[g['id']] for g in tr]); y = np.concatenate([YG[g['id']] for g in tr])
        log(train=dict(frac=frac, games=len(tr), moves=len(y), positives=int(y.sum())))
        for kind in ('logreg', 'tree', 'gbt', 'mlp'):
            if frac < 1 and kind in ('tree', 'mlp'):
                continue
            t1 = time.time()
            model = fit(kind, X, y)
            fit_s = time.time() - t1
            name = f'{kind} [{int(frac * 100)}% train]'
            for target in (0.99, 0.995):
                thr = pick_threshold(model, target)
                report(f'{name} @{target}', lambda gs, model=model, thr=thr: move_flags(gs, model, thr),
                       dict(kind=kind, trainGames=len(tr), target=target, threshold=thr, fitSeconds=round(fit_s, 1)))
                learning.append(dict(kind=kind, trainGames=len(tr), target=target, **{x: results[f'{name} @{target}']['test'][x]
                                     for x in ('recall1', 'shallowShare', 'nodesVsFull', 'wallVsFull')}))
            auc[name] = float(roc_auc_score(yt, score(model, Xt)))
            if frac == 1.0:
                exported[name] = export(kind, model, feat_names)
                models[name] = model

    # Position-level routers.
    Xp, yp = pos_table(moves_of(G['train']), pf, S, L16)
    log(positionTrain=dict(n=len(yp), pos=int(yp.sum())))
    for kind in ('logreg', 'gbt'):
        model = fit(kind, Xp, yp)
        for target in (0.99, 0.995):
            thr = pick_threshold(model, target, pos_flags)
            report(f'position-{kind} @{target}', lambda gs, model=model, thr=thr: pos_flags(gs, model, thr),
                   dict(kind='position-' + kind, target=target, threshold=thr))
        exported[f'position-{kind}'] = export(kind, model, [*FEAT, *POS_EXTRA])

    # Test-set curves (reported, never used for selection).
    curves = {}
    keys = ('recall1', 'recallGB', 'recallRobust', 'recall2', 'shallowShare', 'nodesVsFull', 'wallVsFull')
    for name in models:
        qs = np.quantile(score(models[name], Xt), np.linspace(0, 0.98, 50))
        curves[name] = []
        for q in qs:
            r = summary(simulate(G['test'], S, L16, move_flags(G['test'], models[name], q)))
            curves[name].append(dict(threshold=float(q), **{x: r[x] for x in keys}))
    curves['tiered loss'] = []
    for k_ in (0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7, 10):
        r = summary(simulate(G['test'], S, L16, tiered_flags(moves_of(G['test']), S, k_)))
        curves['tiered loss'].append(dict(threshold=k_, **{x: r[x] for x in keys}))

    (out / 'models.json').write_text(json.dumps(exported))
    sizes = {k_: len(json.dumps(v)) for k_, v in exported.items()}
    bench = subprocess.run(['node', str(HERE / 'infer-bench.mjs'), str(out / 'models.json'), str(find_input('whole-lite12.ndjson'))],
                           cwd=root, check=True, capture_output=True, text=True)
    infer = json.loads(bench.stdout.strip().splitlines()[-1])
    (out / 'RESULTS.json').write_text(json.dumps(dict(
        calibration=calib, labelRates=rates, features=feat_names, modelBytes=sizes, inference=infer,
        auc=auc, learning=learning, curves=curves, split={k_: len(v) for k_, v in G.items()}, routers=results), indent=1))
    log(done=True, inference=infer)


def _count(xs):
    c = defaultdict(int)
    for x in xs:
        c[x] += 1
    return c


def export(kind, model, names):
    sc, mdl = model
    scaler = None if sc is None else dict(mean=sc.mean_.tolist(), scale=sc.scale_.tolist())
    if kind == 'logreg':
        return dict(kind=kind, names=names, scaler=scaler, coef=mdl.coef_[0].tolist(), intercept=float(mdl.intercept_[0]))
    if kind == 'tree':
        t = mdl.tree_
        return dict(kind=kind, names=names, feature=t.feature.tolist(), threshold=t.threshold.tolist(),
                    left=t.children_left.tolist(), right=t.children_right.tolist(),
                    p=(t.value[:, 0, 1] / t.value[:, 0, :].sum(axis=1)).tolist())
    if kind == 'gbt':
        trees = []
        for (pred,) in mdl._predictors:
            n = pred.nodes
            trees.append(dict(feature=n['feature_idx'].tolist(), threshold=n['num_threshold'].tolist(), left=n['left'].tolist(),
                              right=n['right'].tolist(), leaf=n['is_leaf'].astype(int).tolist(), value=n['value'].tolist(),
                              missingLeft=n['missing_go_to_left'].astype(int).tolist()))
        return dict(kind=kind, names=names, baseline=float(np.ravel(mdl._baseline_prediction)[0]), trees=trees)
    if kind == 'mlp':
        return dict(kind=kind, names=names, scaler=scaler, weights=[w.tolist() for w in mdl.coefs_],
                    biases=[b.tolist() for b in mdl.intercepts_])


if __name__ == '__main__':
    main()
