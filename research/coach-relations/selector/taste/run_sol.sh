#!/bin/sh
# sol labels taste/batch-NN.jsonl with RUBRIC.md, 4 batches at a time; logs in logs/.
cd "$(dirname "$0")"
mkdir -p logs out
for nn in 01 02 03 04 05 06 07 08 09 10 11 12; do
  [ -s out/batch-$nn.jsonl ] && continue
  echo "$nn"
done | xargs -P 4 -I{} sh -c 'codex exec -m gpt-6.1-sol -c model_reasoning_effort=high --skip-git-repo-check "Read RUBRIC.md in this folder and follow it: judge every card in batch-{}.jsonl and write out/batch-{}.jsonl. Work only on that batch; do not read other files in out/ or cal/." > logs/sol-{}.log 2>&1'
ls out
