import { describe, expect, it } from "vitest";
import { html as safeHtml } from "./html.js";
import { createReplayView } from "./views/replay.js";
import { appSource } from "./test-app-source.js";

// The outcome filter is a view preference, not a position in the list:
//  - toggling a filter on and off again must bring the selected game back;
//  - a filter whose bucket is empty must not be a dead end (the chip that set
//    it is not drawn, so the card carries the way back);
//  - a new Check keeps the filter and drops the old selection.

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

const GAMES = [
  {
    lichess_id: "g1", white: "opp_one", black: "me_user", result: "0-1", user_color: "black",
    in_repertoire: true, matched_plies: 3, departure_ply: 4, departure_move_uci: "d7d5",
    departure_reason: "user_left_preparation", repertoire_id: "rep-1", repertoire_name: "Caro-Kann",
    move_san_history: ["e4", "c6", "Nf3", "d5"], expected_move_uci: "e7e6", expected_move_san: "e6",
    expected_node_id: "n3", training_recorded: true, source_account: "self",
  },
  {
    lichess_id: "g2", white: "me_user", black: "opp_two", result: "1-0", user_color: "white",
    in_repertoire: true, matched_plies: 3, departure_ply: 4, departure_move_uci: "g8f6",
    departure_reason: "opponent_unprepared_branch", repertoire_id: "rep-1", repertoire_name: "Caro-Kann",
    move_san_history: ["e4", "c6", "d4", "Nf6"], training_recorded: false, source_account: "self",
  },
  {
    lichess_id: "g3", white: "me_user", black: "opp_three", result: "1-0", user_color: "white",
    in_repertoire: true, matched_plies: 4, departure_ply: null, departure_move_uci: null,
    departure_reason: "game_stayed_in_preparation", repertoire_id: "rep-1", repertoire_name: "Caro-Kann",
    move_san_history: ["e4", "c6", "d4", "d5"], training_recorded: false, source_account: "self",
  },
];

function harness() {
  const open = new Set([0]);
  let filter = null;
  const toggles = [];
  const results = {
    get innerHTML() { return this._html ?? ""; },
    set innerHTML(value) { this._html = String(value); },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const summary = { hidden: true, innerHTML: "", querySelectorAll: () => [] };
  globalThis.document = {
    getElementById: (id) => (id === "replay-results" ? results : id === "replay-summary" ? summary : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const view = createReplayView({
    boardRenderers: RENDERERS,
    getReplayFilter: () => filter,
    isGameOpen: (index) => open.has(index),
    onToggleFilter: (kind) => { toggles.push(kind); },
    onToggleGame: () => {},
    onTrainMiss: () => {},
    onBuildReply: () => {},
    onAnalyze: () => {},
  });
  return {
    view, open, toggles, results,
    setFilter: (value) => { filter = value; },
    openRow: () => {
      const match = /data-index="(\d+)" aria-pressed="true"/.exec(results.innerHTML);
      return match ? Number(match[1]) : null;
    },
  };
}

describe("Games outcome filter", () => {
  it("keeps the selected game across a filter round trip", () => {
    const h = harness();
    h.view.renderReplayResults({ games: GAMES });
    expect(h.openRow()).toBe(0);

    // Filter to a bucket the selected game is not in: the ledger falls back
    // to the first visible row, but the selection itself is not thrown away.
    h.setFilter("left-prep");
    h.view.renderReplayResults({ games: GAMES });
    expect(h.openRow()).toBe(1);

    // Clearing the filter brings the user's own game back.
    h.setFilter(null);
    h.view.renderReplayResults({ games: GAMES });
    expect(h.openRow()).toBe(0);
  });

  it("offers a way out of an empty bucket", () => {
    const h = harness();
    h.setFilter("in-prep");
    h.view.renderReplayResults({ games: GAMES.filter((game) => game.departure_reason !== "game_stayed_in_preparation") });
    expect(h.results.innerHTML).toContain("No games in this bucket");
    expect(h.results.innerHTML).toContain("data-show-all");
  });

  it("app.js keeps the filter and the selection across a toggle", () => {
    const source = appSource();
    const toggle = source.slice(source.indexOf("onToggleFilter: (kind) => {"), source.indexOf("onToggleGame: (index) => {"));
    expect(toggle).not.toContain("replayOpen.clear()");
    expect(toggle).toContain("openIndex:");
    const compare = source.slice(source.indexOf("async function runLichessCompare("), source.indexOf("\n}\n", source.indexOf("async function runLichessCompare(")));
    expect(compare).not.toContain("appState.replayFilter = null;");
  });
});
