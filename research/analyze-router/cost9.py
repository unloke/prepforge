"""Browser cost of round 3 and round 9 measured together on one machine (after amendment 13).

The holdout9 cost read (1.07%) came from a machine whose feature timing differed from every earlier
holdout. Both routers share the feature code, so this times both on the same 400 holdK screen reads,
three times each, and reports each share. Cost only; no recall is read. Also checks that
features.mjs's move counts equal chess.js SAN counting on every distinct holdK..holdN position.

  python cost9.py <code-root> <out>   (job.py cost9, Kaggle only)
"""
import json, os, pathlib, subprocess, sys

sys.argv = [sys.argv[0], *sys.argv[1:3]]
os.environ.setdefault('ROUTER_SCREEN', 'lite12h')
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np  # noqa: E402

import train as T  # noqa: E402
import round4 as R4  # noqa: E402

frozen3, models3 = R4.load_round3()
n3 = frozen3['rule'][0][0]
models = {'round3': models3[n3], 'round9': json.loads(T.find_input('frozen9-model.json').read_text())['nb']}
games = json.loads(T.find_input('holdK/games.json').read_text())
tmp = pathlib.Path('/tmp/cost'); tmp.mkdir(exist_ok=True)
every = sorted({f for s in ('holdK', 'holdL', 'holdM', 'holdN') for g in json.loads(T.find_input(f'{s}/games.json').read_text())
                for f in g['positions']})
(tmp / 'every.txt').write_text('\n'.join(every) + '\n')
check = json.loads(subprocess.run(['node', str(T.HERE / 'counts-check.mjs'), str(tmp / 'every.txt')], cwd=T.root, check=True,
                                  capture_output=True, text=True).stdout.strip().splitlines()[-1])
T.log(countsCheck=check)
fens = [f for g in games for f in g['positions']][:400]
(tmp / 'fens.txt').write_text('\n'.join(fens) + '\n')
(tmp / 'models.json').write_text(json.dumps(models))
subprocess.run(['node', str(T.HERE / 'engine-runs.mjs'), str(tmp / 'fens.txt'), str(tmp / 'screen.ndjson'), '--engine', 'lite',
                '--depth', '12', '--nodes', '1500000', '--hash', '16', '--workers', '1'], cwd=T.root, check=True)
screen_ms = float(np.mean([json.loads(l)['ms'] for l in (tmp / 'screen.ndjson').read_text().splitlines() if l]))
runs = []
for _ in range(3):
    b = json.loads(subprocess.run(['node', str(T.HERE / 'infer-bench.mjs'), str(tmp / 'models.json'), str(tmp / 'screen.ndjson'), '400'],
                                  cwd=T.root, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1])
    runs.append({k: dict(featureUs=b['featureUsPerPosition'], modelUs=v['usPerCall'],
                         share=(b['featureUsPerPosition'] + v['usPerCall']) / 1000 / screen_ms) for k, v in b['models'].items()})
result = dict(countsCheck=check, screenMsPerPosition=screen_ms, runs=runs,
              medianShare={k: float(np.median([r[k]['share'] for r in runs])) for k in models})
(T.out / 'COST9.json').write_text(json.dumps(result, indent=1))
T.log(cost9=result)
