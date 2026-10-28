// "Add reply" opens the matched repertoire at the position the opponent left
// prep and PLAYS their move into the line, which is what "Add reply" says. It
// used to open Build one move earlier and rely on the incoming game's move;
// from the review that move never came, so the button dropped the user into
// Build at the wrong position with nothing added.
export async function buildReply(game, deps) {
  const { editRepertoire, getNode, isBuildReadOnly, localBoardInfo, onBuildBoardMove, isCurrent } = deps;
  await editRepertoire(game.repertoire_id, game.last_matched_node_id || null);
  if (!isCurrent()) return;
  const uci = game.departure_move_uci, node = getNode();
  if (!uci || !node || node.id !== game.last_matched_node_id || isBuildReadOnly()) return;
  if (!localBoardInfo(node.fen).legal_moves.includes(uci)) return;
  // Legality on the matched node is the check; the side test would reject a
  // legal reply whenever the repertoire's color disagrees with the payload.
  await onBuildBoardMove(uci);
}

export async function replayToAnalyze(game, deps) {
  const { switchView, orientAnalysisForSelf, loadPgnIntoAnalyze, showAnalysisPly,
    takeHandoff, setStatus, isCurrent, api, recallAnalysis, sourceSeq } = deps;
  const history = game.move_san_history || [];
  if (!history.length) return;
  const safe = (s) => String(s || "?").replace(/"/g, "'");
  const headers = [
    '[Event "Lichess game"]',
    `[Site "https://lichess.org/${safe(game.lichess_id || "")}"]`,
    `[White "${safe(game.white)}"]`, `[Black "${safe(game.black)}"]`,
    `[Result "${safe(game.result || "*")}"]`,
  ].join("\n");
  const movetext = history.map((san, i) => i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san).join(" ");
  const input = document.getElementById("pgn-input");
  if (!input) return;
  input.value = `${headers}\n\n${movetext} ${game.result || "*"}`;
  const drawer = document.getElementById("pgn-drawer");
  if (drawer) drawer.open = true;
  switchView("analyze");
  orientAnalysisForSelf(game.white, game.black);
  // Games used to reparse every entry as a fresh PGN, dropping a saved review's
  // classifications and chart. Resolve its owner-scoped saved game first.
  const saved = game.lichess_id
    ? (await api(`/api/analyses?lichess_id=${encodeURIComponent(game.lichess_id)}&limit=1`)).analyses[0]
    : null;
  if (!isCurrent()) return;
  const loaded = saved
    ? await recallAnalysis(saved.game_id, saved, { sourceSeq })
    : await loadPgnIntoAnalyze(input.value, { goToEnd: false, quiet: true, sourceSeq });
  if (!loaded || !isCurrent()) return;
  const handoff = takeHandoff({ reason: "review-in-analyze", gameId: game.lichess_id || undefined });
  const ply = (handoff?.ply ?? Number(game.departure_ply)) || 1;
  await showAnalysisPly(Math.max(0, ply - 1));
  if (isCurrent()) setStatus(saved
    ? `Loaded saved analysis for ${game.white || "?"} vs ${game.black || "?"}.`
    : `Loaded ${game.white || "?"} vs ${game.black || "?"}. Press Review.`);
}
