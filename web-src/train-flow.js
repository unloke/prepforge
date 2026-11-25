// Keep the shared opening context when moving between sibling lines. Every
// run-in position comes from the start bundle, so replay needs no API calls.
export function planTrainRunIn(prompt, currentFen, previousPath = []) {
  const moves = prompt.run_in || [];
  const newLine = prompt.target_index === 0;
  const path = newLine ? moves : [...previousPath, ...moves];
  if (currentFen === prompt.fen_before) return { startFen: currentFen, moves: [], path };
  const onPath = path.findLastIndex((move) => move.fen_after === currentFen);
  if (onPath >= 0) return { startFen: currentFen, moves: path.slice(onPath + 1), path };
  let common = 0;
  let rewind = [];
  if (newLine) {
    while (common < moves.length && common < previousPath.length
      && moves[common].uci === previousPath[common].uci
      && moves[common].fen_after === previousPath[common].fen_after) common++;
    const currentIndex = previousPath.findLastIndex((move) => move.fen_after === currentFen);
    if (currentIndex >= 0) {
      for (let index = currentIndex - 1; index >= common - 1; index--) {
        if (index >= 0) rewind.push(previousPath[index]);
      }
      if (!common) rewind.push({ uci: "", fen_after: prompt.start_fen });
    }
  }
  return {
    startFen: common ? moves[common - 1].fen_after : prompt.start_fen,
    moves: moves.slice(common), path, rewind,
  };
}
