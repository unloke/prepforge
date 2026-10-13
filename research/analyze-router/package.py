"""Build a Kaggle kernel for the deepening-router study (no local compute).

python research/analyze-router/package.py <kernel-dir> whole|gamesA|gamesB|train|freeze|holdA..holdF|holdout|round2|holdout2|cancelled [--slug owner/name]

whole           300 whole games (lite 12 + lite 16 + native 16) and the engine calibration samples
gamesA, gamesB  1,000 more whole games each (lite 12 + lite 16), training data
train           labels, features, models and the benchmark, from the data kernels' outputs
freeze          the GBT threshold for 90% validation core recall, frozen before the holdout is read
holdA..holdF    500 whole games each (lite 12 + lite 16); A/B were the amendment 5 holdout, C..F the round 2 one
holdout         the frozen router against tiered1 on the holdout, once (PROTOCOL.md amendment 5)
round2          round 2 candidates on all development games and the frozen choice (amendment 6)
holdout2        the round 2 router against tiered1 on holdC..holdF, once
carried1..5     the browser's carried-hash depth-12 screen reads for every shard (amendment 7)
round3          round 2's procedure on the carried-hash screen reads (amendment 7)
holdout3        the round 3 router against tiered1 on holdC..holdF, once
holdG..holdN    500 fresh games each, carried-hash lite 12 + lite 16 (G..J: round 4 holdout; K..N: round 9)
round4, round5  position routers on the development games, frozen against the shipped round 3 router
round6          two-wave position routing (amendment 10)
round7          the round 3 router pruned by a position model (amendment 11)
frontier        cost/recall curves of round 3, a position model and a no-best-status router (dev-test)
round8          a router that ignores best-status flips: frozen on validation, scored on dev-test and holdG..holdJ
round9          the no-best-status router at NB ≥ round 3 and GB ≥ tiered1, frozen on validation (amendment 13)
holdout9        the round 9 router against round 3 and tiered1 on holdK..holdN, once
cost9           browser cost of round 3 and round 9 timed together on one machine
holdout4..7     the frozen round 4..7 router against round 3 and tiered1 on holdG..holdJ, once
hashbench       the shipped router's screen pass, a fresh hash per position against a carried one
cancelled       a no-op version that stops a running kernel (used for the dropped scout screen run)
"""
import base64, hashlib, io, json, pathlib, subprocess, sys, zipfile

out, kind = pathlib.Path(sys.argv[1]), sys.argv[2]
DATE = '20261007'
slug = sys.argv[sys.argv.index('--slug') + 1] if '--slug' in sys.argv else f'vexylon/analyze-router-{kind}-{DATE}'
TEACHER = 'vexylon/scout-depth16-batch07-20261003'
repo = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
files = sorted(p.relative_to(repo).as_posix() for p in (repo / 'research/analyze-router').glob('*')
               if p.is_file() and p.suffix in {'.py', '.mjs', '.md'})
files += ['research/analyze-speed/bench.mjs', 'package.json', 'package-lock.json',
          'web-src/engine/deepening-router.js', 'web-src/engine/deepening-router-model.json']
out.mkdir(parents=True, exist_ok=True)
buf, manifest = io.BytesIO(), {}
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        data = (repo / f).read_bytes()
        z.writestr(f, data); manifest[f] = hashlib.sha256(data).hexdigest()
blob = base64.b64encode(buf.getvalue()).decode()
job = f'''import base64,hashlib,io,json,os,pathlib,subprocess,sys,zipfile
root=pathlib.Path('/tmp/code');out=pathlib.Path('/kaggle/working/router')
zipfile.ZipFile(io.BytesIO(base64.b64decode('{blob}'))).extractall(root)
manifest={json.dumps(manifest)}
for f,sha in manifest.items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==sha,f
out.mkdir(parents=True,exist_ok=True)
(out/'SOURCE-MANIFEST.json').write_text(json.dumps(dict(kind='{kind}',files=manifest,cpus=os.cpu_count()),indent=1))
sys.argv=['job','{kind}',str(root),str(out)]
exec(compile((root/'research/analyze-router/job.py').read_text(),'job.py','exec'))
'''
(out / 'job.py').write_text(job, encoding='utf-8')
k_ = lambda *names: [f'vexylon/analyze-router-{n}-{DATE}' for n in names]
CARRIED = tuple(f'carried{i}' for i in range(1, 6))
DATA = ('whole', 'gamesA', 'gamesB', 'holdA', 'holdB', 'holdC', 'holdD', 'holdE', 'holdF')
FRESH4 = ('holdG', 'holdH', 'holdI', 'holdJ', 'holdK', 'holdL', 'holdM', 'holdN')
sources = {'scout': [], 'cancelled': [], 'whole': [TEACHER], **{k: [] for k in DATA[1:]},
           'train': k_('whole', 'gamesa', 'gamesb'), 'freeze': k_('whole', 'gamesa', 'gamesb', 'train'),
           'holdout': k_('freeze', 'holda', 'holdb'),
           'round2': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb'),
           'holdout2': k_('round2', 'holdc', 'holdd', 'holde', 'holdf'), 'hashbench': [], **{k: [] for k in CARRIED}, **{k: [] for k in FRESH4},
           'round3': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb', 'carried1', 'carried2', 'carried3'),
           'holdout3': k_('round3', 'holdc', 'holdd', 'holde', 'holdf', 'carried4', 'carried5'),
           **{f'round{r}': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb', 'carried1', 'carried2', 'carried3', 'round3')
              for r in (4, 5, 6, 7)},
           'round9': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb', 'carried1', 'carried2', 'carried3', 'round3'),
           'holdout9': k_('round3') + [f'vexylon/analyze-router-{n}-20261012' for n in ('round9', 'holdk', 'holdl', 'holdm', 'holdn')],
           'cost9': k_('round3') + [f'vexylon/analyze-router-{n}-20261012' for n in ('round9', 'holdk', 'holdl', 'holdm', 'holdn')],
           'frontier': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb', 'carried1', 'carried2', 'carried3', 'round3'),
           'round8': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb', 'carried1', 'carried2', 'carried3', 'round3') +
                     [f'vexylon/analyze-router-{n}-20261012' for n in ('holdg', 'holdh', 'holdi', 'holdj')],
           **{f'holdout{r}': k_('round3') + [f'vexylon/analyze-router-{n}-20261012' for n in (f'round{r}', 'holdg', 'holdh', 'holdi', 'holdj')]
              for r in (4, 5, 6, 7)}}[kind]
(out / 'kernel-metadata.json').write_text(json.dumps({
    'id': slug, 'title': slug.split('/')[1], 'code_file': 'job.py', 'language': 'python', 'kernel_type': 'script',
    'is_private': 'true', 'enable_gpu': 'false', 'enable_internet': 'true',
    'dataset_sources': ['datasnaek/chess'] if kind in (*DATA, *CARRIED, *FRESH4, 'hashbench') else [],
    'competition_sources': [], 'kernel_sources': sources}, indent=2))
print(json.dumps({'kind': kind, 'slug': slug, 'files': len(files), 'zipBytes': len(buf.getvalue()), 'out': str(out)}))
