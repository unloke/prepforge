"""Build the Kaggle kernel for the Analyze speed study from the committed tree (no local compute).

python research/analyze-speed/package.py <kernel-dir> [--slug vexylon/analyze-speed-20261006] [--games 48] [--budget minutes]
"""
import base64, hashlib, io, json, pathlib, subprocess, sys, zipfile

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
slug = sys.argv[sys.argv.index('--slug') + 1] if '--slug' in sys.argv else 'vexylon/analyze-speed-20261006'
games = int(sys.argv[sys.argv.index('--games') + 1]) if '--games' in sys.argv else 48
budget = int(sys.argv[sys.argv.index('--budget') + 1]) if '--budget' in sys.argv else 0
repo = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
files = subprocess.check_output(['git', 'ls-files', 'research/analyze-speed', 'package.json', 'package-lock.json'],
                                cwd=repo, text=True).split()
assert 'research/analyze-speed/bench.mjs' in files, 'commit research/analyze-speed first'
buf, manifest = io.BytesIO(), {}
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        data = subprocess.check_output(['git', 'show', f'HEAD:{f}'], cwd=repo)
        z.writestr(f, data); manifest[f] = hashlib.sha256(data).hexdigest()
blob = base64.b64encode(buf.getvalue()).decode()
job = f'''import base64,hashlib,io,json,os,pathlib,subprocess,zipfile
root=pathlib.Path('/kaggle/working/code');out=pathlib.Path('/kaggle/working/analyze-speed')
zipfile.ZipFile(io.BytesIO(base64.b64decode('{blob}'))).extractall(root)
manifest={json.dumps(manifest)}
for f,sha in manifest.items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==sha,f
csv=[p for p in pathlib.Path('/kaggle/input').rglob('games.csv')];assert len(csv)==1,csv
subprocess.run(['npm','install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=root,check=True)
for name,sha in {{'stockfish-19-lite-single.js':'d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6','stockfish-19-lite-single.wasm':'57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387'}}.items():
    assert hashlib.sha256((root/'node_modules/stockfish/bin'/name).read_bytes()).hexdigest()==sha,'production engine mismatch'
print('cpus',os.cpu_count(),flush=True)
subprocess.run(['node','research/analyze-speed/bench.mjs',str(csv[0]),str(out/'smoke'),'1'],cwd=root,check=True)
subprocess.run(['node','research/analyze-speed/summarize.mjs',str(out/'smoke')],cwd=root,check=True)
subprocess.run(['node','research/analyze-speed/bench.mjs',str(csv[0]),str(out),'{games}','{budget}'],cwd=root,check=True)
subprocess.run(['node','research/analyze-speed/summarize.mjs',str(out)],cwd=root,check=True)
(out/'SOURCE-MANIFEST.json').write_text(json.dumps(dict(commit='{commit}',files=manifest,cpus=os.cpu_count()),indent=1))
print('ANALYZE SPEED STUDY COMPLETE',flush=True)
'''
(out / 'job.py').write_text(job, encoding='utf-8')
(out / 'kernel-metadata.json').write_text(json.dumps({
    'id': slug, 'title': slug.split('/')[1], 'code_file': 'job.py', 'language': 'python', 'kernel_type': 'script',
    'is_private': 'true', 'enable_gpu': 'false', 'enable_internet': 'true', 'dataset_sources': ['datasnaek/chess'],
    'competition_sources': [], 'kernel_sources': []}, indent=2))
print(json.dumps({'commit': commit, 'files': len(files), 'zipBytes': len(buf.getvalue()), 'out': str(out)}))
