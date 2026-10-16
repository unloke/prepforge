#!/bin/sh
# One judge over ab/batch-NN.jsonl with RUBRIC.md: sh run.sh sol|muse [parallel]
# sol: codex exec -m codex/gpt-6.1-sol; muse: -m group/auto-muse-spark-1-3-contributor (pinned: the global magpie model gets switched).
cd "$(dirname "$0")"
j=$1; dir=out-$j
case $j in sol) m="-m codex/gpt-6.1-sol";; muse) m="-m group/auto-muse-spark-1-3-contributor";; *) echo "judge: sol or muse"; exit 1;; esac
mkdir -p logs $dir
for f in batch-*.jsonl; do nn=${f#batch-}; nn=${nn%.jsonl}; [ -s $dir/batch-$nn.jsonl ] || echo "$nn"; done |
  xargs -P ${2:-4} -I{} sh -c "codex exec $m -c model_reasoning_effort=high --skip-git-repo-check \"Read RUBRIC.md in this folder and follow it: judge every card in batch-{}.jsonl, but write your answers to $dir/batch-{}.jsonl instead of out/. Work only on that batch; do not read other judges' answers.\" > logs/$j-{}.log 2>&1"
ls $dir | wc -l
