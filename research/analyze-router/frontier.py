"""Cost/recall frontier on dev-test (exploration, not a ship decision; PROTOCOL.md after amendment 11).

Rounds 4–7 found no reallocation of deep reads that beats round 3 on every recall at lower wall. This
maps the whole frontier so the operating point can be chosen as a product decision:

- `round3`: the shipped move model at thresholds from the 30th to the 95th percentile of its dev-test scores;
- `pos`: the amendment 8 position model (small) at the same score percentiles;
- `nb`: a move model (small) trained on core-without-best-status ∪ Great/Brilliant, i.e. a router that
  does not try to catch best-status flips (a move switching between Best and Excellent because two
  near-equal moves swap at depth 16).

Per-game simulation. Writes FRONTIER.json after every point. Kaggle only (job.py frontier).
"""
import json, os, pathlib, sys

sys.argv = [sys.argv[0], *sys.argv[1:3]]
os.environ.setdefault('ROUTER_SCREEN', 'lite12h')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import train as T  # noqa: E402
import holdout as H  # noqa: E402
import round2 as R2  # noqa: E402
import round4 as R4  # noqa: E402

QUANTILES = (0.30, 0.45, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95)  # score quantile thresholds


def point(games, S, D, flags_of):
    r = H.combine([T.simulate([g], S, D, flags_of(g)) for g in games])
    return {k: round(r[k], 4) for k in ('recall1', 'recallNoBest', 'recallGB', 'shallowShare', 'wallVsFull')}


def main():
    S, D, games, shard_of = T.load_shards(R2.DEV)
    G = R2.split(games)
    pf = H.features(shard_of)
    frozen3, models3 = R4.load_round3()
    XG = {g['id']: np.stack([T.move_vector(m, pf, S) for m in g['moves_']]) for g in games}
    XP = {g['id']: R4.pos_rows(g, pf, S) for g in games}
    ev = G['test']
    n3 = frozen3['rule'][0][0]
    nb = lambda m: bool(T.compare(m, S[m['fen_before']], S[m['fen_after']], D[m['fen_before']], D[m['fen_after']])[0] - {'bestStatus'}) or \
        bool(T.gb_free_flip(m, (S[m['fen_before']], S[m['fen_after']]), (D[m['fen_before']], D[m['fen_after']])))
    Xm = np.vstack([XG[g['id']] for g in G['train']])
    ynb = np.concatenate([[nb(m) for m in g['moves_']] for g in G['train']])
    need = {g['id']: R4.needed(g, S, D, R4.missed_joint) for g in G['train']}
    yp = np.concatenate([[f in need[g['id']] for f in g['positions']] for g in G['train']])
    names = [f'b_{n}' for n in T.FEAT] + [f'a_{n}' for n in T.FEAT] + T.MOVE_EXTRA
    models = {'round3': models3[n3], 'nb': T.export('gbt', (None, R2.fit(Xm, ynb, 'small')), names)}
    pos = T.export('gbt', (None, R2.fit(np.vstack([XP[g['id']] for g in G['train']]), yp, 'small')), R4.names())
    MS = {k: {g['id']: H.gbt_score(m, XG[g['id']]) for g in ev} for k, m in models.items()}
    PS = {g['id']: H.gbt_score(pos, XP[g['id']]) for g in ev}

    out = dict(split={k: len(v) for k, v in G.items()}, quantiles=QUANTILES,
               shipped=point(ev, S, D, lambda g: R4.rule_flags([g], [('move', n3, frozen3['rule'][0][1])], {}, {n3: MS['round3']})),
               tiered1=point(ev, S, D, lambda g: H.tiered1([g], S)), curves={})
    for name in ('round3', 'nb', 'pos'):
        scores = np.concatenate([(PS if name == 'pos' else MS[name])[g['id']] for g in ev])
        curve = []
        for q in QUANTILES:
            thr = float(np.quantile(scores, q))
            if name == 'pos':
                flags_of = lambda g, thr=thr: {f for f, s in zip(g['positions'], PS[g['id']]) if s >= thr}
            else:
                flags_of = lambda g, thr=thr, name=name: R2.flags([g], {name: MS[name]}, [(name, thr)])
            curve.append(dict(quantile=q, threshold=thr, **point(ev, S, D, flags_of)))
            T.log(curve=name, **curve[-1])
            out['curves'][name] = curve
            (T.out / 'FRONTIER.json').write_text(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
