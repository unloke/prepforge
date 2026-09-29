import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReplayView } from "./replay.js";

// Characterization for the ui-prototype-v2 Games focus internals:
//  - the focus card renders a board derived from the real move_san_history
//    (chess.js replay) — never a position the API did not produce;
//  - user-error games draw the production payload's expected_move_uci (good)
//    against departure_move_uci (played, bad);
//  - ledger rows carry outcome-tone results and the moveline legend explains
//    the in-prep / departure / expected / played marks.

const RENDERERS = {
  // Mirror app.js's production helpers (same contract as the Library preview).
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
  pieceSvg: (piece) => `<svg data-piece="${piece}"></svg>`,
};

function makeElements() {
  // The view binds chip/action listeners after render; stubs only need to
  // accept the queries (no real DOM, nothing to wire).
  const noElements = () => [];
  return {
    "replay-summary": { hidden: true, innerHTML: "", querySelectorAll: noElements },
    "replay-results": { innerHTML: "", querySelectorAll: noElements },
  };
}

function makeView(elements, { renderers = RENDERERS } = {}) {
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return createReplayView({
    escapeHtml: (s) => String(s),
    boardRenderers: renderers,
    getReplayFilter: () => null,
    isGameOpen: () => false,
    onToggleFilter: () => {},
    onToggleGame: () => {},
    onTrainMiss: () => {},
    onBuildReply: () => {},
    onAnalyze: () => {},
  });
}

// Real payload shape from GET /api/lichess/compare (services/lichess_fetch.py):
// Caro-Kann scene — the user plays black: 1. e4 c6 2. Nf3, then the user
// (black, ply 4) leaves prep: repertoire expected e6, user played d5. The
// focus board shows the position after 1. e4 c6 2. Nf3 (the decision point,
// black to move) with both arrows from that position.
const userErrorGame = {
  lichess_id: "abc123",
  white: "opp_one",
  black: "me_user",
  result: "0-1",
  user_color: "black",
  in_repertoire: true,
  matched_plies: 3,
  departure_ply: 4,
  departure_move_uci: "d7d5",
  departure_reason: "user_left_preparation",
  repertoire_id: "rep-1",
  repertoire_name: "Caro-Kann: Advance",
  move_san_history: ["e4", "c6", "Nf3", "d5"],
  expected_move_uci: "e7e6",
  expected_move_san: "e6",
  expected_node_id: "n3",
  last_matched_node_id: "n2",
  training_recorded: true,
  source_account: "self",
};

const stayedGame = {
  lichess_id: "def456",
  white: "me_user",
  black: "opp_two",
  result: "1-0",
  user_color: "white",
  in_repertoire: true,
  matched_plies: 2,
  departure_ply: null,
  departure_move_uci: null,
  departure_reason: "game_stayed_in_preparation",
  repertoire_id: "rep-1",
  repertoire_name: "Caro-Kann: Advance",
  move_san_history: ["e4", "c6", "d4", "d5"],
  expected_move_uci: null,
  expected_move_san: null,
  training_recorded: false,
  source_account: "self",
};

describe("replay focus internals", () => {
  let elements;
  beforeEach(() => {
    elements = makeElements();
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("renders a focus board derived from the real move history", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = elements["replay-results"].innerHTML;
    expect(html).toContain('data-testid="replay-focus-board"');
    // Decision-point position after 1. e4 c6 2. Nf3: the c6 pawn (repertoire
    // move) and the Nf3 knight must both be on their real squares.
    expect(html).toContain('data-square="c6"');
    expect(html).toContain('data-square="f3"');
    // Pieces render through the production SVG helpers.
    expect(html).toMatch(/data-piece="p"/);
  });

  it("draws expected (good) vs played (bad) arrows from the payload UCIs", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = elements["replay-results"].innerHTML;
    expect(html).toContain('class="replay-arrows"');
    expect(html).toContain('class="t-good"');
    expect(html).toContain('class="t-bad"');
    // Legend explains the two arrows (prototype spec, user-error focus).
    expect(html).toContain(">expected</span>");
    expect(html).toContain(">played</span>");
  });

  it("tints ledger results by outcome and omits arrow legend for stayed games", () => {
    makeView(elements).renderReplayResults({ games: [stayedGame], misses_recorded: 0 });
    const html = elements["replay-results"].innerHTML;
    // 1-0 with user_color white is a real win.
    expect(html).toContain("r-win");
    // No departure → no departure legend entry, no arrow legend.
    expect(html).not.toContain("k-dep");
    expect(html).not.toContain("k-arrow-good");
    expect(html).not.toContain('class="replay-arrows"');
  });

  it("falls back to the text-only detail card without board renderers", () => {
    makeView(elements, { renderers: null }).renderReplayResults({
      games: [userErrorGame],
      misses_recorded: 0,
    });
    const html = elements["replay-results"].innerHTML;
    expect(html).not.toContain('data-testid="replay-focus-board"');
    // The production detail text survives the fallback.
    expect(html).toContain("You diverged on ply 4");
  });

  it("drops the arrow when the payload expected move is illegal on the derived position", () => {
    // e1e2 moves the white king while black is to move — illegal on the
    // decision-point position, so the good arrow must be dropped entirely.
    const stale = { ...userErrorGame, expected_move_uci: "e1e2" };
    makeView(elements).renderReplayResults({ games: [stale], misses_recorded: 0 });
    const html = elements["replay-results"].innerHTML;
    expect(html).toContain('class="replay-arrows"');
    expect(html).not.toContain('class="t-good"');
    expect(html).toContain('class="t-bad"');
  });
});
