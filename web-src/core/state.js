import { createNotices } from "../notices.js";

export { START_FEN, files } from "./board-constants.js";
// Each feature owns its state slice (web-src/state/); the shell keeps routing,
// the signed-in owner and the cross-feature repertoire listing here.
export { analysisState } from "../state/analysis.js";
export { buildState } from "../state/build.js";
export { replayState } from "../state/replay.js";
export { settingsState } from "../state/settings.js";
export { teamsState } from "../state/teams.js";
export { trainState } from "../state/train.js";

export const appState = {
  currentView: "dashboard",
  ownerGeneration: 0,
  repertoireList: [],
  // The owner generation /api/repertoires last answered for. Train uses it to
  // tell "listing still unknown" apart from an account that truly has none.
  repertoireListGeneration: -1,
  // Repertoires others shared with the user, at the user's role (Train drills them too).
  sharedRepertoireList: [],
  // Repertoire ids hidden from lists while their delete-undo window is open.
  pendingRepDeletes: new Set(),
  // Whether the durable outbox write succeeded. False means the queue only
  // lives in this tab, which the UI must state honestly.
  outboxPersisted: true,
  outboxStorageWarned: false,
  // The LIVE Lichess token's username (drives latest-game fetch / replay). Null when
  // the token is absent/expired even if still signed in.
  lichessUsername: null,
  gamesExternalCount: 0,
  // The account's stable Lichess username from auth status — persists across a token
  // drop and is what the user-name button shows. Null only for a true guest.
  accountUsername: null,
  // The account's user id (from auth status); lets the Teams view spot the caller in
  // a member list (remove-self / leave). Null for a guest.
  accountUserId: null,
  // Whether this browser's session is bound to a real PrepForge account (vs a guest).
  // Guests see the sign-in action; signed-in users get the account menu and may link
  // a Lichess account separately.
  signedIn: false,
  // Whether the session has been read yet. Until it has, `signedIn` is "unknown",
  // NOT "signed out": an owner-scoped view must hold a neutral loading state rather
  // than paint guest copy that a signed-in user would then see flashing on reload.
  authKnown: false,
  // Public share-link viewer (?shared=token). Team-shared read-only uses
  // build.writable === false instead — see isBuildReadOnly().
  sharedToken: null,
  pieceStyle: "berlin",
  // Maia3 strength: a Settings-pinned rating (null = AUTO), and the auto-resolved
  // rating from the linked Lichess account's public profile (null until fetched).
  maiaRatingPinned: null,
  maiaAutoRating: null,
};

export const boards = {};

export const notices = createNotices();
