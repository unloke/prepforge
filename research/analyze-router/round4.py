"""Rounds 4 and 5 (PROTOCOL.md amendments 8 and 9): deepen positions, not moves.

The round 3 router deepens both positions of every move it flags (about 71% of positions on the
holdout). A position router scores each position from its own screen read, its neighbours' reads and
its two adjacent moves, and deepens only the positions whose deep read a critical move needs.

  python round4.py dev  <code-root> <out>   fit the candidates on the round 2/3 development games,
                                            freeze one against the shipped round 3 router
  python round4.py eval <code-root> <out>   score the frozen router, round 3 and tiered1 once on holdG..holdJ

ROUTER_ROUND=4 runs the amendment 8 candidates, 5 adds amendment 9's. Runs on Kaggle (job.py
round4|round5|holdout4) with the carried-hash screen reads, never locally.
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

R = os.environ.get('ROUTER_ROUND', '4')
FRESH = ('holdG', 'holdH', 'holdI', 'holdJ')
MARGIN = 0.01  # core and Great/Brilliant recall may trail round 3 by at most this (CI lower bound)
MOVE_SHARES = (0.70, 0.80, 0.85, 0.90, 0.95)  # amendment 9: share of moves the raised round 3 rule leaves out
GB_SHARES = (0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95)  # amendment 9: GB position model thresholds


def reads(S, D, flagged):
    return lambda f: D[f] if f in flagged else S[f]


def missed_core(m, F, D):
    fb, fa = m['fen_before'], m['fen_after']
    return bool(T.compare(m, F(fb), F(fa), D[fb], D[fa])[0])


def missed_gb(m, F, D):
    fb, fa = m['fen_before'], m['fen_after']
    return bool(T.gb_free_flip(m, (F(fb), F(fa)), (D[fb], D[fa])))


def missed_joint(m, F, D):
    return missed_core(m, F, D) or missed_gb(m, F, D)


def needed(g, S, D, missed):
    """Positions whose deep read a critical move needs. When either position alone fixes the move, the one
    whose read moved more is the needed one."""
    need = set()
    for m in g['moves_']:
        fb, fa = m['fen_before'], m['fen_after']
        if not missed(m, reads(S, D, set()), D):
            continue
        b_alone = not missed(m, reads(S, D, {fb}), D)
        a_alone = not missed(m, reads(S, D, {fa}), D)
        if not b_alone:
            need.add(fa)
        if not a_alone:
            need.add(fb)
        if b_alone and a_alone:
            need.add(fb if abs(S[fb]['w'] - D[fb]['w']) >= abs(S[fa]['w'] - D[fa]['w']) else fa)
    return need


def move_extra(m, pf, S):
    return T.move_vector(m, pf, S)[-len(T.MOVE_EXTRA):] if m else np.zeros(len(T.MOVE_EXTRA), np.float32)


def pos_rows(g, pf, S):
    """One row per position in game order: neighbours' and own screen features, the adjacent moves."""
    P, M, z = g['positions'], g['moves_'], np.zeros(len(T.FEAT), np.float32)
    rows = []
    for i, f in enumerate(P):
        m_in = M[i - 1] if i > 0 else None
        m_out = M[i] if i < len(M) else None
        rows.append(np.concatenate([pf[P[i - 1]] if i > 0 else z, pf[f], pf[P[i + 1]] if i + 1 < len(P) else z,
                                    np.array(T.pos_extra(m_in, m_out, S), np.float32),
                                    move_extra(m_in, pf, S), move_extra(m_out, pf, S)]))
    return np.stack(rows)


def names():
    return ([f'prev_{n}' for n in T.FEAT] + [f'pos_{n}' for n in T.FEAT] + [f'next_{n}' for n in T.FEAT] +
            T.POS_EXTRA + [f'in_{n}' for n in T.MOVE_EXTRA] + [f'out_{n}' for n in T.MOVE_EXTRA])


def rule_flags(games, rule, PS, MS):
    """A rule is a list of components, OR'd: ('pos', model, thr) deepens positions scoring >= thr;
    ('move', model, thr) deepens both positions of moves scoring >= thr (the round 3 way)."""
    out = set()
    for kind, model, thr in rule:
        if kind == 'pos':
            out |= {f for g in games for f, s in zip(g['positions'], PS[model][g['id']]) if s >= thr}
        else:
            out |= R2.flags(games, MS, [(model, thr)])
    return out


