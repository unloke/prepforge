// Signed mate distance zero requires terminal winner metadata to disambiguate.
export const adverseMate = (mate, winner, preparing) => mate < 0 || Boolean(winner && winner !== preparing);
export const lostWinningMate = (before, after, afterWinner, preparing) =>
  before > 0 && !(after > 0) && afterWinner !== preparing;
