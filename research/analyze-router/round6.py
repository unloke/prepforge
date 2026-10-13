"""Round 6 (PROTOCOL.md amendment 10): deepen in two waves.

Wave 1 deepens the positions the round 4 position router (`pos-big`) is most sure about. Wave 2 scores
the rest again, now also seeing what wave 1's deep reads changed next door: neighbouring positions lie
on the same line, so a neighbour whose read moved at depth 16 marks this one as unstable too.

  python round6.py dev  <code-root> <out>   fit wave 2 models on the development games, freeze one
  python round6.py eval <code-root> <out>   score the frozen router, round 3 and tiered1 once on holdG..holdJ

Runs on Kaggle (job.py round6|holdout6) with the carried-hash screen reads, never locally.
"""
import json, os, pathlib, random, subprocess, sys

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

WAVE1_SHARES = (0.10, 0.20, 0.30, 0.40)  # share of validation positions wave 1 deepens
MARGIN = 0.01
KEYS = ('recall1', 'recallNoBest', 'recallGB')


def wave_extra(g, i, S, D, W1):
    """What wave 1 already knows around position i: each neighbour's deep change and each adjacent
    move's output change under the reads known after wave 1."""
    P, M = g['positions'], g['moves_']
    F = R4.reads(S, D, W1)
    ex = []
    for j in (i - 1, i + 1):
        n = P[j] if 0 <= j < len(P) else None
        known = n is not None and n in W1
        ex += [float(known), D[n]['w'] - S[n]['w'] if known else 0.0,
               float(known and D[n]['best'] != S[n]['best']),
               float(known and T.mate_state(D[n]) != T.mate_state(S[n]))]
    for m in (M[i - 1] if i > 0 else None, M[i] if i < len(M) else None):
        if m is None:
            ex += [0.0, 0.0, 0.0]
            continue
        fb, fa = m['fen_before'], m['fen_after']
        ex += [float(bool(T.compare(m, F(fb), F(fa), S[fb], S[fa])[0])),
               float(bool(T.gb_free_flip(m, (F(fb), F(fa)), (S[fb], S[fa])))),
               T.grade(m, F(fb), F(fa))[1] - T.grade(m, S[fb], S[fa])[1]]
    return ex


WAVE_EXTRA = [f'{side}_{k}' for side in ('prev', 'next') for k in ('known', 'dW', 'bestChanged', 'mateChanged')] + \
             [f'{side}_{k}' for side in ('in', 'out') for k in ('outputChanged', 'gbChanged', 'lossShift')]


def wave_rows(g, base_rows, S, D, W1):
    return np.hstack([base_rows, np.array([wave_extra(g, i, S, D, W1) for i in range(len(g['positions']))], np.float32)])


def needed_after(g, S, D, base):
    """Positions a still-missed critical move needs, given the deep reads in `base` (amendment 8 rule)."""
    need = set()
    for m in g['moves_']:
        fb, fa = m['fen_before'], m['fen_after']
        if not R4.missed_joint(m, R4.reads(S, D, base), D):
            continue
        b_alone = not R4.missed_joint(m, R4.reads(S, D, base | {fb}), D)
        a_alone = not R4.missed_joint(m, R4.reads(S, D, base | {fa}), D)
        if not b_alone:
            need.add(fa)
        if not a_alone:
            need.add(fb)
        if b_alone and a_alone:
            need.add(fb if abs(S[fb]['w'] - D[fb]['w']) >= abs(S[fa]['w'] - D[fa]['w']) else fa)
    return need - base


def simulate2(games, S, D, W1, W2):
    """T.simulate with a barrier between the waves: each game's deep time is wave 1's pool wall plus wave 2's."""
    res = T.simulate(games, S, D, W1 | W2)
    res['deep_ms'] = sum(T.pool_wall([D[f]['ms'] for f in g['positions'] if f in W1]) +
                         T.pool_wall([D[f]['ms'] for f in g['positions'] if f in W2 and f not in W1]) for g in games)
    return res


