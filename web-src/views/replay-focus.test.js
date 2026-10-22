import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { html as safeHtml } from "../html.js";

import {
  createReplayView,
  displayReplayResult,
  formatReplayDate,
  isDifferentOpening,
  moveNumberLabel,
  plyMoveLabel,
  revealIfOffscreen,
} from "./replay.js";

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
  pieceSvg: (piece) => safeHtml`<svg data-piece="${piece}"></svg>`,
};

function makeElements() {
  // The view binds chip/action listeners after render; stubs only need to
  // accept the queries (no real DOM, nothing to wire).
  const noElements = () => [];
  return {
    "replay-summary": { hidden: true, get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); }, querySelectorAll: noElements },
    "replay-results": { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); }, querySelectorAll: noElements },
  };
}

function makeView(elements, { renderers = RENDERERS } = {}) {
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return createReplayView({
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

// Early opponent departure ("different opening") and a late one ("novelty")
// share the left-prep bucket: one badge for both, so the ledger and the
// summary chip read the same word for the same count.
const earlyOpeningGame = {
  lichess_id: "early1",
  white: "me_user",
  black: "opp_two",
  result: "1-0",
  user_color: "white",
  in_repertoire: true,
  matched_plies: 3,
  departure_ply: 4,
  departure_move_uci: "g8f6",
  departure_reason: "opponent_unprepared_branch",
  repertoire_id: "rep-1",
  repertoire_name: "Caro-Kann: Advance",
  move_san_history: ["e4", "c6", "d4", "Nf6"],
  expected_move_uci: null,
  expected_move_san: null,
  training_recorded: false,
  source_account: "self",
};

const lateNoveltyGame = { ...earlyOpeningGame, lichess_id: "late1", departure_ply: 12,
  departure_move_uci: "h7h6", move_san_history: [...earlyOpeningGame.move_san_history] };

describe("replay focus internals", () => {
  it("escapes API text and attributes while preserving generated detail markup", () => {
    const elements = makeElements();
    const attack = '<img src=x onerror=alert(1)>';
    makeView(elements).renderReplayResults({ games: [{
      ...userErrorGame, white: attack, repertoire_name: attack,
      expected_move_san: attack, source_account: attack,
      finished_at: '2026-09-28T00:00:00Z" onmouseover="alert(1)',
    }] });
    const markup = String(elements["replay-results"].innerHTML);
    expect(String(markup)).not.toContain(attack);
    expect(String(markup)).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(String(markup)).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    expect(String(markup)).toContain('<svg data-piece="p">');
  });
  let elements;
  beforeEach(() => {
    elements = makeElements();
  });

  it("stages the ledger entrance once per result, not on every row click", () => {
    const view = makeView(elements);
    const payload = { games: [userErrorGame], misses_recorded: 0 };
    view.renderReplayResults(payload);
    expect(String(elements["replay-results"].innerHTML)).toContain("ledger-table list-enter");
    // A row click re-renders the SAME payload: the stagger must not replay.
    view.renderReplayResults(payload);
    expect(String(elements["replay-results"].innerHTML)).not.toContain("list-enter");
    // A new Check result animates again.
    view.renderReplayResults({ games: [userErrorGame], misses_recorded: 1 });
    expect(String(elements["replay-results"].innerHTML)).toContain("ledger-table list-enter");
  });

  it("counts games and queued moves with real plurals", () => {
    const second = { ...userErrorGame, lichess_id: "def456", white: "you", black: "opp_two", result: "1-0" };
    makeView(elements).renderReplayResults({ games: [userErrorGame, second], misses_recorded: 2 });
    const summary = String(elements["replay-summary"].innerHTML);
    expect(summary).toContain("2 you left prep");
    expect(summary).toContain("+2 moves queued for training");
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 1 });
    expect(String(elements["replay-summary"].innerHTML)).toContain("+1 move queued for training");
    // The ledger header counts games, not a bare number.
    expect(String(elements["replay-results"].innerHTML)).toContain("1 game \u00b7");
  });

  it("counts outcomes and queued moves with real plurals", () => {
    const second = { ...userErrorGame, lichess_id: "def456", white: "you", black: "opp_two", result: "1-0" };
    makeView(elements).renderReplayResults({ games: [userErrorGame, second], misses_recorded: 2 });
    const summary = String(elements["replay-summary"].innerHTML);
    // Two games, so the plural noun; one queued move stays singular at 1.
    expect(summary).toContain("2 you left prep");
    expect(summary).toContain("+2 moves queued for training");
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 1 });
    expect(String(elements["replay-summary"].innerHTML)).toContain("+1 move queued for training");
    // The ledger header counts games, not a bare number.
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    expect(String(elements["replay-results"].innerHTML)).toContain("1 game \u00b7");
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("renders a focus board derived from the real move history", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).toContain('data-testid="replay-focus-board"');
    // Decision-point position after 1. e4 c6 2. Nf3: the c6 pawn (repertoire
    // move) and the Nf3 knight must both be on their real squares.
    expect(String(html)).toContain('data-square="c6"');
    expect(String(html)).toContain('data-square="f3"');
    // Pieces render through the production SVG helpers.
    expect(String(html)).toMatch(/data-piece="p"/);
  });

  it("resolves You in the detail header like the ledger rows", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(html).toContain("<h2>opp_one vs You</h2>");
    expect(html).not.toContain("<h2>opp_one vs me_user</h2>");
  });

  it("renders the moveline as move-pair rows with the departure called out", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(html.match(/class="move-pair/g)).toHaveLength(2);
    expect(html).toContain('data-move="2"');
    expect(html).toMatch(/<div class="move-pair is-departure t-bad" data-move="2">/);
    expect(html).toMatch(/<span class="ply dep t-bad" data-ply="4" data-p="3">d5<\/span>/);
    expect(html).toContain('<span class="dep-note t-bad">You left prep</span>');
  });

  it("draws expected (good) vs played (bad) arrows from the payload UCIs", () => {
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).toContain('class="replay-arrows"');
    expect(String(html)).toContain('class="t-good"');
    expect(String(html)).toContain('class="t-bad"');
    // Shared board geometry, layered inside the mini board's square grid.
    expect(String(html)).toMatch(/<path class="t-good" d="M[^"]+ Z"/);
    expect(String(html)).toMatch(/<div class="scout-miniboard"[^>]*>.*<svg class="replay-arrows"[^]*<\/svg><\/div><\/div>/);
    // Move details name both moves; no standing colour legend.
    expect(String(html)).not.toContain('class="legend"');
  });

  it("tints ledger results by outcome and omits arrow legend for stayed games", () => {
    makeView(elements).renderReplayResults({ games: [stayedGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    // 1-0 with user_color white is a real win.
    expect(String(html)).toContain("r-win");
    // No departure → no departure legend entry, no arrow legend.
    expect(String(html)).not.toContain("k-dep");
    expect(String(html)).not.toContain("k-arrow-good");
    expect(String(html)).not.toContain('class="replay-arrows"');
  });

  it("falls back to the text-only detail card without board renderers", () => {
    makeView(elements, { renderers: null }).renderReplayResults({
      games: [userErrorGame],
      misses_recorded: 0,
    });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).not.toContain('data-testid="replay-focus-board"');
    // The production detail text survives the fallback.
    expect(String(html)).toContain("You diverged at 2…");
  });

  it("keeps draws on one line and names a single source account once", () => {
    const draw = { ...stayedGame, result: "1/2-1/2", finished_at: "2026-09-28T12:00:00Z" };
    makeView(elements).renderReplayResults({ games: [draw, userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).toContain(">½–½</span>");
    expect(String(html)).not.toContain("1/2-1/2");
    // Both games come from "self": the account sits in the header, not per row.
    expect(String(html).match(/class="acct"/g)).toHaveLength(1);
    expect(String(html)).toMatch(/2 games · <i class="acct"[^>]*>self<\/i>/);
    // The finish date is shown on the row.
    expect(String(html)).toContain('<time class="lr-date" datetime="2026-09-28T12:00:00Z">');
  });

  it("labels rows with their account when several accounts are mixed", () => {
    const other = { ...stayedGame, source_account: "alt_account" };
    makeView(elements).renderReplayResults({ games: [userErrorGame, other], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html).match(/class="acct"/g)).toHaveLength(2);
    expect(String(html)).not.toMatch(/games · <i class="acct"/);
  });

  it("names the account per row when two accounts were selected but one supplied every game", () => {
    makeView(elements).renderReplayResults({ games: [stayedGame, userErrorGame], misses_recorded: 0, requested_sources: 2 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).not.toMatch(/games · <i class="acct"/);
    expect(String(html).match(/class="acct"/g)).toHaveLength(2);
  });

  it("reveals the detail card after a row click when it is off screen", () => {
    const listeners = [];
    const focusCard = {
      getBoundingClientRect: () => ({ top: 900, bottom: 1300, height: 400 }),
      scrollIntoView: (opts) => listeners.push(["scroll", opts]),
    };
    const row = {
      dataset: { index: "1" },
      addEventListener: (_type, fn) => listeners.push(["click", fn]),
      focus: () => listeners.push(["focus"]),
    };
    elements["replay-results"] = {
      get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
      querySelectorAll: (sel) => (sel === ".lr[data-index]" ? [row] : []),
      querySelector: (sel) => (sel === ".focus" ? focusCard : sel.startsWith(".lr[") ? row : null),
    };
    globalThis.window = { innerHeight: 614, matchMedia: () => ({ matches: true }) };
    let open = 0;
    globalThis.document = { getElementById: (id) => elements[id] || null };
    const view = createReplayView({
      boardRenderers: RENDERERS,
      getReplayFilter: () => null,
      isGameOpen: (index) => index === open,
      onToggleFilter: () => {},
      onToggleGame: (index) => {
        open = index;
        view.renderReplayResults(payload);
      },
      onTrainMiss: () => {},
      onBuildReply: () => {},
      onAnalyze: () => {},
    });
    const payload = { games: [userErrorGame, stayedGame], misses_recorded: 0 };
    view.renderReplayResults(payload);
    // Initial render never scrolls.
    expect(listeners.some(([kind]) => kind === "scroll")).toBe(false);
    const click = listeners.find(([kind]) => kind === "click")[1];
    click();
    const scroll = listeners.find(([kind]) => kind === "scroll");
    expect(scroll[1]).toEqual({ block: "nearest", behavior: "auto" }); // reduced motion
    expect(listeners.some(([kind]) => kind === "focus")).toBe(true);
    globalThis.window = undefined;
  });

  it("does not scroll when the detail card is already visible", () => {
    const calls = [];
    const el = {
      getBoundingClientRect: () => ({ top: 80, bottom: 520, height: 440 }),
      scrollIntoView: (opts) => calls.push(opts),
    };
    expect(revealIfOffscreen(el, { innerHeight: 614 })).toBe(false);
    const below = { ...el, getBoundingClientRect: () => ({ top: 700, bottom: 1100, height: 400 }) };
    expect(revealIfOffscreen(below, { innerHeight: 614, matchMedia: () => ({ matches: false }) })).toBe(true);
    expect(calls).toEqual([{ block: "nearest", behavior: "smooth" }]);
  });

  it("formats results and dates for display only", () => {
    expect(displayReplayResult("1/2-1/2")).toBe("½–½");
    expect(displayReplayResult("1-0")).toBe("1-0");
    expect(displayReplayResult(null)).toBe("*");
    const now = new Date("2026-09-30T12:00:00Z");
    expect(formatReplayDate("2026-09-28T12:00:00Z", now)).toBe("Sep 28");
    expect(formatReplayDate("2025-03-02T12:00:00Z", now)).toBe("Mar 2, 2025");
    expect(formatReplayDate("", now)).toBe("");
    expect(formatReplayDate("not a date", now)).toBe("");
  });

  it("drops the arrow when the payload expected move is illegal on the derived position", () => {
    // e1e2 moves the white king while black is to move — illegal on the
    // decision-point position, so the good arrow must be dropped entirely.
    const stale = { ...userErrorGame, expected_move_uci: "e1e2" };
    makeView(elements).renderReplayResults({ games: [stale], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).toContain('class="replay-arrows"');
    expect(String(html)).not.toContain('class="t-good"');
    expect(String(html)).toContain('class="t-bad"');
  });
  it("names departures by move number, not ply (UX 2026-10-01 P2-9)", () => {
    expect(moveNumberLabel(1)).toBe("1.");
    expect(moveNumberLabel(2)).toBe("1…");
    expect(moveNumberLabel(5)).toBe("3.");
    expect(moveNumberLabel(0)).toBe("");
    expect(plyMoveLabel(2, ["e4", "c5"])).toBe("1… c5");
    makeView(elements).renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html)).not.toMatch(/Ply \d/);
    expect(String(html)).not.toMatch(/plies/);
    expect(String(html)).toContain("2… d5");
    // The move is a link now; its words are unchanged.
    expect(String(html).replace(/<[^>]+>/g, "")).toContain("in prep through 2. Nf3");
    expect(String(html)).toMatch(/class="move-ref"[^>]*data-p="2"[^>]*>2\. Nf3<\/span>/);
  });

  it("badges every opponent departure by who left, not which opening", () => {
    // One name for the shared bucket: the row badge, the focus badge and the
    // summary chip must match, so the count on the chip is the count under it.
    makeView(elements).renderReplayResults({
      games: [earlyOpeningGame, lateNoveltyGame],
      misses_recorded: 0,
    });
    const html = String(elements["replay-results"].innerHTML);
    expect(String(html).match(/kind-badge t-warn/g)).toHaveLength(3); // 2 rows + focus
    expect(String(html)).toContain(">Opponent left prep<");
    expect(String(html)).not.toContain("Different opening");
    expect(String(html)).not.toContain("Opponent novelty");
    // The summary chip reads the same words as the rows it counts.
    const summary = String(elements["replay-summary"].innerHTML);
    expect(summary).toContain("2 opponent left prep");
  });

  it("still splits the detail copy between an early opening and a late novelty", () => {
    for (const game of [earlyOpeningGame, lateNoveltyGame]) {
      const el = makeElements();
      makeView(el).renderReplayResults({ games: [game], misses_recorded: 0 });
      const html = String(el["replay-results"].innerHTML);
      const early = isDifferentOpening(game);
      if (early) expect(html).toContain("Opponent chose a different opening at");
      else expect(html).toContain("Opponent took an unprepared branch at");
      expect(html).not.toContain("novelty");
    }
  });
});


it("keeps partial-source failures visible with results and empty results", () => {
  const elements = makeElements();
  const view = makeView(elements);
  for (const games of [[userErrorGame], []]) {
    view.renderReplayResults({ games, source_errors: [{ username: "Unavailable", message: "429 rate limited" }] });
    expect(String(elements["replay-results"].innerHTML)).toContain('role="alert"');
    expect(String(elements["replay-results"].innerHTML)).toContain("Unavailable: 429 rate limited");
    expect(String(elements["replay-results"].innerHTML)).not.toContain("Retry Check");
  }
  view.renderReplayResults({ games: [] });
  expect(String(elements["replay-results"].innerHTML)).not.toContain('role="alert"');
  delete globalThis.document;
});

describe("replay empty states", () => {
  let elements;
  beforeEach(() => { elements = makeElements(); });
  afterEach(() => { globalThis.document = undefined; });

  it("tells the user what to do when a source returned no games", () => {
    makeView(elements).renderReplayResults({ games: [], misses_recorded: 0 });
    const markup = String(elements["replay-results"].innerHTML);
    expect(markup).toContain("No recent games found");
    expect(markup).toContain("Try a larger sample.");
  });

  it("keeps the ledger columns when there is nothing to list", () => {
    // An empty Games page was two lines of text on the page ground, with no
    // sign of the table they belonged to. Every empty state now sits in the
    // ledger body, under the same column headers as the rows.
    makeView(elements).renderReplayResults({ games: [], misses_recorded: 0 });
    const markup = String(elements["replay-results"].innerHTML);
    expect(markup).toContain("Games to review");
    expect(markup).toContain("lr head col-head");
    expect(markup).toContain('class="ledger-empty"');
    expect(markup).not.toContain("empty-state big");
  });

  it("names the empty bucket and keeps the way back", () => {
    // The filter comes from the app; drive it through a view whose getter says
    // "left-prep" while the sample holds only a user-error game.
    makeView(elements); // installs the DOM stubs
    const filtered = createReplayView({
      boardRenderers: RENDERERS,
      getReplayFilter: () => "left-prep",
      isGameOpen: () => false,
      onToggleFilter: () => {},
      onToggleGame: () => {},
      onTrainMiss: () => {},
      onBuildReply: () => {},
      onAnalyze: () => {},
    });
    filtered.renderReplayResults({ games: [userErrorGame], misses_recorded: 0 });
    const markup = String(elements["replay-results"].innerHTML);
    expect(markup).toContain("No games in this bucket");
    expect(markup).toContain("Nothing in this sample opponent left prep.");
    expect(markup).toContain("Show all");
  });
});

describe("replay failure state", () => {
  let elements;
  beforeEach(() => { elements = makeElements(); });
  afterEach(() => { globalThis.document = undefined; });

  it("says what failed and offers the same action again", () => {
    makeView(elements);
    const retries = [];
    const view = createReplayView({
      boardRenderers: RENDERERS,
      getReplayFilter: () => null,
      isGameOpen: () => false,
      onToggleFilter: () => {},
      onToggleGame: () => {},
      onTrainMiss: () => {},
      onBuildReply: () => {},
      onAnalyze: () => {},
      onRetry: () => retries.push(true),
    });
    view.renderReplayError("Lichess is unreachable");
    const markup = String(elements["replay-results"].innerHTML);
    expect(markup).toContain("Could not check your games");
    expect(markup).toContain("Lichess is unreachable");
    expect(markup).toContain("Try again");
    // A failure is not the idle prompt: nothing may read "No games checked yet".
    expect(markup).not.toContain("No games checked yet");
    expect(elements["replay-summary"].hidden).toBe(true);
    void retries;
  });

  it("puts the failure where the rows would be", () => {
    // The error is an answer to a Check, so it keeps the ledger the Check was
    // about instead of replacing the page with a floating card.
    makeView(elements).renderReplayError("Lichess is unreachable");
    const markup = String(elements["replay-results"].innerHTML);
    expect(markup).toContain("Games to review");
    expect(markup).toContain('class="ledger-empty"');
    expect(markup).toContain('role="alert"');
  });
});
