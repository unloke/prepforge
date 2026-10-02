// Sub-line under "Not that one - try again" after a first miss in the Smart
// queue. A hint the user already asked for must survive the miss: falling back
// to a generic phase tip ("Develop your pieces…") after "Hint 2 · Piece" took
// the help away exactly when it was needed (UX walkthrough 2026-10-01 P1-4).
export function wrongMoveTip({ hintLevel = 0, hint = {}, expectedSan = "", coachTip = "" } = {}) {
  const level = Number(hintLevel) || 0;
  const strategy = hint && hint.strategy;
  const piece = hint && hint.piece;
  if (level >= 3 && expectedSan) return `Play ${expectedSan}`;
  if (level >= 2 && piece) return piece;
  if (level >= 1 && strategy) return strategy;
  return coachTip || strategy || piece || "";
}

// The Maia coach tip arrives asynchronously; it may only replace the line when
// the user has not asked for a more specific hint meanwhile.
export function coachTipMayReplace(hintLevel) {
  return !(Number(hintLevel) > 0);
}
