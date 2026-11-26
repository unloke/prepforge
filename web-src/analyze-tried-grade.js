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

// The coach will not grade this move (Grade moves is off, no engine, or its read came
// back empty): Retry shows a clear end state instead of "Checking" forever. A grade
// already known stays; a real grade later replaces this mark.
export const UNGRADED = "ungraded";
export function noteUngraded({ prevFen, lastUci } = {}) {
  if (prevFen && lastUci && !grades.has(`${prevFen}|${lastUci}`)) noteTriedGrade(prevFen, lastUci, UNGRADED);
}

export function triedGrade(fenBefore, uci) {
  return (fenBefore && uci && grades.get(`${fenBefore}|${uci}`)) || null;
}

export function onTriedGrade(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
