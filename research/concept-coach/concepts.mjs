// The taxonomy concept a Coach phrase names ("other" when none).
export const CONCEPT = [
  [/mate/, "mate_threat"], [/castles/, "castling"], [/promotes/, "promotion"], [/forks/, "fork"],
  [/skewers/, "skewer"], [/pin/, "pin"], [/develops/, "development"], [/centre/, "center_control"],
  [/passed pawn/, "passed_pawn"], [/open .-file/, "open_file"], [/^wins /, "winning_material"],
  [/^(trades|gives) /, "trades"], [/defends|out of attack/, "defense"],
  [/shuts in/, "passive_piece"], [/stops /, "prophylaxis"], [/attacks|hits|gives check/, "threat"],
];
export const concept = (phrase) => CONCEPT.find(([re]) => re.test(phrase))?.[1] || "other";
