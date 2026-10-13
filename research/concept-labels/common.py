"""Shared by the Kaggle GPU jobs (package.py inlines it): GameKnot rows and two-GPU generation.

Source: pilipolio/chess-positions-concepts data.jsonl (MIT), 350k GameKnot comments with the
position after the commented move. Two T4s, one vLLM model copy per GPU.
"""
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

MODEL = "Qwen/Qwen3-4B-Instruct-2507"
TP = 1  # GPUs per model copy: 1 = a copy per T4, 2 = one copy split over both
DATA = "https://huggingface.co/datasets/pilipolio/chess-positions-concepts/resolve/main/data.jsonl"
OUT = Path("/kaggle/working")
CHUNK = 2048  # rows per generate call
START = float(os.environ.get("JOB_START", time.time()))
MOVE_TOKEN = re.compile(r"^(\d+\.+)?(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#!?]*$|^\d+\.+$")


def engine_line(text):
    """Pasted engine analysis: an engine name up front, or mostly move notation."""
    words = text.replace("[", " ").replace("]", " ").split()
    if re.match(r"^\W*(fritz|rybka|stockfish|houdini|crafty|shredder)\b", text, re.I):
        return True
    return sum(bool(MOVE_TOKEN.match(w)) for w in words) >= 0.5 * len(words)


def letters(text):
    """Text compared without case, spacing or punctuation (GameKnot comments often run words together)."""
    return "".join(ch for ch in text.lower() if ch.isalnum())


def run(cmd):
    print("RUN", cmd, flush=True)
    subprocess.run(cmd, check=True)


def rows(limit=0):
    """Comments of 40+ characters that are not engine lines, in a fixed random order."""
    path = Path("/tmp/data.jsonl")
    if not path.exists():
        run(["wget", "-q", "-O", str(path), DATA])
    out = []
    for i, line in enumerate(path.open(encoding="utf-8")):
        r = json.loads(line)
        text = " ".join(r["comment"].split())
        if len(text) < 40 or engine_line(text):
            continue
        out.append({"i": i, "game": r["game_id"], "before": r["previous_fen"], "fen": r["fen"], "move": r["move_san"],
                    "mover": "Black" if r["side_to_move"] == "white" else "White", "comment": text[:600]})
    random.Random(0).shuffle(out)
    return out[:limit] if limit else out


def worker(gpu, items, path, messages, parse, max_new_tokens, deadline):
    """Greedy vLLM generation for `items` on GPUs `gpu` ("0", "1" or "0,1"); writes {**row, raw, **parse(raw, comment)} lines.

    The shared system prompt is prefix-cached. Chunks of CHUNK rows, so a deadline stop still
    leaves a random sample."""
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu)
    from vllm import LLM, SamplingParams
    llm = LLM(MODEL, dtype="half", max_model_len=4096, gpu_memory_utilization=0.9, enable_prefix_caching=True,
              tensor_parallel_size=TP)
    params = SamplingParams(temperature=0, max_tokens=max_new_tokens)
    t0 = time.time()
    with open(path, "w", encoding="utf-8") as f:
        for b in range(0, len(items), CHUNK):
            if time.time() - START > deadline:
                print(f"gpu{gpu} deadline at {b}/{len(items)}", flush=True)
                break
            chunk = items[b:b + CHUNK]
            outs = llm.chat([messages(r) for r in chunk], params, use_tqdm=False,
                            chat_template_kwargs={"enable_thinking": False})
            for r, o in zip(chunk, outs):
                raw = o.outputs[0].text.strip()
                f.write(json.dumps({**r, "raw": raw, **parse(raw, r["comment"])}, ensure_ascii=False) + "\n")
            f.flush()
            print(f"gpu{gpu} {b + len(chunk)}/{len(items)} {time.time() - t0:.0f}s", flush=True)


def two_gpus(data, out_name, messages, parse, max_new_tokens, deadline):
    """Run `worker` on both GPUs (subprocesses of this script: one per GPU, or one over both when
    TP = 2) and merge into OUT/out_name.

    True in the parent once merged; None in a worker subprocess."""
    if len(sys.argv) == 4:
        items = [json.loads(line) for line in open(sys.argv[2], encoding="utf-8")]
        return worker(sys.argv[1], items, sys.argv[3], messages, parse, max_new_tokens, deadline)
    run([sys.executable, "-m", "pip", "install", "-q", "-U", "vllm", "torchvision"])
    run([sys.executable, "-m", "pip", "uninstall", "-y", "torchaudio"])  # built for the old torch
    data, procs = data(), []
    gpus = ["0,1"] if TP == 2 else ["0", "1"]
    for k, gpu in enumerate(gpus):
        part = Path(f"/tmp/part{k}.jsonl")
        part.write_text("".join(json.dumps(r) + "\n" for r in data[k::len(gpus)]), encoding="utf-8")
        procs.append(subprocess.Popen([sys.executable, sys.argv[0], gpu, str(part), f"/tmp/out{k}.jsonl"],
                                      env={**os.environ, "JOB_START": str(START)}))
    if any(p.wait() for p in procs):
        raise RuntimeError("worker failed")
    with open(OUT / out_name, "w", encoding="utf-8") as f:
        for k in range(len(gpus)):
            f.write(Path(f"/tmp/out{k}.jsonl").read_text(encoding="utf-8"))
    print("generated", out_name, flush=True)
    return True