def paired(games, sim_a, sim_b, n=2000, seed=11):
    """H.paired for arbitrary per-game simulators."""
    A, B = [sim_a(g) for g in games], [sim_b(g) for g in games]
    rng = random.Random(seed)
    diffs = {k: [] for k in H.KEYS}
    for _ in range(n):
        idx = [rng.randrange(len(games)) for _ in games]
        ra, rb = H.combine([A[i] for i in idx]), H.combine([B[i] for i in idx])
        for k in H.KEYS:
            diffs[k].append(ra[k] - rb[k])
    a, b = H.combine(A), H.combine(B)
    return a, b, {k: dict(diff=a[k] - b[k], ci=[float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]) for k, v in diffs.items()}


def verdict(diff):
    out = {k: diff[k]['ci'][0] >= -MARGIN for k in KEYS}
    out['faster'] = diff['wallVsFull']['ci'][1] < 0
    return out


def flags_at(games, scores, thr, exclude=frozenset()):
    return {f for g in games for f, s in zip(g['positions'], scores[g['id']]) if s >= thr and f not in exclude}


def dev():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = R4.load_round3()
    r3rule = [('move', n, t) for n, t in frozen3['rule']]
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    XP = {g['id']: R4.pos_rows(g, pf, S) for g in games}
    MS = R4.move_scores(G['val'] + G['test'], XG, models3)

    # Wave 1 model: pos-big on all training games; training-game scores are cross-fitted (two halves)
    # so wave 2 learns from wave 1 decisions as unbiased as on new games.
    need = {g['id']: R4.needed(g, S, D, R4.missed_joint) for g in G['train']}
    y = lambda gs: np.concatenate([[f in need[g['id']] for f in g['positions']] for g in gs])
    X = lambda gs: np.vstack([XP[g['id']] for g in gs])
    wave1 = T.export('gbt', (None, R2.fit(X(G['train']), y(G['train']), 'big')), R4.names())
    P1 = {g['id']: H.gbt_score(wave1, XP[g['id']]) for g in G['val'] + G['test']}
    half = [G['train'][0::2], G['train'][1::2]]
    for k in (0, 1):
        m = T.export('gbt', (None, R2.fit(X(half[1 - k]), y(half[1 - k]), 'big')), R4.names())
        P1.update({g['id']: H.gbt_score(m, XP[g['id']]) for g in half[k]})

    r3val = T.summary(T.simulate(G['val'], S, D, R4.rule_flags(G['val'], r3rule, {}, MS)))
    T.log(round3Val=H.pick(r3val))
    match3 = lambda r: all(r[k] >= r3val[k] for k in KEYS)
    val_scores = np.concatenate([P1[g['id']] for g in G['val']])
    E, cands = {'wave1': wave1}, {}
    for share in WAVE1_SHARES:
        t1 = float(np.quantile(val_scores, 1 - share))
        W1 = {g['id']: flags_at([g], P1, t1) for g in games}
        XW = {g['id']: wave_rows(g, XP[g['id']], S, D, W1[g['id']]) for g in games}
        rows, labels = [], []
        for g in G['train']:
            n2 = needed_after(g, S, D, W1[g['id']])
            keep = [i for i, f in enumerate(g['positions']) if f not in W1[g['id']]]
            rows.append(XW[g['id']][keep]); labels.append([g['positions'][i] in n2 for i in keep])
        ytr = np.concatenate(labels)
        name = f'wave2-{int(share * 100)}'
        E[name] = T.export('gbt', (None, R2.fit(np.vstack(rows), ytr, 'big')), R4.names() + WAVE_EXTRA)
        P2 = {g['id']: H.gbt_score(E[name], XW[g['id']]) for g in G['val'] + G['test']}
        T.log(wave1Share=share, t1=t1, wave2Rows=len(ytr), wave2Needed=int(ytr.sum()))
        w1 = set().union(*(W1[g['id']] for g in G['val']))
        qs = np.unique(np.quantile(np.concatenate([P2[g['id']] for g in G['val']]), np.linspace(0, 1, 2001)))
        lo, hi, best = 0, len(qs) - 1, None
        while lo <= hi:
            mid = (lo + hi) // 2
            r = T.summary(simulate2(G['val'], S, D, w1, flags_at(G['val'], P2, qs[mid], w1)))
            if match3(r):
                best, lo = (float(qs[mid]), r), mid + 1
            else:
                hi = mid - 1
        if best:
            cands[name] = dict(t1=t1, t2=best[0], val=best[1], P2=P2, W1=W1)
            T.log(candidate=name, t2=best[0], val=H.pick(best[1]))

    report = {}
    r3sim = lambda g: T.simulate([g], S, D, R4.rule_flags([g], r3rule, {}, MS))
    for name, c in cands.items():
        sim = lambda g, c=c: simulate2([g], S, D, c['W1'][g['id']], flags_at([g], c['P2'], c['t2'], c['W1'][g['id']]))
        router, ref, diff = paired(G['test'], sim, r3sim)
        report[name] = dict(t1=c['t1'], t2=c['t2'], val=H.pick(c['val']), test=H.pick(router), round3Test=H.pick(ref),
                            diff=diff, passes=verdict(diff))
        T.log(candidate=name, test=H.pick(router), passes=report[name]['passes'],
              **{k: diff[k] for k in (*KEYS, 'wallVsFull')})
    passing = [n for n, r in report.items() if all(r['passes'].values())]
    chosen = min(passing, key=lambda n: report[n]['test']['wallVsFull']) if passing else None
    result = dict(constants=dict(MARGIN=MARGIN, WAVE1_SHARES=WAVE1_SHARES, KEYS=KEYS), split={k: len(v) for k, v in G.items()},
                  round3Val=H.pick(r3val), candidates=report, chosen=chosen)
    (T.out / 'ROUND6-DEV.json').write_text(json.dumps(result, indent=1))
    T.log(chosen=chosen)
    if not chosen:
        return
    path = T.out / 'frozen6-models.json'
    path.write_text(json.dumps({'wave1': E['wave1'], 'wave2': E[chosen]}))
    frozen = dict(router=chosen, t1=report[chosen]['t1'], t2=report[chosen]['t2'], modelsSha=H.sha(path),
                  featuresSha=H.sha(T.HERE / 'features.mjs'), devGameIds=sorted(g['id'] for g in games),
                  devMoveSeqs=sorted({H.h_moves(g) for g in games}), dev=report[chosen])
    (T.out / 'frozen6.json').write_text(json.dumps(frozen, indent=1))


