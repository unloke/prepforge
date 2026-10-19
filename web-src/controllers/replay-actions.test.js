import { expect, it, vi } from "vitest";
import { buildReply } from "./replay-actions.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const legalMoves = ["g8f6", "g8h6", "b8c6", "e7e5", "d7d5"];
const game = { repertoire_id: "rep-1", last_matched_node_id: "n2", departure_move_uci: "g8f6", user_color: "white" };

function harness(overrides = {}) {
  const node = { id: "n2", fen: AFTER_E4 };
  const deps = {
    editRepertoire: vi.fn(async () => {}),
    getNode: () => node,
    isBuildReadOnly: () => false,
    localBoardInfo: () => ({ legal_moves: legalMoves }),
    onBuildBoardMove: vi.fn(async () => {}),
    isCurrent: () => true,
    ...overrides,
  };
  return { deps, node };
}

it("Add reply plays the opponent's departure move into the matched line", async () => {
  const { deps } = harness();
  await buildReply(game, deps);
  expect(deps.editRepertoire).toHaveBeenCalledWith("rep-1", "n2");
  // The whole point of the button: the move is added, not just the position opened.
  expect(deps.onBuildBoardMove).toHaveBeenCalledWith("g8f6");
});

it("Add reply still plays the move when the payload color disagrees with the tree", async () => {
  // A white repertoire can hold a black reply; the side in the game payload
  // must not veto a move the matched node says is legal.
  const { deps } = harness();
  await buildReply({ ...game, user_color: "black" }, deps);
  expect(deps.onBuildBoardMove).toHaveBeenCalledWith("g8f6");
});

it("Add reply does nothing when the departure move is not legal on the matched node", async () => {
  const { deps } = harness({ localBoardInfo: () => ({ legal_moves: ["e7e5"] }) });
  await buildReply(game, deps);
  expect(deps.onBuildBoardMove).not.toHaveBeenCalled();
});

it("Add reply does not add a move after the view changed or into a read-only tree", async () => {
  const changed = harness({ isCurrent: () => false });
  await buildReply(game, changed.deps);
  expect(changed.deps.onBuildBoardMove).not.toHaveBeenCalled();
  const readOnly = harness({ isBuildReadOnly: () => true });
  await buildReply(game, readOnly.deps);
  expect(readOnly.deps.onBuildBoardMove).not.toHaveBeenCalled();
});
