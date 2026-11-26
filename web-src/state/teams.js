// The Teams view: the caller's teams and the expanded one.
// Written by views/teams*.js and team-directory.js.
export const teamsState = {
  // Teams view: cache of the caller's teams (for the rep-share picker) and the
  // currently-expanded team's id (so a member add/remove re-renders the right one).
  teams: [],
  selectedTeamId: null,
};
