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
DATA = ('whole', 'gamesA', 'gamesB', 'holdA', 'holdB', 'holdC', 'holdD', 'holdE', 'holdF')
sources = {'scout': [], 'cancelled': [], 'whole': [TEACHER], **{k: [] for k in DATA[1:]},
           'train': k_('whole', 'gamesa', 'gamesb'), 'freeze': k_('whole', 'gamesa', 'gamesb', 'train'),
           'holdout': k_('freeze', 'holda', 'holdb'),
           'round2': k_('whole', 'gamesa', 'gamesb', 'holda', 'holdb'),
           'holdout2': k_('round2', 'holdc', 'holdd', 'holde', 'holdf'), 'hashbench': []}[kind]
(out / 'kernel-metadata.json').write_text(json.dumps({
    'id': slug, 'title': slug.split('/')[1], 'code_file': 'job.py', 'language': 'python', 'kernel_type': 'script',
    'is_private': 'true', 'enable_gpu': 'false', 'enable_internet': 'true',
    'dataset_sources': ['datasnaek/chess'] if kind in (*DATA, 'hashbench') else [],
    'competition_sources': [], 'kernel_sources': sources}, indent=2))
print(json.dumps({'kind': kind, 'slug': slug, 'files': len(files), 'zipBytes': len(buf.getvalue()), 'out': str(out)}))
