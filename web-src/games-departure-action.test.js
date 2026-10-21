import { describe, expect, it } from "vitest";
import { html as safeHtml } from "./html.js";
import { createReplayView } from "./views/replay.js";

// The Train action drills the prepared move the user skipped. The server only
// records such a miss when the repertoire holds a move at the departure node
// (services/repertoire_matching.py: _pick_expected_child returns None when the
// node has no enabled child), so a game can arrive as "you left prep" with
// nothing to train. The card must not offer a button that can only fail, and
// must not claim the miss is in the training queue.

const RENDERERS = {
  parseFenBoard: (fen) => {
    const squares = {};
    fen.split(" ")[0].split("/").forEach((rankText, rankIndex) => {
      let fileIndex = 0;
      const rank = 8 - rankIndex;
      for (const char of rankText) {
        if (/\d/.test(char)) fileIndex += Number(char);
        else {
          squares[`${"abcdefgh"[fileIndex]}${rank}`] = char;
          fileIndex += 1;
        }
      }
    });
    return squares;
  },
  pieceSvg: (piece) => safeHtml`<svg data-piece="${piece}"></svg>`,
};

function baseGame(extra) {
  return {
    lichess_id: "g1", white: "opp_one", black: "me_user", result: "0-1", user_color: "black",
    in_repertoire: true, matched_plies: 3, departure_ply: 4, departure_move_uci: "d7d5",
    departure_reason: "user_left_preparation", repertoire_id: "rep-1", repertoire_name: "Caro-Kann",
    move_san_history: ["e4", "c6", "Nf3", "d5"], expected_move_uci: "e7e6", expected_move_san: "e6",
    source_account: "self",
    ...extra,
  };
}

function render(game) {
  const results = {
    get innerHTML() { return this._html ?? ""; },
    set innerHTML(value) { this._html = String(value); },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  globalThis.document = {
    getElementById: (id) => (id === "replay-results" ? results : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const view = createReplayView({
    boardRenderers: RENDERERS,
    getReplayFilter: () => null,
    isGameOpen: () => true,
    onToggleFilter: () => {},
    onToggleGame: () => {},
    onTrainMiss: () => {},
    onBuildReply: () => {},
    onAnalyze: () => {},
  });
  view.renderReplayResults({ games: [game] });
  return results.innerHTML;
}

describe("Games departure actions", () => {
  it("offers Train when the repertoire holds the move the user skipped", () => {
    const html = render(baseGame({ expected_node_id: "n3", training_recorded: true }));
    expect(html).toContain('data-act="train"');
    expect(html).toContain("Added to your training queue.");
  });

  it("says the miss is already queued when it was recorded by an earlier check", () => {
    const html = render(baseGame({ expected_node_id: "n3", training_recorded: false }));
    expect(html).toContain('data-act="train"');
    expect(html).toContain("Already in your training queue.");
  });

  it("offers no Train action and claims no queue entry without a prepared move", () => {
    const html = render(baseGame({ expected_node_id: null, training_recorded: false }));
    expect(html).not.toContain('data-act="train"');
    expect(html).not.toContain("training queue");
    expect(html).toContain("Your repertoire has no prepared move here.");
  });
});
