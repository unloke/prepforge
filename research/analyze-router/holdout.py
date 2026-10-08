"""Frozen GBT router against tiered1 on fresh games (PROTOCOL.md amendment 5).

  python holdout.py freeze <code-root> <out>   pick the threshold on the validation games, write frozen.json
  python holdout.py eval   <code-root> <out>   score the frozen router and tiered1 once on the fresh shards

Runs on Kaggle (job.py freeze|holdout), never locally.
"""
import hashlib, json, pathlib, random, subprocess, sys

if __name__ == '__main__':
    mode = sys.argv[1]
    sys.argv = [sys.argv[0], *sys.argv[2:4]]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import train as T  # noqa: E402

MODEL = 'gbt [100% train]'
TARGET = 0.90  # validation core recall the threshold must reach
HOLDOUT = ('holdA', 'holdB')
DEV_SPLIT = {'train': 1335, 'val': 334, 'test': 556}  # the train kernel's split; the freeze must match it
KEYS = ('recall1', 'recallNoBest', 'recallGB', 'recall2', 'shallowShare', 'nodesVsFull', 'wallVsFull')


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def gbt_score(m, X):
    """Python mirror of predict.mjs for an exported HistGradientBoosting model."""
    s = np.full(len(X), m['baseline'], dtype=np.float64)
    rows = np.arange(len(X))
    for t in m['trees']:
        feat, thr = np.array(t['feature']), np.array(t['threshold'])
        left, right, leaf, value = np.array(t['left']), np.array(t['right']), np.array(t['leaf'], bool), np.array(t['value'])
        node = np.zeros(len(X), dtype=np.int64)
        live = ~leaf[node]
        while live.any():
            i, n = rows[live], node[live]
            node[i] = np.where(X[i, feat[n]].astype(np.float64) <= thr[n], left[n], right[n])
            live = ~leaf[node]
        s += value[node]
    return 1 / (1 + np.exp(-s))


def features(shard_of):
    pf = {}
    for shard in sorted(set(shard_of.values())):
        pf.update(T.position_features(T.find_input(f'{shard}-lite12.ndjson')))
    return pf


def router_flags(games, XG, model, thr):
    flagged = set()
    for g in games:
        for m, sc in zip(g['moves_'], gbt_score(model, XG[g['id']])):
            if sc >= thr:
                flagged.add(m['fen_before']); flagged.add(m['fen_after'])
    return flagged


def tiered1(games, S):
    return T.tiered_flags([m for g in games for m in g['moves_']], S, 1.0)


def pick_threshold(val, S, L16, XG, model):
    """Highest threshold whose validation core recall reaches TARGET (binary search over score quantiles)."""
    scores = np.concatenate([gbt_score(model, XG[g['id']]) for g in val])
    qs = np.unique(np.quantile(scores, np.linspace(0, 1, 2001)))
    lo, hi, best = 0, len(qs) - 1, float(qs[0])
    while lo <= hi:
        mid = (lo + hi) // 2
        if T.summary(T.simulate(val, S, L16, router_flags(val, XG, model, qs[mid])))['recall1'] >= TARGET:
            best, lo = float(qs[mid]), mid + 1
        else:
            hi = mid - 1
    return best


def pick(r):
    return {k: r[k] for k in KEYS}


def combine(parts):
    tot = {k: sum(p[k] for p in parts) for k, v in parts[0].items() if isinstance(v, (int, float))}
    return T.summary(dict(tot, fn=[]))


def paired(games, S, L16, fa, fb, n=2000, seed=11):
    """Per-game simulation of routers a and b, then a game bootstrap of (a - b) for each metric."""
    A = [T.simulate([g], S, L16, fa) for g in games]
    B = [T.simulate([g], S, L16, fb) for g in games]
    rng = random.Random(seed)
    diffs = {k: [] for k in KEYS}
    for _ in range(n):
        idx = [rng.randrange(len(games)) for _ in games]
        ra, rb = combine([A[i] for i in idx]), combine([B[i] for i in idx])
        for k in KEYS:
            diffs[k].append(ra[k] - rb[k])
    a, b = combine(A), combine(B)
    return a, b, {k: dict(diff=a[k] - b[k], ci=[float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]) for k, v in diffs.items()}


