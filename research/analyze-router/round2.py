"""Round 2 (PROTOCOL.md amendment 6): a router that also guards the Great/Brilliant check.

  python round2.py dev  <code-root> <out>   fit the candidates on the development games, pick one by the
                                            frozen rule, write frozen2.json + frozen2-models.json
  python round2.py eval <code-root> <out>   score the frozen router and tiered1 once on holdC..holdF

Runs on Kaggle (job.py round2|holdout2), never locally.
"""
import json, os, pathlib, subprocess, sys, time

if __name__ == '__main__':
    mode = sys.argv[1]
    sys.argv = [sys.argv[0], *sys.argv[2:4]]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402

import train as T  # noqa: E402
import holdout as H  # noqa: E402

DEV = ('whole', 'gamesA', 'gamesB', 'holdA', 'holdB')  # holdA/holdB were read once in amendment 5: development now
FRESH = ('holdC', 'holdD', 'holdE', 'holdF')
CORE_MIN = 0.85     # validation core recall floor (tiered1 is ~0.76)
GB_MARGIN = 0.01    # validation Great/Brilliant recall must beat tiered1 by this much
WALL_MARGIN = 0.005  # dev-test wall must be this far under tiered1 to be selected
# Output names: round 2 (fresh-hash screen reads) or round 3 (carried hash, amendment 7, same procedure).
R = os.environ.get('ROUTER_ROUND', '2')
GBT = {'small': dict(max_iter=60, max_depth=3, learning_rate=0.1), 'big': dict(max_iter=200, max_depth=4, learning_rate=0.05)}


def split(games):
    """Fresh hash split of all development games: 60% train, 15% validation, 25% test."""
    rank = sorted(games, key=lambda g: T.h('router2:' + g['id']))
    n = len(rank)
    part = {g['id']: 'train' if i < 0.60 * n else 'val' if i < 0.75 * n else 'test' for i, g in enumerate(rank)}
    return {p: [g for g in games if part[g['id']] == p] for p in ('train', 'val', 'test')}


def fit(X, y, size):
    w = np.where(y, (len(y) - y.sum()) / max(1, y.sum()), 1.0)
    return HistGradientBoostingClassifier(random_state=0, **GBT[size]).fit(X, y, sample_weight=w)


def flags(games, SC, rule):
    """Deepen both positions of a move when any (model, threshold) in the rule fires."""
    out = set()
    for g in games:
        hit = np.zeros(len(g['moves_']), bool)
        for name, thr in rule:
            hit |= SC[name][g['id']] >= thr
        for m, x in zip(g['moves_'], hit):
            if x:
                out.add(m['fen_before']); out.add(m['fen_after'])
    return out


def ok(r, base, core_min, gb_margin):
    return r['recall1'] >= core_min and r['recallGB'] >= base['recallGB'] + gb_margin


def search(val, S, D, SC, name, pred, fixed=()):
    """Highest threshold for `name` (with `fixed` rules OR'd in) whose validation summary satisfies pred."""
    scores = np.concatenate([SC[name][g['id']] for g in val])
    qs = np.unique(np.quantile(scores, np.linspace(0, 1, 2001)))
    lo, hi, best = 0, len(qs) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        r = T.summary(T.simulate(val, S, D, flags(val, SC, [*fixed, (name, qs[mid])])))
        if pred(r):
            best, lo = (float(qs[mid]), r), mid + 1
        else:
            hi = mid - 1
    return best