def search(val, S, D, PS, MS, model, pred, fixed=()):
    """Highest threshold for position model `model` (with `fixed` components OR'd in) meeting pred."""
    qs = np.unique(np.quantile(np.concatenate([PS[model][g['id']] for g in val]), np.linspace(0, 1, 2001)))
    lo, hi, best = 0, len(qs) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        r = T.summary(T.simulate(val, S, D, rule_flags(val, [*fixed, ('pos', model, qs[mid])], PS, MS)))
        if pred(r):
            best, lo = ([*fixed, ('pos', model, float(qs[mid]))], r), mid + 1
        else:
            hi = mid - 1
    return best


def load_round3():
    frozen3 = json.loads(T.find_input('frozen3.json').read_text())
    path = T.find_input('frozen3-models.json')
    assert H.sha(path) == frozen3['modelsSha'], 'round 3 models changed'
    return frozen3, json.loads(path.read_text())


def move_scores(games, XG, models3):
    return {n: {g['id']: H.gbt_score(m, XG[g['id']]) for g in games} for n, m in models3.items()}


def verdict(diff):
    return dict(core=diff['recall1']['ci'][0] >= -MARGIN, gb=diff['recallGB']['ci'][0] >= -MARGIN,
                faster=diff['wallVsFull']['ci'][1] < 0)


def dev():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = load_round3()
    r3rule = [('move', n, t) for n, t in frozen3['rule']]
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    XP = {g['id']: pos_rows(g, pf, S) for g in games}
    MS = move_scores(G['val'] + G['test'], XG, models3)
    labels = {'pos': missed_joint} if R == '4' else {'pos': missed_joint, 'core': missed_core, 'gb': missed_gb}
    Xtr = np.vstack([XP[g['id']] for g in G['train']])
    E, PS = {}, {}
    for label, missed in labels.items():
        need = {g['id']: needed(g, S, D, missed) for g in G['train']}
        ytr = np.concatenate([[f in need[g['id']] for f in g['positions']] for g in G['train']])
        T.log(label=label, positions=len(ytr), needed=int(ytr.sum()), rate=round(float(ytr.mean()), 4))
        for size in R2.GBT:
            name = f'{label}-{size}'
            E[name] = T.export('gbt', (None, R2.fit(Xtr, ytr, size)), names())
            PS[name] = {g['id']: H.gbt_score(E[name], XP[g['id']]) for g in G['val'] + G['test']}

    r3val = T.summary(T.simulate(G['val'], S, D, rule_flags(G['val'], r3rule, PS, MS)))
    base = T.summary(T.simulate(G['val'], S, D, H.tiered1(G['val'], S)))
    T.log(round3Val=H.pick(r3val), tiered1Val=H.pick(base))
    guard3 = lambda r: R2.ok(r, base, R2.CORE_MIN, R2.GB_MARGIN)
    match3 = lambda r: r['recall1'] >= r3val['recall1'] and r['recallGB'] >= r3val['recallGB']
    cheaper = lambda a, b: b is None or a[1]['wallVsFull'] < b[1]['wallVsFull']
    rules = {}
    for size in R2.GBT:
        for gname, pred in (('guard3', guard3), ('match3', match3)):
            hit = search(G['val'], S, D, PS, MS, f'pos-{size}', pred)
            if hit:
                rules[f'pos-{size}+{gname}'] = hit
        if R == '4':
            continue
        # Hybrid: the position router plus the round 3 move rule raised to flag fewer moves.
        n3 = r3rule[0][1]
        r3scores = np.concatenate([MS[n3][g['id']] for g in G['val']])
        best = None
        for share in MOVE_SHARES:
            fixed = [('move', n3, float(np.quantile(r3scores, share)))]
            hit = search(G['val'], S, D, PS, MS, f'pos-{size}', match3, fixed)
            if hit and cheaper(hit, best):
                best = hit
        if best:
            rules[f'hybrid-{size}+match3'] = best
        # Two position models: core-needed OR Great/Brilliant-needed.
        gscores = np.concatenate([PS[f'gb-{size}'][g['id']] for g in G['val']])
        best = None
        for share in GB_SHARES:
            fixed = [('pos', f'gb-{size}', float(np.quantile(gscores, share)))]
            hit = search(G['val'], S, D, PS, MS, f'core-{size}', match3, fixed)
            if hit and cheaper(hit, best):
                best = hit
        if best:
            rules[f'two-{size}+match3'] = best

    r3test = rule_flags(G['test'], r3rule, PS, MS)
    report = {}
    for name, (rule, val) in rules.items():
        router, ref, diff = H.paired(G['test'], S, D, rule_flags(G['test'], rule, PS, MS), r3test)
        report[name] = dict(rule=rule, val=H.pick(val), test=H.pick(router), round3Test=H.pick(ref), diff=diff,
                            passes=verdict(diff))
        T.log(candidate=name, rule=rule, val=H.pick(val), test=H.pick(router), passes=report[name]['passes'],
              core=diff['recall1'], gb=diff['recallGB'], wall=diff['wallVsFull'])
    # Frozen selection: among candidates passing all three against round 3 on dev-test, the lowest wall.
    passing = [n for n, r in report.items() if all(r['passes'].values())]
    chosen = min(passing, key=lambda n: report[n]['test']['wallVsFull']) if passing else None
    result = dict(constants=dict(MARGIN=MARGIN, GBT=R2.GBT, MOVE_SHARES=MOVE_SHARES, GB_SHARES=GB_SHARES),
                  split={k: len(v) for k, v in G.items()}, round3Val=H.pick(r3val), tiered1Val=H.pick(base),
                  candidates=report, chosen=chosen)
    (T.out / f'ROUND{R}-DEV.json').write_text(json.dumps(result, indent=1))
    T.log(chosen=chosen)
    if not chosen:
        return
    rule = report[chosen]['rule']
    exported = {m: (E[m] if k == 'pos' else models3[m]) for k, m, _ in rule}
    path = T.out / f'frozen{R}-models.json'
    path.write_text(json.dumps(exported))
    frozen = dict(router=chosen, rule=rule, modelsSha=H.sha(path), featuresSha=H.sha(T.HERE / 'features.mjs'),
                  devGameIds=sorted(g['id'] for g in games), devMoveSeqs=sorted({H.h_moves(g) for g in games}),
                  dev=report[chosen])
    (T.out / f'frozen{R}.json').write_text(json.dumps(frozen, indent=1))


