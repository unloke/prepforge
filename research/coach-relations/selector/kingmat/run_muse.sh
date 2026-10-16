#!/bin/sh
# Muse Spark 1.3 (codex exec through magpie) judges kingmat/batch-NN.jsonl with RUBRIC.md into out-muse/, 2 at a time.
cd "$(dirname "$0")"
mkdir -p logs out-muse
for nn in 12 13 14 15 16 17 18 09 10 11 01 02 03 04 05 06 07 08; do [ -s out-muse/batch-$nn.jsonl ] || echo "$nn"; done |
  xargs -P 2 -I{} sh -c 'codex exec -m group/auto-muse-spark-1-3-contributor -c model_reasoning_effort=high --skip-git-repo-check "Read RUBRIC.md in this folder and follow it: judge every card in batch-{}.jsonl, but write your answers to out-muse/batch-{}.jsonl instead of out/. Work only on that batch; do not read files in out/ or out-muse/ other than the one you write." > logs/muse-{}.log 2>&1'
ls out-muse | wc -l
