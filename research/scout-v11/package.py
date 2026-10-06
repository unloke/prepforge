"""Build the Kaggle kernel for the v11 head-to-head from a committed tree (no local compute).

python research/scout-v11/package.py <kernel-dir> [--slug vexylon/scout-v11-path-guard-20261005]
"""
import base64, hashlib, io, json, pathlib, subprocess, sys, zipfile

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
slug = sys.argv[sys.argv.index('--slug') + 1] if '--slug' in sys.argv else 'vexylon/scout-v11-path-guard-20261005'
repo = pathlib.Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
tracked = subprocess.check_output(['git', 'ls-files', 'web-src', 'research/scout-v11', 'research/lib/scout-stockfish-uci.js',
                                   'package.json', 'package-lock.json'], cwd=repo, text=True).split()
files = [f for f in tracked if not f.endswith('.test.js') and pathlib.Path(f).suffix in {'.js', '.mjs', '.json'}]
assert 'research/scout-v11/replay.mjs' in files, 'commit research/scout-v11 first'
buf, manifest = io.BytesIO(), {}
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        data = subprocess.check_output(['git', 'show', f'HEAD:{f}'], cwd=repo)
        z.writestr(f, data); manifest[f] = hashlib.sha256(data).hexdigest()
blob = base64.b64encode(buf.getvalue()).decode()
job = f'''import base64,hashlib,io,json,pathlib,subprocess,sys,zipfile
inputs=pathlib.Path('/kaggle/input');root=pathlib.Path('/kaggle/working/code');out=pathlib.Path('/kaggle/working/v11')
def unique(slug,folder,name):
    ps=[p for p in inputs.rglob(name) if slug in p.parts and p.parent.name==folder];assert len(ps)==1,(slug,folder,name,ps);return ps[0]
zipfile.ZipFile(io.BytesIO(base64.b64decode('{blob}'))).extractall(root)
manifest={json.dumps(manifest)}
for f,sha in manifest.items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==sha,f
data=unique('scout-depth16-batch07-20261003','scout-data','DATASET-VERIFICATION.json').parent
assert json.loads((data/'DATASET-VERIFICATION.json').read_text())['status']=='PASS'
audit=unique('scout-recommendation-audit-20261005','recommendation-audit','SUMMARY.json').parent
subprocess.run(['npm','install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=root,check=True)
for name,sha in {{'stockfish-19-lite-single.js':'d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6','stockfish-19-lite-single.wasm':'57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387'}}.items():
    assert hashlib.sha256((root/'node_modules/stockfish/bin'/name).read_bytes()).hexdigest()==sha,'production engine mismatch'
subprocess.run(['node','research/scout-v11/test_path_guard.mjs'],cwd=root,check=True)
def replay(src,ref,dst,shards):
    procs=[subprocess.Popen(['node','--max-old-space-size=6144','research/scout-v11/replay.mjs',str(src),str(ref),str(dst),str(i),str(shards)],cwd=root) for i in range(shards)]
    codes=[p.wait() for p in procs];assert codes==[0]*shards,codes
replay(data,audit,out,4)
known=[p.parent for p in inputs.rglob('KNOWN-PROVENANCE.json') if p.parent.name=='known-input' and 'scout-recommendation-audit-20261005' in p.parts]
args=[str(out)]
if len(known)==1 and (audit/'known-problems').is_dir():
    replay(known[0],audit/'known-problems',out/'known-problems',1);args.append(str(out/'known-problems'))
subprocess.run(['node','research/scout-v11/summarize.mjs',*args],cwd=root,check=True)
(out/'SOURCE-MANIFEST.json').write_text(json.dumps(dict(commit='{commit}',files=manifest),indent=1))
print('SCOUT V11 HEAD-TO-HEAD COMPLETE',flush=True)
'''
(out / 'job.py').write_text(job, encoding='utf-8')
(out / 'kernel-metadata.json').write_text(json.dumps({
    'id': slug, 'title': slug.split('/')[1], 'code_file': 'job.py', 'language': 'python', 'kernel_type': 'script',
    'is_private': 'true', 'enable_gpu': 'false', 'enable_internet': 'true', 'dataset_sources': [], 'competition_sources': [],
    'kernel_sources': ['vexylon/scout-depth16-batch07-20261003', 'vexylon/scout-recommendation-audit-20261005']}, indent=2))
print(json.dumps({'commit': commit, 'files': len(files), 'zipBytes': len(buf.getvalue()), 'out': str(out)}))