def dev():
    S, D, games, shard_of = T.load_shards(DEV)
    G = split(games)
    T.log(devGames=len(games), split={k: len(v) for k, v in G.items()}, byShard=dict(T._count(shard_of[g['id']] for g in games)))
    pf = H.features(shard_of)
    names = [f'b_{n}' for n in T.FEAT] + [f'a_{n}' for n in T.FEAT] + T.MOVE_EXTRA
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    core = lambda m: bool(T.compare(m, S[m['fen_before']], S[m['fen_after']], D[m['fen_before']], D[m['fen_after']])[0])
    gbf = lambda m: bool(T.gb_free_flip(m, (S[m['fen_before']], S[m['fen_after']]), (D[m['fen_before']], D[m['fen_after']])))
    YC = {g['id']: np.array([core(m) for m in g['moves_']]) for g in games}
    YG = {g['id']: np.array([gbf(m) for m in g['moves_']]) for g in games}
    Xtr = np.vstack([XG[g['id']] for g in G['train']])
    yc, yg = (np.concatenate([Y[g['id']] for g in G['train']]) for Y in (YC, YG))
    T.log(train=dict(moves=len(yc), core=int(yc.sum()), gb=int(yg.sum()), joint=int((yc | yg).sum())))

    models = {}
    for label, y in (('core', yc), ('gb', yg), ('joint', yc | yg)):
        for size in GBT:
            t0 = time.time()
            models[f'{label}-{size}'] = fit(Xtr, y, size)
            T.log(fit=f'{label}-{size}', seconds=round(time.time() - t0, 1))
    E = {k: T.export('gbt', (None, m), names) for k, m in models.items()}
    SC = {k: {g['id']: H.gbt_score(e, XG[g['id']]) for g in G['val'] + G['test']} for k, e in E.items()}

    base = {p: T.summary(T.simulate(G[p], S, D, H.tiered1(G[p], S))) for p in ('val', 'test')}
    T.log(tiered1={p: H.pick(r) for p, r in base.items()})
    guard = lambda r: ok(r, base['val'], CORE_MIN, GB_MARGIN)
    rules = {}
    # Round 1's recipe on the new split, for reference.
    v1 = search(G['val'], S, D, SC, 'core-small', lambda r: r['recall1'] >= 0.90)
    rules['v1'] = [('core-small', v1[0])]
    for name in ('core-small', 'core-big', 'joint-small', 'joint-big'):
        hit = search(G['val'], S, D, SC, name, guard)
        if hit:
            rules[f'{name}+guard'] = [(name, hit[0])]
    # Two models: a core router plus a Great/Brilliant router. For each gb threshold (quantiles of its
    # validation scores), the highest core threshold meeting the guard; keep the cheapest on validation.
    for size in GBT:
        gscores = np.concatenate([SC[f'gb-{size}'][g['id']] for g in G['val']])
        best = None
        for q in np.unique(np.quantile(gscores, np.linspace(0.5, 0.995, 25))):
            fixed = [(f'gb-{size}', float(q))]
            hit = search(G['val'], S, D, SC, f'core-{size}', guard, fixed)
            if hit and (best is None or hit[1]['wallVsFull'] < best[1]['wallVsFull']):
                best = ([(f'core-{size}', hit[0]), *fixed], hit[1])
        if best:
            rules[f'two-{size}'] = best[0]

    report = {}
    for name, rule in rules.items():
        val = T.summary(T.simulate(G['val'], S, D, flags(G['val'], SC, rule)))
        router, tiered, diff = H.paired(G['test'], S, D, flags(G['test'], SC, rule), H.tiered1(G['test'], S))
        report[name] = dict(rule=rule, val=H.pick(val), test=H.pick(router), tiered1Test=H.pick(tiered), diff=diff,
                            passes=dict(core=diff['recall1']['ci'][0] > 0, wall=router['wallVsFull'] <= tiered['wallVsFull'] - WALL_MARGIN,
                                        gb=diff['recallGB']['ci'][0] >= -0.01))
        T.log(candidate=name, rule=rule, val=H.pick(val), test=H.pick(router), passes=report[name]['passes'],
              gbDiff=diff['recallGB'], wallDiff=diff['wallVsFull'])

    # Frozen selection: among candidates passing all three on dev-test, the highest Great/Brilliant CI
    # lower bound, then the lowest wall.
    passing = [n for n, r in report.items() if all(r['passes'].values())]
    chosen = max(passing, key=lambda n: (report[n]['diff']['recallGB']['ci'][0], -report[n]['test']['wallVsFull'])) if passing else None
    result = dict(constants=dict(CORE_MIN=CORE_MIN, GB_MARGIN=GB_MARGIN, WALL_MARGIN=WALL_MARGIN, GBT=GBT),
                  split={k: len(v) for k, v in G.items()}, tiered1=base, candidates=report, chosen=chosen)
    (T.out / f'ROUND{R}-DEV.json').write_text(json.dumps(result, indent=1))
    T.log(chosen=chosen)
    if not chosen:
        return
    rule = report[chosen]['rule']
    exported = {n: E[n] for n, _ in rule}
    path = T.out / f'frozen{R}-models.json'
    path.write_text(json.dumps(exported))
    frozen = dict(router=chosen, rule=rule, modelsSha=H.sha(path), featuresSha=H.sha(T.HERE / 'features.mjs'),
                  predictSha=H.sha(T.HERE / 'predict.mjs'), devGameIds=sorted(g['id'] for g in games),
                  devMoveSeqs=sorted({H.h_moves(g) for g in games}), dev=report[chosen])
    (T.out / f'frozen{R}.json').write_text(json.dumps(frozen, indent=1))
    T.log(frozen={k: v for k, v in frozen.items() if k not in ('devGameIds', 'devMoveSeqs')})


