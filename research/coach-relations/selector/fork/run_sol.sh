#!/bin/sh
# sol judges fork/batch-NN.jsonl with RUBRIC.md, 4 batches at a time; logs in logs/.
cd "$(dirname "$0")"
mkdir -p logs out
for f in batch-*.jsonl; do nn=${f#batch-}; nn=${nn%.jsonl}; [ -s out/batch-$nn.jsonl ] || echo "$nn"; done |
  xargs -P 4 -I{} sh -c 'codex exec -m codex/gpt-6.1-sol -c model_reasoning_effort=high --skip-git-repo-check "Read RUBRIC.md in this folder and follow it: judge every card in batch-{}.jsonl and write out/batch-{}.jsonl. Work only on that batch; do not read other files in out/." > logs/sol-{}.log 2>&1'
ls out | wc -l
