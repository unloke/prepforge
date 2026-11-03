import { localBoardAfterMove, localBoardInfo, localPremoveMoves } from "./chess-local.js";
import { playPositionAfterReply } from "./train-opponent.js";
import { sideToMove } from "./train-play.js";

// A player's move lands synchronously. Only the opponent's reply is async, so
// a second gesture cannot race a half-applied move or mutate a replaced game.
export function createPlayMoveHandler({ appState, boards, advanceNode, recordPly, cursorSnapshot, endGame, opponentReply }) {
  return async function submitPlayMove(playedUci) {
    const play = appState.play;
    if (!play?.active || !playedUci) return;
    const fen = play.fen;
    if (sideToMove(fen) !== play.userColor) {
      if (localPremoveMoves(fen, play.userColor).includes(playedUci)) {
        play.premove = playedUci;
        boards.train.setPremove(playedUci);
      }
      return;
    }
    const info = localBoardInfo(fen);
    if (!info.legal_moves.includes(playedUci)) return;
    const nodeIdBefore = play.nodeId;
    const after = localBoardAfterMove(fen, playedUci);
    play.fen = after.board.fen;
    play.ply += 1;
    const repertoireCursorsBefore = advanceNode(playedUci);
    recordPly({
      uci: playedUci, san: after.move.san,
      fenBefore: info.fen, fenAfter: after.board.fen, by: "user",
      nodeIdBefore, nodeIdAfter: play.nodeId,
      repertoireCursorsBefore, repertoireCursorsAfter: cursorSnapshot(play),
    });
    const ended = playPositionAfterReply(after.board);
    boards.train.setPosition({
      fen: after.board.fen,
      legalMoves: ended.terminal ? [] : localPremoveMoves(after.board.fen, play.userColor),
      lastMove: playedUci,
    });
    if (ended.terminal) {
      play.result = ended.result;
      endGame(ended.banner);
      return;
    }
    await opponentReply();
  };
}
