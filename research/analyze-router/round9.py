"""Round 9 (PROTOCOL.md amendment 13): a faster router that keeps the visible grades.

The round 8 router (core-without-best-status ∪ Great/Brilliant label, round 3's move features, GBT
small) at a lower operating point: the highest validation threshold at which recall without
best-status flips (NB) stays at least round 3's and Great/Brilliant recall at least tiered1's (the
pre-router production rule). Best/Excellent swaps between near-equal moves are left to the screen read.

  python round9.py dev  <code-root> <out>   fit and freeze on the development games (validation only),
                                            report dev-test
  python round9.py eval <code-root> <out>   score the frozen router once on holdK..holdN

Per-game simulation. Kaggle only (job.py round9|holdout9).
"""
import json, os, pathlib, subprocess, sys

if __name__ == '__main__':
    mode = sys.argv[1]
    sys.argv = [sys.argv[0], *sys.argv[2:4]]
os.environ.setdefault('ROUTER_SCREEN', 'lite12h')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import train as T  # noqa: E402
import holdout as H  # noqa: E402
import round2 as R2  # noqa: E402
import round4 as R4  # noqa: E402
import round6 as R6  # noqa: E402
import round8 as R8  # noqa: E402

FRESH = ('holdK', 'holdL', 'holdM', 'holdN')


def arms(games, S, D, pf, model, thr, frozen3, models3):
    """Per-game simulators: this router, round 3 and tiered1."""
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    n3, t3 = frozen3['rule'][0]
    SC = {'nb': {g['id']: H.gbt_score(model, XG[g['id']]) for g in games},
          n3: {g['id']: H.gbt_score(models3[n3], XG[g['id']]) for g in games}}
    return (lambda g: T.simulate([g], S, D, R2.flags([g], SC, [('nb', thr)])),
            lambda g: T.simulate([g], S, D, R2.flags([g], SC, [(n3, t3)])),
            lambda g: T.simulate([g], S, D, H.tiered1([g], S)))


def report(games, sims):
    mine, r3, t1 = sims
    router, ref, diff3 = R6.paired(games, mine, r3)
    _, tiered, diff1 = R6.paired(games, mine, t1)
    decision = dict(nbNotWorseThanRound3=diff3['recallNoBest']['ci'][0] >= -0.01,
                    gbNotWorseThanTiered1=diff1['recallGB']['ci'][0] >= -0.01,
                    fasterThanRound3By5Percent=diff3['wallVsFull']['ci'][1] < -0.05)
    return dict(router=H.pick(router), round3=H.pick(ref), tiered1=H.pick(tiered), diffVsRound3=diff3,
                diffVsTiered1=diff1, decision=decision)


def dev():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = R4.load_round3()
    names = [f'b_{n}' for n in T.FEAT] + [f'a_{n}' for n in T.FEAT] + T.MOVE_EXTRA
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in G['train']}
    y = np.concatenate([[R8.nb_label(m, S, D) for m in g['moves_']] for g in G['train']])
    model = T.export('gbt', (None, R2.fit(np.vstack([XG[g['id']] for g in G['train']]), y, 'small')), names)

    val = G['val']
    XV = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in val}
    n3, t3 = frozen3['rule'][0]
    SC = {'nb': {g['id']: H.gbt_score(model, XV[g['id']]) for g in val},
          n3: {g['id']: H.gbt_score(models3[n3], XV[g['id']]) for g in val}}
    r3val = H.combine([T.simulate([g], S, D, R2.flags([g], SC, [(n3, t3)])) for g in val])
    t1val = H.combine([T.simulate([g], S, D, H.tiered1([g], S)) for g in val])
    ok = lambda r: r['recallNoBest'] >= r3val['recallNoBest'] and r['recallGB'] >= t1val['recallGB']
    qs = np.unique(np.quantile(np.concatenate([SC['nb'][g['id']] for g in val]), np.linspace(0, 1, 2001)))
    lo, hi, best = 0, len(qs) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        r = H.combine([T.simulate([g], S, D, R2.flags([g], SC, [('nb', qs[mid])])) for g in val])
        if ok(r):
            best, lo = (float(qs[mid]), r), mid + 1
        else:
            hi = mid - 1
    thr = best[0]
    path = T.out / 'frozen9-model.json'
    path.write_text(json.dumps({'nb': model}))
    test = report(G['test'], arms(G['test'], S, D, pf, model, thr, frozen3, models3))
    frozen = dict(threshold=thr, modelSha=H.sha(path), featuresSha=H.sha(T.HERE / 'features.mjs'),
                  val=H.pick(best[1]), round3Val=H.pick(r3val), tiered1Val=H.pick(t1val), devTest=test,
                  devGameIds=sorted(g['id'] for g in games), devMoveSeqs=sorted({H.h_moves(g) for g in games}))
    (T.out / 'frozen9.json').write_text(json.dumps(frozen, indent=1))
    T.log(threshold=thr, val=H.pick(best[1]), devTest={k: test[k] for k in ('router', 'round3', 'tiered1', 'decision')})


def evaluate():
    frozen = json.loads(T.find_input('frozen9.json').read_text())
    path = T.find_input('frozen9-model.json')
    assert H.sha(path) == frozen['modelSha'], 'frozen model changed'
    assert H.sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    model = json.loads(path.read_text())['nb']
    frozen3, models3 = R4.load_round3()
    S, D, games, shard_of = T.load_shards(FRESH)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and H.h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), moves=sum(len(g['moves_']) for g in fresh)))
    result = report(fresh, arms(fresh, S, D, H.features(shard_of), model, frozen['threshold'], frozen3, models3))

    fens = [f for g in fresh for f in g['positions']][:400]
    tmp = pathlib.Path('/tmp/cost'); tmp.mkdir(exist_ok=True)
    (tmp / 'fens.txt').write_text('\n'.join(fens) + '\n')
    subprocess.run(['node', str(T.HERE / 'engine-runs.mjs'), str(tmp / 'fens.txt'), str(tmp / 'screen.ndjson'), '--engine', 'lite',
                    '--depth', '12', '--nodes', '1500000', '--hash', '16', '--workers', '1'], cwd=T.root, check=True)
    screen_ms = float(np.mean([json.loads(l)['ms'] for l in (tmp / 'screen.ndjson').read_text().splitlines() if l]))
    bench = json.loads(subprocess.run(['node', str(T.HERE / 'infer-bench.mjs'), str(path), str(tmp / 'screen.ndjson'), '400'],
                                      cwd=T.root, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1])
    model_us = sum(v['usPerCall'] for v in bench['models'].values())
    result['cost'] = dict(screenMsPerPosition=screen_ms, featureUs=bench['featureUsPerPosition'], modelUs=model_us,
                          share=(bench['featureUsPerPosition'] + model_us) / 1000 / screen_ms)
    result['decision']['browserCostUnder1Percent'] = result['cost']['share'] < 0.01
    result['decision']['ship'] = all(result['decision'].values())
    result.update(holdoutGames=len(fresh), threshold=frozen['threshold'], modelSha=frozen['modelSha'])
    (T.out / 'HOLDOUT9.json').write_text(json.dumps(result, indent=1))
    T.log(holdout9={k: result[k] for k in ('router', 'round3', 'tiered1', 'decision', 'cost')})


if __name__ == '__main__':
    {'dev': dev, 'eval': evaluate}[mode]()
