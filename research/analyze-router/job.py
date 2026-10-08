"""Kaggle entry point (package.py wraps it): `job <kind> <code-root> <out-dir>`. Never run locally."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile, time, urllib.request

kind, root, out = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
HERE = root / 'research/analyze-router'
LITE_SHA = {'stockfish-19-lite-single.js': 'd3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6',
            'stockfish-19-lite-single.wasm': '57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387'}
# The scout-distill teacher binary (research/scout-distill/worker.py, engine-config.json).
NATIVE_URL = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz'
NATIVE_TAR_SHA = '9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f'
NATIVE_EXE_SHA = '0f83d24cc46d2c66c60f16001af5444873bc112b7d028594513426894c12da19'
WORKERS = os.cpu_count() or 4
# (analyze-speed hash-order offset, games); 'whole' is 48..347. holdA/holdB were the amendment 5 holdout
# (now development data); holdC..holdF are the round 2 holdout (amendment 6).
SHARDS = {'gamesA': (348, 1000), 'gamesB': (1348, 1000), 'holdA': (2348, 500), 'holdB': (2848, 500),
          'holdC': (3348, 500), 'holdD': (3848, 500), 'holdE': (4348, 500), 'holdF': (4848, 500)}


def log(**kw):
    print(json.dumps(kw), flush=True)


def find_input(name):
    hits = sorted(pathlib.Path('/kaggle/input').rglob(name), key=lambda p: -p.stat().st_size)
    assert hits, f'missing input {name}'
    log(input=name, picked=str(hits[0]), candidates=[str(p) for p in hits])
    return hits[0]


def npm():
    subprocess.run(['npm', 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=root, check=True)
    for name, sha in LITE_SHA.items():
        assert hashlib.sha256((root / 'node_modules/stockfish/bin' / name).read_bytes()).hexdigest() == sha, 'production engine mismatch'


def native():
    tar = out / 'sf19.tar.gz'
    req = urllib.request.Request(NATIVE_URL, headers={'User-Agent': 'PrepForge-router-research'})
    with urllib.request.urlopen(req, timeout=180) as r, tar.open('wb') as f:
        shutil.copyfileobj(r, f)
    assert hashlib.sha256(tar.read_bytes()).hexdigest() == NATIVE_TAR_SHA, 'native release checksum'
    exe = pathlib.Path('/tmp/sf19')
    with tarfile.open(tar) as bundle:
        m = next(m for m in bundle.getmembers() if m.isfile() and pathlib.Path(m.name).name == 'stockfish-linux-x86-64-universal')
        with bundle.extractfile(m) as src, exe.open('wb') as dst:
            shutil.copyfileobj(src, dst)
    tar.unlink()
    exe.chmod(0o755)
    assert hashlib.sha256(exe.read_bytes()).hexdigest() == NATIVE_EXE_SHA, 'native executable differs from the teacher'
    return str(exe)


def run(fens, dest, engine, depth, nodes, hash_mb, budget):
    t0 = time.time()
    subprocess.run(['node', str(HERE / 'engine-runs.mjs'), str(fens), str(dest), '--engine', engine, '--depth', str(depth),
                    '--nodes', str(nodes), '--hash', str(hash_mb), '--workers', str(WORKERS), '--budget', str(budget)],
                   cwd=root, check=True)
    log(stage=pathlib.Path(dest).name, seconds=round(time.time() - t0), workers=WORKERS)


def teacher_fens(dest, sample=None):
    """Distinct non-terminal FENs of the complete depth-16 receipts (optionally a fixed hash sample)."""
    fens = []
    with find_input('teacher-receipts.ndjson').open(encoding='utf8') as f:
        for line in f:
            r = json.loads(line)
            if r.get('status', 'complete') == 'complete' and not r.get('terminal'):
                fens.append(r['fen'])
    fens = sorted(set(fens), key=lambda s: hashlib.sha256(s.encode()).hexdigest())
    if sample:
        fens = fens[:sample]
    pathlib.Path(dest).write_text('\n'.join(fens) + '\n')
    log(fens=str(dest), count=len(fens))


def fill_dev(exe):
    """The dev data kernels lost a few in-flight reads to a buffer bug (fixed in engine-runs.mjs). Each
    read is a pure function of the FEN, so re-run only the missing ones into copies, then point the
    Python steps at them. exe=None skips the native run (only train.py uses it)."""
    fill = pathlib.Path('/tmp/filled')
    fill.mkdir(exist_ok=True)
    lite12, lite16 = ('lite12', 'lite', 12, 1500000, 16), ('lite16', 'lite', 16, 1500000, 16)
    whole = [lite12, lite16] + ([('native16', exe, 16, 0, 64)] if exe else [])
    for shard, runs in (('whole', whole), ('gamesA', [lite12, lite16]), ('gamesB', [lite12, lite16])):
        hits = sorted(pathlib.Path('/kaggle/input').rglob(f'{shard}/fens.txt'))
        if not hits:
            log(missingShard=shard)
            continue
        for name, engine, depth, nodes, hash_mb in runs:
            src = find_input(f'{shard}-{name}.ndjson')
            shutil.copy(src, fill / src.name)
            run(hits[0], fill / src.name, engine, depth, nodes, hash_mb, 60)
    os.environ['ROUTER_INPUT'] = '/kaggle/input' + os.pathsep + str(fill)


if kind == 'scout':
    npm()
    teacher_fens(out / 'scout-fens.txt')
    run(out / 'scout-fens.txt', out / 'scout-lite12.ndjson', 'lite', 12, 1500000, 16, 640)
elif kind == 'whole':
    npm()
    exe = native()
    csv = find_input('games.csv')
    subprocess.run(['node', str(HERE / 'games.mjs'), str(csv), str(out / 'whole'), '300'], cwd=root, check=True)
    fens = out / 'whole/fens.txt'
    run(fens, out / 'whole-lite12.ndjson', 'lite', 12, 1500000, 16, 45)
    run(fens, out / 'whole-lite16.ndjson', 'lite', 16, 1500000, 16, 170)
    run(fens, out / 'whole-native16.ndjson', exe, 16, 0, 64, 90)
    # Calibration on the scout domain: production deep (lite 16) against the native teacher, and a
    # fresh native depth-12 read to check the teacher's depth-12 info line is the same search.
    teacher_fens(out / 'scout-sample-fens.txt', 4000)
    run(out / 'scout-sample-fens.txt', out / 'scout-sample-lite16.ndjson', 'lite', 16, 1500000, 16, 80)
    lines = (out / 'scout-sample-fens.txt').read_text().split('\n')[:1000]
    (out / 'scout-sample1k-fens.txt').write_text('\n'.join(lines) + '\n')
    run(out / 'scout-sample1k-fens.txt', out / 'scout-sample-native12.ndjson', exe, 12, 0, 64, 15)
elif kind in SHARDS:
    # More whole games for training (2026-10-07 amendment): production screen and deep reads only.
    npm()
    offset, count = SHARDS[kind]
    subprocess.run(['node', str(HERE / 'games.mjs'), str(find_input('games.csv')), str(out / kind), str(count), str(offset)],
                   cwd=root, check=True)
    run(out / kind / 'fens.txt', out / f'{kind}-lite12.ndjson', 'lite', 12, 1500000, 16, 100)
    run(out / kind / 'fens.txt', out / f'{kind}-lite16.ndjson', 'lite', 16, 1500000, 16, 520)
elif kind == 'cancelled':
    log(note='superseded: opening-only scout positions are not used for training (PROTOCOL.md amendment)')
elif kind == 'train':
    npm()
    fill_dev(native())
    subprocess.run([sys.executable, str(HERE / 'train.py'), str(root), str(out)], cwd=root, check=True)
elif kind == 'freeze':
    npm()
    fill_dev(None)
    subprocess.run([sys.executable, str(HERE / 'holdout.py'), 'freeze', str(root), str(out)], cwd=root, check=True)
elif kind == 'round2':
    npm()
    fill_dev(None)
    subprocess.run([sys.executable, str(HERE / 'round2.py'), 'dev', str(root), str(out)], cwd=root, check=True)
elif kind == 'holdout2':
    npm()
    subprocess.run([sys.executable, str(HERE / 'round2.py'), 'eval', str(root), str(out)], cwd=root, check=True)
elif kind == 'hashbench':
    # 100 round 2 holdout games (holdC): fresh against carried screen hash for the shipped router.
    npm()
    subprocess.run(['node', str(HERE / 'games.mjs'), str(find_input('games.csv')), str(out / 'games'), '100', '3348'],
                   cwd=root, check=True)
    subprocess.run(['node', str(HERE / 'hash-bench.mjs'), str(out / 'games/games.json'), str(out / 'HASHBENCH.json')],
                   cwd=root, check=True)
elif kind == 'holdout':
    npm()
    subprocess.run([sys.executable, str(HERE / 'holdout.py'), 'eval', str(root), str(out)], cwd=root, check=True)
else:
    raise SystemExit(f'unknown kind {kind}')
log(done=kind)
print('ANALYZE ROUTER JOB COMPLETE', flush=True)
