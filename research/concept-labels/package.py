"""Build the Kaggle kernels for the concept-label study (no local compute).

python research/concept-labels/package.py phrases|label|probe <kernel-dir> [--smoke] [--model=HF_ID --tp=2 --tag=NAME]

phrases  GameKnot comments -> open-vocabulary idea phrases and their clusters (GPU, Qwen3-4B)
label    GameKnot comments -> taxonomy.json concepts (GPU, Qwen3-4B), labels.jsonl
probe    DeepSeek labels (freebuff.py) -> board audit, Maia3/plain routers, concepts for the production Coach positions
"""
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
DATE = "20261013"
kind, out = sys.argv[1], pathlib.Path(sys.argv[2])
smoke = "--smoke" in sys.argv
opts = dict(a[2:].split("=", 1) for a in sys.argv[3:] if "=" in a)  # --model=HF_ID --tp=2 --tag=NAME
tag = f"-{opts['tag']}" if "tag" in opts else ""
LABELS = f"vexylon/concept-labels-deepseek-{DATE}"  # freebuff.py assemble, uploaded as a dataset
name = lambda k: f"vexylon/concept-{k}{'-smoke' if smoke else ''}{tag}-{DATE}"
src = (HERE / f"{kind}_job.py").read_text(encoding="utf-8")
common = (HERE / "common.py").read_text(encoding="utf-8")
if "model" in opts:
    common = re.sub(r'^MODEL = .*$', lambda _: f'MODEL = "{opts["model"]}"', common, count=1, flags=re.M)
if "tp" in opts:
    common = re.sub(r'^TP = 1 ', lambda _: f'TP = {int(opts["tp"])} ', common, count=1, flags=re.M)
src = re.sub(r"^from common import .*$", lambda _: common, src, count=1, flags=re.M)
if kind == "phrases" and smoke:
    src = src.replace("LIMIT = 30000", "LIMIT = 600")
if kind == "label":
    taxonomy = json.loads((HERE / "taxonomy.json").read_text(encoding="utf-8"))
    src = src.replace("TAXONOMY = {}", f"TAXONOMY = {json.dumps(taxonomy, ensure_ascii=False)}", 1)
    if smoke:
        src = src.replace("LIMIT = 0", "LIMIT = 1200", 1)
if kind == "probe":
    rows = [json.loads(line) for line in (HERE.parent / "coach-prod-v2/after.jsonl").open(encoding="utf-8")]
    coach = [{k: r[k] for k in ("id", "fen", "uci", "bestUci")} for r in rows]
    src = src.replace("COACH = []", f"COACH = {json.dumps(coach)}", 1)
out.mkdir(parents=True, exist_ok=True)
(out / "job.py").write_text(src, encoding="utf-8")
(out / "kernel-metadata.json").write_text(json.dumps({
    "id": name(kind), "title": name(kind).split("/")[1], "code_file": "job.py", "language": "python",
    "kernel_type": "script", "is_private": "true", "enable_gpu": "true", "machine_shape": "NvidiaTeslaT4",
    "enable_internet": "true", "dataset_sources": [LABELS] if kind == "probe" else [], "competition_sources": [],
    "kernel_sources": []}, indent=2))
print(json.dumps({"kind": kind, "slug": name(kind), "bytes": len(src)}))
