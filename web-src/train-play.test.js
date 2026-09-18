import { describe, it, expect } from "vitest";

import {
  START_FEN,
  resolvePlayColor,
  playPoolLabel,
  formatPlayTrail,
  takebackToUserMove,
  playSessionPgn,
} from "./train-play.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

describe("resolvePlayColor", () => {
  it("uses the picker for explorer starts", () => {
    expect(resolvePlayColor({ book: "explorer", pickerColor: "black" })).toBe("black");
    expect(resolvePlayColor({ book: "explorer", pickerColor: "white" })).toBe("white");
  });

  it("locks repertoire games to the repertoire color", () => {
    expect(
      resolvePlayColor({
        book: "repertoire",
        pickerColor: "white",
        repertoireColor: "black",
      }),
    ).toBe("black");
  });

  it("keeps both color choices when both selected repertoires are present", () => {
    expect(
      resolvePlayColor({
        book: "repertoire",
        pickerColor: "black",
        repertoireColors: ["white", "black"],
      }),
    ).toBe("black");
    expect(
      resolvePlayColor({
        book: "repertoire",
        pickerColor: "white",
        repertoireColors: ["white", "black"],
      }),
    ).toBe("white");
  });

  it("normalizes duplicate repertoire colors before deciding whether to lock", () => {
    expect(
      resolvePlayColor({
        book: "repertoire",
        pickerColor: "black",
        repertoireColors: ["white", "white"],
      }),
    ).toBe("white");
  });

  it("Lucky plays whoever is to move", () => {
    expect(
      resolvePlayColor({
        book: "explorer",
        pickerColor: "white",
        luckyFen: AFTER_E4,
      }),
    ).toBe("black");
  });
});

describe("playPoolLabel", () => {
  it("names the explorer rating span", () => {
    expect(playPoolLabel(1740)).toBe("1600–1800");
    expect(playPoolLabel(900)).toBe("1000");
  });
});

describe("formatPlayTrail", () => {
  it("numbers from the starting FEN", () => {
    const trail = formatPlayTrail(
      [
        { san: "e4", by: "user" },
        { san: "e5", by: "opp" },
        { san: "Nf3", by: "user" },
      ],
      START_FEN,
    );
    expect(trail).toBe("1. e4 e5 2. Nf3");
  });

  it("starts mid-game from a Lucky FEN (Black to move)", () => {
    const trail = formatPlayTrail([{ san: "e5", by: "user" }], AFTER_E4);
    expect(trail).toBe("e5");
  });
});

describe("takebackToUserMove", () => {
  const e4 = {
    san: "e4",
    uci: "e2e4",
    by: "user",
    fenAfter: AFTER_E4,
    nodeIdAfter: "e4",
  };
  const e5 = {
    san: "e5",
    uci: "e7e5",
    by: "opp",
    fenAfter: AFTER_E5,
    nodeIdAfter: "e5",
  };

  it("undoes the opponent reply and the user's last move", () => {
    const out = takebackToUserMove([e4, e5]);
    expect(out.history).toEqual([]);
    expect(out.fen).toBeNull();
  });

  it("from a later ply, restores the previous user position", () => {
    const nf3 = {
      san: "Nf3",
      uci: "g1f3",
      by: "user",
      fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      nodeIdAfter: "nf3",
    };
    const out = takebackToUserMove([e4, e5, nf3]);
    expect(out.history.map((p) => p.san)).toEqual(["e4", "e5"]);
    expect(out.fen).toBe(AFTER_E5);
    expect(out.nodeId).toBe("e5");
    expect(out.lastMove).toBe("e7e5");
  });

  it("as Black, undoing before you have moved clears the opponent's first ply", () => {
    const oppE4 = { ...e4, by: "opp" };
    const out = takebackToUserMove([oppE4]);
    expect(out.history).toEqual([]);
  });
});

describe("playSessionPgn", () => {
  it("tags You / Opponent from the user's color", () => {
    const pgn = playSessionPgn({
      userColor: "white",
      startFen: START_FEN,
      history: [{ san: "e4", by: "user" }],
    });
    expect(pgn).toContain('[White "You"]');
    expect(pgn).toContain('[Black "Opponent"]');
    expect(pgn).toContain("1. e4");
  });
});
