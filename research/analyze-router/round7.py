"""Round 7 (PROTOCOL.md amendment 11): prune the round 3 router instead of replacing it.

Round 3 deepens both positions of every flagged move. Here a position keeps its deep read only if
round 3 flags it AND the round 4 position model (`pos-small` / `pos-big`) scores it at or above a
threshold, the lowest-cost one whose validation core, NB and GB recall all stay at round 3's.

  python round7.py dev  <code-root> <out>   fit, pick and freeze on the development games
  python round7.py eval <code-root> <out>   score the frozen router, round 3 and tiered1 once on holdG..holdJ

Per-game simulation (each game routed and pooled on its own, like the browser). Kaggle only.
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


def pruned(g, r3rule, MS, scores, thr):
    keep = {f for f, s in zip(g['positions'], scores) if s >= thr}
    return R4.rule_flags([g], r3rule, {}, MS) & keep


def dev():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = R4.load_round3()
    r3rule = [('move', n, t) for n, t in frozen3['rule']]
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    XP = {g['id']: R4.pos_rows(g, pf, S) for g in games}
    MS = R4.move_scores(G['val'] + G['test'], XG, models3)
    need = {g['id']: R4.needed(g, S, D, R4.missed_joint) for g in G['train']}
    Xtr = np.vstack([XP[g['id']] for g in G['train']])
    ytr = np.concatenate([[f in need[g['id']] for f in g['positions']] for g in G['train']])

    r3sim = lambda g: T.simulate([g], S, D, R4.rule_flags([g], r3rule, {}, MS))
    r3val = H.combine([r3sim(g) for g in G['val']])
    T.log(round3Val=H.pick(r3val))
    match3 = lambda r: all(r[k] >= r3val[k] for k in R6.KEYS)
    E, report = {}, {}
    for size in R2.GBT:
        name = f'prune-{size}'
        E[name] = T.export('gbt', (None, R2.fit(Xtr, ytr, size)), R4.names())
        PS = {g['id']: H.gbt_score(E[name], XP[g['id']]) for g in G['val'] + G['test']}
        qs = np.unique(np.quantile(np.concatenate([PS[g['id']] for g in G['val']]), np.linspace(0, 0.9, 1801)))
        lo, hi, best = 0, len(qs) - 1, None
        while lo <= hi:
            mid = (lo + hi) // 2
            r = H.combine([T.simulate([g], S, D, pruned(g, r3rule, MS, PS[g['id']], qs[mid])) for g in G['val']])
            if match3(r):
                best, lo = (float(qs[mid]), r), mid + 1
            else:
                hi = mid - 1
        if not best:
            T.log(candidate=name, found=False)
            continue
        thr = best[0]
        router, ref, diff = R6.paired(G['test'], lambda g: T.simulate([g], S, D, pruned(g, r3rule, MS, PS[g['id']], thr)), r3sim)
        report[name] = dict(threshold=thr, val=H.pick(best[1]), test=H.pick(router), round3Test=H.pick(ref), diff=diff,
                            passes=R6.verdict(diff))
        T.log(candidate=name, threshold=thr, val=H.pick(best[1]), test=H.pick(router), passes=report[name]['passes'],
              **{k: diff[k] for k in (*R6.KEYS, 'wallVsFull')})
    passing = [n for n, r in report.items() if all(r['passes'].values())]
    chosen = min(passing, key=lambda n: report[n]['test']['wallVsFull']) if passing else None
    result = dict(split={k: len(v) for k, v in G.items()}, round3Val=H.pick(r3val), candidates=report, chosen=chosen)
    (T.out / 'ROUND7-DEV.json').write_text(json.dumps(result, indent=1))
    T.log(chosen=chosen)
    if not chosen:
        return
    path = T.out / 'frozen7-models.json'
    path.write_text(json.dumps({chosen: E[chosen], **models3}))
    frozen = dict(router=chosen, threshold=report[chosen]['threshold'], round3Rule=frozen3['rule'], modelsSha=H.sha(path),
                  featuresSha=H.sha(T.HERE / 'features.mjs'), devGameIds=sorted(g['id'] for g in games),
                  devMoveSeqs=sorted({H.h_moves(g) for g in games}), dev=report[chosen])
    (T.out / 'frozen7.json').write_text(json.dumps(frozen, indent=1))


def evaluate():
    frozen = json.loads(T.find_input('frozen7.json').read_text())
    path = T.find_input('frozen7-models.json')
    assert H.sha(path) == frozen['modelsSha'], 'frozen models changed'
    assert H.sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    models = json.loads(path.read_text())
    frozen3, models3 = R4.load_round3()
    assert frozen3['rule'] == frozen['round3Rule'], 'round 3 rule changed'
    r3rule = [('move', n, t) for n, t in frozen3['rule']]

    S, D, games, shard_of = T.load_shards(R4.FRESH)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and H.h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), moves=sum(len(g['moves_']) for g in fresh)))
    pf = H.features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in fresh}
    MS = R4.move_scores(fresh, XG, models3)
    PS = {g['id']: H.gbt_score(models[frozen['router']], R4.pos_rows(g, pf, S)) for g in fresh}
    sim = lambda g: T.simulate([g], S, D, pruned(g, r3rule, MS, PS[g['id']], frozen['threshold']))
    router, ref, diff = R6.paired(fresh, sim, lambda g: T.simulate([g], S, D, R4.rule_flags([g], r3rule, {}, MS)))
    _, tiered, diff_t = R6.paired(fresh, sim, lambda g: T.simulate([g], S, D, H.tiered1([g], S)))
    T.log(router=H.pick(router), round3=H.pick(ref), tiered1=H.pick(tiered), diff=diff)

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
                share=(bench['featureUsPerPosition'] + model_us) / 1000 / screen_ms)
    decision = dict(R6.verdict(diff), browserCostUnder1Percent=cost['share'] < 0.01)
    decision['ship'] = all(decision.values())
    result = dict(frozen={k: frozen[k] for k in ('router', 'threshold', 'round3Rule', 'modelsSha', 'featuresSha')},
                  holdoutGames=len(fresh), router=router, round3=ref, tiered1=tiered, diffVsRound3=diff, diffVsTiered1=diff_t,
                  cost=cost, decision=decision)
    (T.out / 'HOLDOUT7.json').write_text(json.dumps(result, indent=1))
    T.log(cost=cost, decision=decision)


if __name__ == '__main__':
    {'dev': dev, 'eval': evaluate}[mode]()
