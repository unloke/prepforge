"""Kaggle kernels for the production-depth coach reads (no local compute).

  py research/coach-relations/prod-depth/package.py <kernel-dir> v5|fresh1|fresh2|fresh3|fresh4

Each kernel analyses one games file (games.py) with analyze-games.mjs (production's tiered pass
and Coach, plus the engine stress check), then runs explain_cards.py on its errors. Output in
/kaggle/working/prod-depth: evals.jsonl, cards.jsonl, explain.jsonl, sf_cache.jsonl, health.json,
SOURCE-MANIFEST.json.
"""
import base64
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import zipfile

out, kind = pathlib.Path(sys.argv[1]), sys.argv[2]
DATE = "20261014"
repo = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
GAMES = repo / "artifacts/benchmarks/coach-relations-20261014/prod-depth/games"
files = ["package.json", "package-lock.json", "research/sft/experiment/coach-v5-20261011/make_cards.py"]
for d, exts in (("web-src/engine", {".js", ".json"}), ("web-src/coach", {".js", ".json"}), ("web-src/generated", {".js", ".json"}),
                ("research/coach-relations", {".py"}), ("research/coach-relations/prod-depth", {".py", ".mjs"})):
    files += sorted(p.relative_to(repo).as_posix() for p in (repo / d).glob("*") if p.is_file() and p.suffix in exts
                    and not p.name.endswith(".test.js"))
buf, manifest = io.BytesIO(), {}
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files + [f"games/{kind}.json"]:
        data = (GAMES / f"{kind}.json" if f.startswith("games/") else repo / f).read_bytes()
        z.writestr(f, data)
        manifest[f] = hashlib.sha256(data).hexdigest()
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd=repo).strip()
dirty = subprocess.check_output(["git", "status", "--porcelain", "--", *files], text=True, cwd=repo).strip()
blob = base64.b64encode(buf.getvalue()).decode()
job = f'''import base64,hashlib,io,json,os,pathlib,shutil,subprocess,sys,tarfile,time,urllib.request,zipfile
root=pathlib.Path('/tmp/code');out=pathlib.Path('/kaggle/working/prod-depth')
zipfile.ZipFile(io.BytesIO(base64.b64decode('{blob}'))).extractall(root)
manifest={json.dumps(manifest)}
for f,sha in manifest.items():assert hashlib.sha256((root/f).read_bytes()).hexdigest()==sha,f
out.mkdir(parents=True,exist_ok=True)
def log(**kw):print(json.dumps(kw),flush=True)
# Node 22 (module.register for the JSON hook); the image's node may be older.
node='node'
v=subprocess.run(['node','--version'],capture_output=True,text=True).stdout.strip() if shutil.which('node') else ''
if not v or int(v[1:].split('.')[0])<22:
    url='https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz'
    with urllib.request.urlopen(url,timeout=300) as r,open('/tmp/node.tar.xz','wb') as f:shutil.copyfileobj(r,f)
    with tarfile.open('/tmp/node.tar.xz') as t:t.extractall('/tmp')
    os.environ['PATH']='/tmp/node-v22.20.0-linux-x64/bin'+os.pathsep+os.environ['PATH']
log(node=subprocess.run(['node','--version'],capture_output=True,text=True).stdout.strip(),cpus=os.cpu_count())
subprocess.run(['npm','install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=root,check=True)
lite=root/'node_modules/stockfish/bin/stockfish-19-lite.js'
assert hashlib.sha256(lite.read_bytes()).hexdigest()=='2f98d35d20bf435c16925f8955fe4b0c2062e66962799a407667218ff9ea709d','production engine mismatch'
subprocess.run([sys.executable,'-m','pip','install','-q','chess==1.11.2'],check=True)
(out/'SOURCE-MANIFEST.json').write_text(json.dumps(dict(kind='{kind}',commit='{commit}',dirty={json.dumps(dirty)},files=manifest,cpus=os.cpu_count()),indent=1))
t0=time.time()
subprocess.run(['node','--import','./research/coach-relations/prod-depth/register.mjs','research/coach-relations/prod-depth/analyze-games.mjs',
                'games/{kind}.json',str(out),'--budget','560','--stress'],cwd=root,check=True)
log(stage='analyze',seconds=round(time.time()-t0))
t0=time.time()
p=subprocess.run([sys.executable,'research/coach-relations/prod-depth/explain_cards.py',str(out/'cards.jsonl'),str(out/'explain.jsonl')],cwd=root,timeout=7200)
log(stage='explain',seconds=round(time.time()-t0),code=p.returncode)
cache=root/'research/coach-relations/sf_cache.jsonl'
if cache.exists():shutil.copy(cache,out/'sf_cache.jsonl')
'''
out.mkdir(parents=True, exist_ok=True)
(out / "job.py").write_text(job, encoding="utf-8")
slug = f"vexylon/coach-prod-depth-{kind}-{DATE}"
(out / "kernel-metadata.json").write_text(json.dumps({
    "id": slug, "title": slug.split("/")[1], "code_file": "job.py", "language": "python", "kernel_type": "script",
    "is_private": "true", "enable_gpu": "false", "enable_internet": "true",
    "dataset_sources": [], "competition_sources": [], "kernel_sources": []}, indent=2))
print(json.dumps({"kind": kind, "slug": slug, "files": len(files), "zipBytes": len(buf.getvalue()), "dirty": dirty}))