def evaluate():
    frozen = json.loads(T.find_input('frozen6.json').read_text())
    path = T.find_input('frozen6-models.json')
    assert H.sha(path) == frozen['modelsSha'], 'frozen models changed'
    assert H.sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    models = json.loads(path.read_text())
    frozen3, models3 = R4.load_round3()
    r3rule = [('move', n, t) for n, t in frozen3['rule']]

    S, D, games, shard_of = T.load_shards(R4.FRESH)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and H.h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), moves=sum(len(g['moves_']) for g in fresh)))
    pf = H.features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in fresh}
    MS = R4.move_scores(fresh, XG, models3)
    W1, W2 = {}, {}
    for g in fresh:
        base = R4.pos_rows(g, pf, S)
        W1[g['id']] = flags_at([g], {g['id']: H.gbt_score(models['wave1'], base)}, frozen['t1'])
        s2 = H.gbt_score(models['wave2'], wave_rows(g, base, S, D, W1[g['id']]))
        W2[g['id']] = flags_at([g], {g['id']: s2}, frozen['t2'], W1[g['id']])
    sim = lambda g: simulate2([g], S, D, W1[g['id']], W2[g['id']])
    router, ref, diff = paired(fresh, sim, lambda g: T.simulate([g], S, D, R4.rule_flags([g], r3rule, {}, MS)))
    _, tiered, diff_t = paired(fresh, sim, lambda g: T.simulate([g], S, D, H.tiered1([g], S)))
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
    decision = dict(verdict(diff), browserCostUnder1Percent=cost['share'] < 0.01)
    decision['ship'] = all(decision.values())
    result = dict(frozen={k: frozen[k] for k in ('router', 't1', 't2', 'modelsSha', 'featuresSha')}, holdoutGames=len(fresh),
                  router=router, round3=ref, tiered1=tiered, diffVsRound3=diff, diffVsTiered1=diff_t, cost=cost, decision=decision)
    (T.out / 'HOLDOUT6.json').write_text(json.dumps(result, indent=1))
    T.log(cost=cost, decision=decision)


if __name__ == '__main__':
    {'dev': dev, 'eval': evaluate}[mode]()
