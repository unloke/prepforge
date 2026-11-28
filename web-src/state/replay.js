// The Games view (replay results and the Games / Scout section).
// Written by views/games-controller.js and the shell's routing.
export const replayState = {
  replayResults: null,
  replayFilter: null, // summary-chip filter: an outcome kind, or null = all
  replayOpenIndex: undefined, // undefined selects the first row, null closes all rows
  replaySection: "games",
};