def evaluate():
    frozen = json.loads(T.find_input(f'frozen{R}.json').read_text())
    path = T.find_input(f'frozen{R}-models.json')
    assert H.sha(path) == frozen['modelsSha'], 'frozen models changed'
    assert H.sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    assert H.sha(T.HERE / 'predict.mjs') == frozen['predictSha'], 'predict code changed since the freeze'
    exported = json.loads(path.read_text())

    S, D, games, shard_of = T.load_shards(FRESH)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and H.h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), droppedAsSeen=len(games) - len(fresh),
                       moves=sum(len(g['moves_']) for g in fresh)))
    pf = H.features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in fresh}
    SC = {n: {g['id']: H.gbt_score(m, XG[g['id']]) for g in fresh} for n, m in exported.items()}
    router, base, diff = H.paired(fresh, S, D, flags(fresh, SC, frozen['rule']), H.tiered1(fresh, S))
    T.log(router=H.pick(router), tiered1=H.pick(base), diff=diff)

    # Browser cost: features + one call per model, against one fresh single-worker screen read.
    fens = [f for g in fresh for f in g['positions']][:400]
    tmp = pathlib.Path('/tmp/cost'); tmp.mkdir(exist_ok=True)
    (tmp / 'fens.txt').write_text('\n'.join(fens) + '\n')
    subprocess.run(['node', str(T.HERE / 'engine-runs.mjs'), str(tmp / 'fens.txt'), str(tmp / 'screen.ndjson'), '--engine', 'lite',
                    '--depth', '12', '--nodes', '1500000', '--hash', '16', '--workers', '1'], cwd=T.root, check=True)
    screen_ms = float(np.mean([json.loads(l)['ms'] for l in (tmp / 'screen.ndjson').read_text().splitlines() if l]))
    bench = json.loads(subprocess.run(['node', str(T.HERE / 'infer-bench.mjs'), str(path), str(tmp / 'screen.ndjson'), '400'],
                                      cwd=T.root, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1])
    model_us = sum(v['usPerCall'] for v in bench['models'].values())
    cost = dict(screenMsPerPosition=screen_ms, featureUs=bench['featureUsPerPosition'], modelUs=model_us,
                modelBytes=sum(v['bytes'] for v in bench['models'].values()),
                share=(bench['featureUsPerPosition'] + model_us) / 1000 / screen_ms)

    decision = dict(
        coreRecallBetter=diff['recall1']['ci'][0] > 0,
        notSlower=router['wallVsFull'] <= base['wallVsFull'],
        greatBrilliantNotWorse=diff['recallGB']['ci'][0] >= -0.01,
        browserCostUnder1Percent=cost['share'] < 0.01)
    decision['ship'] = all(decision.values())
    result = dict(frozen={k: frozen[k] for k in ('router', 'rule', 'modelsSha', 'featuresSha', 'predictSha')},
                  holdoutGames=len(fresh), router=router, tiered1=base, diff=diff, cost=cost, decision=decision)
    (T.out / f'HOLDOUT{R}.json').write_text(json.dumps(result, indent=1))
    T.log(cost=cost, decision=decision)


if __name__ == '__main__':
    {'dev': dev, 'eval': evaluate}[mode]()
