// The coach's live grade of a move played off the analyzed line, keyed by the
// position before it and the move. The review bar's Retry reads it: an alternative
// the engine rates as good as its own move is found, not "Not the best move".
// The coach already reads every move played on the board, so this costs no search.
const MAX_GRADES = 64;
const grades = new Map();
const listeners = new Set();

export function noteTriedGrade(fenBefore, uci, code) {
  if (!fenBefore || !uci || !code) return;
  const key = `${fenBefore}|${uci}`;
  if (grades.get(key) === code) return;
  grades.delete(key);
  grades.set(key, code);
  if (grades.size > MAX_GRADES) grades.delete(grades.keys().next().value);
  for (const listener of listeners) listener();
}

export function triedGrade(fenBefore, uci) {
  return (fenBefore && uci && grades.get(`${fenBefore}|${uci}`)) || null;
}

export function onTriedGrade(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
