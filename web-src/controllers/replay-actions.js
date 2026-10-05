export async function buildReply(game, deps) {
  const { editRepertoire, getNode, isBuildReadOnly, localBoardInfo, onBuildBoardMove, isCurrent } = deps;
  await editRepertoire(game.repertoire_id, game.last_matched_node_id || null);
  if (!isCurrent()) return;
  const uci = game.departure_move_uci, node = getNode();
  if (!uci || !node || node.id !== game.last_matched_node_id || isBuildReadOnly()) return;
  const side = String(node.fen || "").split(" ")[1] === "b" ? "black" : "white";
  if (game.user_color && side === game.user_color) return;
  if (localBoardInfo(node.fen).legal_moves.includes(uci)) await onBuildBoardMove(uci);
}

export async function replayToAnalyze(game, deps) {
  const { switchView, orientAnalysisForSelf, loadPgnIntoAnalyze, showAnalysisPly,
    takeHandoff, setStatus, isCurrent } = deps;
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
  if (input) input.value = `${headers}\n\n${movetext} ${game.result || "*"}`;
  const drawer = document.getElementById("pgn-drawer");
  if (drawer) drawer.open = true;
  switchView("analyze");
  orientAnalysisForSelf(game.white, game.black);
  if (input) {
    await loadPgnIntoAnalyze(input.value, { goToEnd: false, quiet: true });
    if (!isCurrent()) return;
    const handoff = takeHandoff({ reason: "review-in-analyze", gameId: game.lichess_id || undefined });
    const ply = (handoff?.ply ?? Number(game.departure_ply)) || 1;
    await showAnalysisPly(Math.max(0, ply - 1));
  }
  if (isCurrent()) setStatus(`Loaded ${game.white || "?"} vs ${game.black || "?"} — press Analyze game`);
}