def evaluate():
    frozen = json.loads(T.find_input(f'frozen{R}.json').read_text())
    path = T.find_input(f'frozen{R}-models.json')
    assert H.sha(path) == frozen['modelsSha'], 'frozen models changed'
    assert H.sha(T.HERE / 'features.mjs') == frozen['featuresSha'], 'feature code changed since the freeze'
    models = json.loads(path.read_text())
    frozen3, models3 = load_round3()
    r3rule = [('move', n, t) for n, t in frozen3['rule']]

    S, D, games, shard_of = T.load_shards(FRESH)
    ids, seqs = set(frozen['devGameIds']), set(frozen['devMoveSeqs'])
    fresh = [g for g in games if g['id'] not in ids and H.h_moves(g) not in seqs]
    T.log(holdout=dict(complete=len(games), fresh=len(fresh), moves=sum(len(g['moves_']) for g in fresh)))
    pf = H.features(shard_of)
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in fresh}
    MS = move_scores(fresh, XG, models3)
    PS = {m: {g['id']: H.gbt_score(models[m], pos_rows(g, pf, S)) for g in fresh}
          for k, m, _ in frozen['rule'] if k == 'pos'}
    mine = rule_flags(fresh, frozen['rule'], PS, MS)
    router, ref, diff = H.paired(fresh, S, D, mine, rule_flags(fresh, r3rule, PS, MS))
    _, tiered, diff_t = H.paired(fresh, S, D, mine, H.tiered1(fresh, S))
    T.log(router=H.pick(router), round3=H.pick(ref), tiered1=H.pick(tiered), diff=diff)

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
    decision = dict(verdict(diff), browserCostUnder1Percent=cost['share'] < 0.01)
    decision['ship'] = all(decision.values())
    result = dict(frozen={k: frozen[k] for k in ('router', 'rule', 'modelsSha', 'featuresSha')},
                  holdoutGames=len(fresh), router=router, round3=ref, tiered1=tiered, diffVsRound3=diff,
                  diffVsTiered1=diff_t, cost=cost, decision=decision)
    (T.out / f'HOLDOUT{R}.json').write_text(json.dumps(result, indent=1))
    T.log(cost=cost, decision=decision)


if __name__ == '__main__':
    {'dev': dev, 'eval': evaluate}[mode]()