def freeze():
    S, L16, games, shard_of = T.load_shards(T.SHARDS)
    G = T.split_games(games)
    sizes = {k: len(v) for k, v in G.items()}
    T.log(split=sizes)
    assert sizes == DEV_SPLIT, f'split differs from the train kernel: {sizes}'
    pf = features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in G['val'] + G['test']}
    model = json.loads(T.find_input('models.json').read_text())[MODEL]

    # The browser runs predict.mjs: check the Python mirror against it on validation rows.
    rows = np.vstack([XG[g['id']] for g in G['val']])[:3000].astype(np.float64)
    tmp = pathlib.Path('/tmp/parity'); tmp.mkdir(exist_ok=True)
    (tmp / 'model.json').write_text(json.dumps(model)); (tmp / 'rows.json').write_text(json.dumps(rows.tolist()))
    js = np.array(json.loads(subprocess.run(['node', str(T.HERE / 'predict.mjs'), str(tmp / 'model.json'), str(tmp / 'rows.json')],
                                            cwd=T.root, check=True, capture_output=True, text=True).stdout))
    parity = float(np.max(np.abs(js - gbt_score(model, rows))))
    T.log(parity=parity)
    assert parity < 1e-9, 'Python and JS scores differ'

    thr = pick_threshold(G['val'], S, L16, XG, model)
    report = {}
    for part in ('val', 'test'):
        gs = G[part]
        report[part] = dict(router=pick(T.summary(T.simulate(gs, S, L16, router_flags(gs, XG, model, thr)))),
                            tiered1=pick(T.summary(T.simulate(gs, S, L16, tiered1(gs, S)))))
    model_path = T.out / 'frozen-model.json'
    model_path.write_text(json.dumps(model))
    frozen = dict(model=MODEL, target=TARGET, threshold=thr, modelSha=sha(model_path),
                  featuresSha=sha(T.HERE / 'features.mjs'), predictSha=sha(T.HERE / 'predict.mjs'),
                  devGameIds=sorted(g['id'] for g in games), devMoveSeqs=sorted({h_moves(g) for g in games}),
                  split=sizes, report=report)
    (T.out / 'frozen.json').write_text(json.dumps(frozen, indent=1))
    T.log(frozen={k: v for k, v in frozen.items() if k not in ('devGameIds', 'devMoveSeqs')})


def h_moves(g):
    return hashlib.sha256(' '.join(g['moves']).encode()).hexdigest()


def evaluate():
    frozen = json.loads(T.find_input('frozen.json').read_text())
    model_path = T.find_input('frozen-model.json')
    assert sha(model_path) == frozen['modelSha'], 'frozen model changed'
    assert sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    assert sha(T.HERE / 'predict.mjs') == frozen['predictSha'], 'predict code changed since the freeze'
    model, thr = json.loads(model_path.read_text()), frozen['threshold']

    S, L16, games, shard_of = T.load_shards(HOLDOUT)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), droppedAsSeen=len(games) - len(fresh),
                       moves=sum(len(g['moves_']) for g in fresh), positions=sum(len(g['positions']) for g in fresh)))
    pf = features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in fresh}
    router, base, diff = paired(fresh, S, L16, router_flags(fresh, XG, model, thr), tiered1(fresh, S))
    T.log(router=pick(router), tiered1=pick(base), diff=diff)

    # Browser cost on this machine: one fresh screen read per position (1 worker) against
    # features + one model call.
    fens = [f for g in fresh for f in g['positions']][:400]
    tmp = pathlib.Path('/tmp/cost'); tmp.mkdir(exist_ok=True)
    (tmp / 'fens.txt').write_text('\n'.join(fens) + '\n')
    subprocess.run(['node', str(T.HERE / 'engine-runs.mjs'), str(tmp / 'fens.txt'), str(tmp / 'screen.ndjson'), '--engine', 'lite',
                    '--depth', '12', '--nodes', '1500000', '--hash', '16', '--workers', '1'], cwd=T.root, check=True)
    screen_ms = float(np.mean([json.loads(l)['ms'] for l in (tmp / 'screen.ndjson').read_text().splitlines() if l]))
    (tmp / 'models.json').write_text(json.dumps({MODEL: model}))
    bench = json.loads(subprocess.run(['node', str(T.HERE / 'infer-bench.mjs'), str(tmp / 'models.json'), str(tmp / 'screen.ndjson'), '400'],
                                      cwd=T.root, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1])
    cost_us = bench['featureUsPerPosition'] + bench['models'][MODEL]['usPerCall']
    cost = dict(screenMsPerPosition=screen_ms, featureUs=bench['featureUsPerPosition'], modelUs=bench['models'][MODEL]['usPerCall'],
                modelBytes=bench['models'][MODEL]['bytes'], share=cost_us / 1000 / screen_ms)

    decision = dict(
        coreRecallBetter=diff['recall1']['ci'][0] > 0,
        notSlower=router['wallVsFull'] <= base['wallVsFull'],
        greatBrilliantNotWorse=diff['recallGB']['ci'][0] >= -0.01,
        browserCostUnder1Percent=cost['share'] < 0.01)
    decision['ship'] = all(decision.values())
    result = dict(frozen={k: frozen[k] for k in ('model', 'target', 'threshold', 'modelSha', 'featuresSha', 'predictSha')},
                  holdoutGames=len(fresh), router=router, tiered1=base, diff=diff, cost=cost, decision=decision)
    (T.out / 'HOLDOUT.json').write_text(json.dumps(result, indent=1))
    T.log(cost=cost, decision=decision)


if __name__ == '__main__':
    {'freeze': freeze, 'eval': evaluate}[mode]()
