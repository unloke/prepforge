"""Round 8 (PROTOCOL.md amendment 12): a router that does not chase best-status flips.

A best-status flip is a move that switches between Best and Excellent because two near-equal moves
swap places between depth 12 and depth 16. They are most of round 3's misses and most of its cost.
This router trains on core-without-best-status ∪ Great/Brilliant (round 3's move features, GBT small),
takes the highest validation threshold at which NB and GB recall are at least round 3's, then is scored
once against round 3 on dev-test and on the fresh holdout holdG..holdJ. The threshold is chosen on
validation only, so dev-test and holdout are both clean reads of the frozen router.

Whether best-status flips may be dropped is a product decision; this round only measures the price.

  python round8.py <code-root> <out>   (job.py round8, Kaggle only)
"""
import json, os, pathlib, subprocess, sys

sys.argv = [sys.argv[0], *sys.argv[1:3]]
os.environ.setdefault('ROUTER_SCREEN', 'lite12h')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import train as T  # noqa: E402
import holdout as H  # noqa: E402
import round2 as R2  # noqa: E402
import round4 as R4  # noqa: E402
import round6 as R6  # noqa: E402

GUARD = ('recallNoBest', 'recallGB')


def nb_label(m, S, D):
    fb, fa = m['fen_before'], m['fen_after']
    return bool(T.compare(m, S[fb], S[fa], D[fb], D[fa])[0] - {'bestStatus'}) or \
        bool(T.gb_free_flip(m, (S[fb], S[fa]), (D[fb], D[fa])))


def verdict(diff):
    out = {k: diff[k]['ci'][0] >= -0.01 for k in GUARD}
    out['faster'] = diff['wallVsFull']['ci'][1] < 0
    return out


def score(games, S, D, pf, model, thr, frozen3, models3):
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    n3 = frozen3['rule'][0][0]
    SC = {'nb': {g['id']: H.gbt_score(model, XG[g['id']]) for g in games},
          n3: {g['id']: H.gbt_score(models3[n3], XG[g['id']]) for g in games}}
    mine = lambda g: T.simulate([g], S, D, R2.flags([g], SC, [('nb', thr)]))
    r3 = lambda g: T.simulate([g], S, D, R2.flags([g], SC, [(n3, frozen3['rule'][0][1])]))
    router, ref, diff = R6.paired(games, mine, r3)
    return dict(router=H.pick(router), round3=H.pick(ref), diff=diff, passes=verdict(diff))


def main():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = R4.load_round3()
    n3 = frozen3['rule'][0][0]
    names = [f'b_{n}' for n in T.FEAT] + [f'a_{n}' for n in T.FEAT] + T.MOVE_EXTRA
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    y = np.concatenate([[nb_label(m, S, D) for m in g['moves_']] for g in G['train']])
    model = T.export('gbt', (None, R2.fit(np.vstack([XG[g['id']] for g in G['train']]), y, 'small')), names)
    SC = {'nb': {g['id']: H.gbt_score(model, XG[g['id']]) for g in G['val']},
          n3: {g['id']: H.gbt_score(models3[n3], XG[g['id']]) for g in G['val']}}
    r3val = H.combine([T.simulate([g], S, D, R2.flags([g], SC, [(n3, frozen3['rule'][0][1])])) for g in G['val']])
    qs = np.unique(np.quantile(np.concatenate([SC['nb'][g['id']] for g in G['val']]), np.linspace(0, 1, 2001)))
    lo, hi, best = 0, len(qs) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        r = H.combine([T.simulate([g], S, D, R2.flags([g], SC, [('nb', qs[mid])])) for g in G['val']])
        if all(r[k] >= r3val[k] for k in GUARD):
            best, lo = (float(qs[mid]), r), mid + 1
        else:
            hi = mid - 1
    thr = best[0]
    T.log(threshold=thr, val=H.pick(best[1]), round3Val=H.pick(r3val), trainMoves=len(y), positives=int(y.sum()))
    path = T.out / 'frozen8-model.json'
    path.write_text(json.dumps({'nb': model}))
    result = dict(threshold=thr, modelSha=H.sha(path), val=H.pick(best[1]), round3Val=H.pick(r3val),
                  devTest=score(G['test'], S, D, pf, model, thr, frozen3, models3))
    T.log(devTest=result['devTest'])

    S2, D2, hold, shard2 = T.load_shards(R4.FRESH)
    ids, seqs = {g['id'] for g in games}, {H.h_moves(g) for g in games}
    fresh = [g for g in hold if g['id'] not in ids and H.h_moves(g) not in seqs]
    result['holdoutGames'] = len(fresh)
    result['holdout'] = score(fresh, S2, D2, H.features(shard2), model, thr, frozen3, models3)
    T.log(holdout=result['holdout'])

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
    (T.out / 'ROUND8.json').write_text(json.dumps(result, indent=1))
    T.log(cost=result['cost'])


if __name__ == '__main__':
    main()
