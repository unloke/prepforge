// The game on the Analyze board, named in one place so every surface that
// names it says the same thing: the players, then the result, event or date
// the PGN (or the recalled analysis) carries. Empty when no game is loaded, so
// the caller leaves its slot blank instead of explaining the blank.
import { pgnHeaderTags } from "./analyze-pgn.js";

export function analysisGameName(appState, pgnText) {
  const analysis = appState?.analysis;
  // Only name a game the board actually shows: the prefilled demo PGN sitting
  // unloaded in the source box must not title an empty board.
  const loaded = !!(analysis && ((analysis.moves && analysis.moves.length) || analysis.initialFen));
  if (!loaded) return "";
  const tags = pgnHeaderTags(pgnText || "");
  const known = (v) => (v && !/^[?*.\s]+$/.test(v) ? v : "");
  const white = known(tags.White) || known(analysis.white);
  const black = known(tags.Black) || known(analysis.black);
  const playersText = white || black ? `${white || "?"} vs ${black || "?"}` : "";
  const bits = [known(tags.Result) || known(analysis.result), known(tags.Event) || known(analysis.event), known(tags.Date)]
    .filter(Boolean);
  const plies = analysis.moves?.length || 0;
  return [playersText, bits.length ? bits.join(" · ") : plies ? `${plies} half-move${plies === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" · ");
}
