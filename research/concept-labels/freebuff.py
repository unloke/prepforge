"""Concept labels by Freebuff (DeepSeek V4.1 Flash) instead of the Qwen label kernel.

chunk     phrases.jsonl (30k comments) -> freebuff/chunks/chunk-NNN.jsonl, 100 comments each plus 5
          gold comments at hidden positions, and freebuff/TASK.md with the concept list
check     progress, invalid names, and agreement with the gold labels per chunk
assemble  freebuff/out/*.json -> freebuff/dataset/labels.jsonl (the probe's input, a Kaggle dataset),
          gold rows left out

Usage: python research/concept-labels/freebuff.py chunk|check|assemble
"""
import json
import random
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parents[1] / "artifacts/benchmarks/concept-labels-20261012"
DIR = BENCH / "freebuff"
TAXONOMY = json.loads((HERE / "taxonomy.json").read_text(encoding="utf-8"))
CATEGORY = {c: cat for cat, cs in TAXONOMY.items() for c in cs}
PER_CHUNK, GOLD_PER_CHUNK = 100, 5
DATA = "https://huggingface.co/datasets/pilipolio/chess-positions-concepts/resolve/main/data.jsonl"


def jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def gold():
    sample = {r["k"]: r for r in jsonl(BENCH / "gold/sample.jsonl")}
    labels = json.loads((BENCH / "gold/consensus.json").read_text(encoding="utf-8"))
    claude = json.loads((BENCH / "gold/claude-prelabel.json").read_text(encoding="utf-8"))
    return sample, labels, claude


def chunk():
    sample, _, _ = gold()
    gold_i = {r["i"] for r in sample.values()}
    rows = [r for r in jsonl(BENCH / "phrases-output/phrases.jsonl") if r["i"] not in gold_i]
    rng = random.Random(0)
    (DIR / "chunks").mkdir(parents=True, exist_ok=True)
    (DIR / "out").mkdir(exist_ok=True)
    key = {}
    gold_cycle = list(sample)
    for n, start in enumerate(range(0, len(rows), PER_CHUNK)):
        items = [("row", r) for r in rows[start:start + PER_CHUNK]]
        for _ in range(GOLD_PER_CHUNK):
            k = gold_cycle[(n * GOLD_PER_CHUNK + _) % len(gold_cycle)]
            items.insert(rng.randrange(len(items) + 1), ("gold", sample[k]))
        name = f"chunk-{n:03d}"
        key[name] = [r["i"] if kind == "row" else f"gold:{r['k']}" for kind, r in items]
        (DIR / "chunks" / f"{name}.jsonl").write_text("".join(
            json.dumps({"id": j, "move": f"{r['mover']} played {r['move']}", "comment": r["comment"]},
                       ensure_ascii=False) + "\n" for j, (_, r) in enumerate(items)), encoding="utf-8")
    (DIR / "key.json").write_text(json.dumps(key), encoding="utf-8")
    concepts = (BENCH / "gold/TASK.md").read_text(encoding="utf-8").split("## Concepts", 1)[1]
    (DIR / "TASK.md").write_text(TASK.format(n=len(key), last=f"{len(key) - 1:03d}") + "## Concepts" + concepts, encoding="utf-8")
    print(len(key), "chunks,", len(rows), "comments")


TASK = """# Labelling task

The folder chunks/ holds {n} files, chunk-000.jsonl to chunk-{last}.jsonl, each about 105 chess
comments, one JSON object per line: "id", the move just played, and the comment on it.

For each chunk without a matching file in out/, write out/chunk-NNN.json: one JSON object mapping
each "id" (as a string) to the list of concepts below that the comment itself says are present or
immediately threatened in the position after the move, e.g. {{"0": ["fork", "threat"], "1": []}}.
Every id in the chunk, names exactly as listed.

- Leave out concepts that are only hypothetical (lines the players did not play) or about earlier
  moves, and do not add concepts the comment does not mention. Many comments mention one concept
  or none.
- Label by reading every comment. Do not write a keyword script or heuristic to label them.
- Hand chunks to sub-agents, several running in parallel, one chunk each, and keep going until
  every chunk has an output file. Each sub-agent reads only its chunk and this task, labels it
  itself and writes its output file. Do not read the chunks yourself.
- Do not read environment variables, tokens or API keys, do not call any external model or API,
  and do not open key.json or anything outside chunks/, out/ and TASK.md.
- Do not open or edit any other file, and do not change files in chunks/.

"""


def score(pred, ref):
    tp = sum(len(set(p) & set(r)) for p, r in zip(pred, ref))
    np_, nr = sum(map(len, pred)), sum(map(len, ref))
    return 2 * tp / (np_ + nr) if np_ + nr else 1.0


def outputs():
    key = json.loads((DIR / "key.json").read_text(encoding="utf-8"))
    for name, ids in key.items():
        path = DIR / "out" / f"{name}.json"
        if path.exists():
            try:
                out = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                yield name, ids, None, str(e)
                continue
            yield name, ids, out, None


def check():
    _, cons, claude = gold()
    done, bad, gp, gc, gl = 0, [], [], [], []
    for name, ids, out, err in outputs():
        if err:
            bad.append(f"{name}: {err}")
            continue
        done += 1
        missing = [j for j in range(len(ids)) if str(j) not in out]
        invalid = {t for v in out.values() for t in v if t not in CATEGORY}
        if missing or invalid:
            bad.append(f"{name}: {len(missing)} missing, invalid {sorted(invalid)[:5]}")
        p, c, l = [], [], []
        for j, src in enumerate(ids):
            if isinstance(src, str):
                k = src.split(":")[1]
                p.append([t for t in out.get(str(j), []) if t in CATEGORY])
                c.append(cons[k]), l.append(claude[k])
        gp += p; gc += c; gl += l
        print(f"{name}  gold F1 consensus {score(p, c):.2f}  claude {score(p, l):.2f}")
    key = json.loads((DIR / "key.json").read_text(encoding="utf-8"))
    print(f"\n{done}/{len(key)} chunks done; gold F1 vs claude {score(gp, gl):.3f} "
          f"(earlier DeepSeek run 0.793), vs consensus {score(gp, gc):.3f}")
    print("\n".join(bad) or "no format problems")


def assemble():
    rows = {r["i"]: r for r in jsonl(BENCH / "phrases-output/phrases.jsonl")}
    source = BENCH / "data.jsonl"  # the GameKnot source, for the position before each move
    if not source.exists():
        urllib.request.urlretrieve(DATA, source)
    with open(source, encoding="utf-8") as f:
        before = [json.loads(line)["previous_fen"] for line in f]
    (DIR / "dataset").mkdir(exist_ok=True)
    (DIR / "dataset/dataset-metadata.json").write_text(json.dumps({
        "title": "concept-labels-deepseek-20261013", "id": "vexylon/concept-labels-deepseek-20261013",
        "licenses": [{"name": "CC0-1.0"}]}), encoding="utf-8")
    with open(DIR / "dataset/labels.jsonl", "w", encoding="utf-8") as f:
        n = 0
        for name, ids, out, err in outputs():
            if err:
                continue
            for j, src in enumerate(ids):
                if isinstance(src, str) or str(j) not in out:
                    continue
                r = rows[src]
                tags = sorted({t for t in out[str(j)] if t in CATEGORY})
                f.write(json.dumps({**{k: r[k] for k in ("i", "game", "fen", "move", "mover", "comment")}, "before": before[src],
                                    "tags": tags, "cats": sorted({CATEGORY[t] for t in tags})},
                                   ensure_ascii=False) + "\n")
                n += 1
    print(n, "rows ->", DIR / "dataset/labels.jsonl")


if __name__ == "__main__":
    {"chunk": chunk, "check": check, "assemble": assemble}[sys.argv[1]]()
