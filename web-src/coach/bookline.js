// Book-departure lines — what the coach SAYS when an explored move steps out of
// the player's repertoire. Same phrase-bank discipline as phrasebank.js: one
// bank per situation, every template the same shape, deterministic pick per
// move so the same departure always reads the same way. House style: no
// em-dashes, warm and plain-spoken.
//
// The sentence is conversation, not chrome: it renders inside the coach panel
// right after the move commentary, with the one useful action (train it / add
// it in Build) as a small inline chip at the end of the sentence. Nothing is
// shown while the line is still in book; the screen only carries what the
// player can use right now.
import { choose } from "./phrasebank.js";

// The player wandered off their OWN prep: name the script and the move it
// wanted. {san} = the move played, {rep} = repertoire name, {expected} = the
// prepared move. The action chip ("Train it") follows the sentence.
export const BOOK_USER_DEPARTS = [
  "That's off your script. {rep} answers with {expected} here.",
  "Hold on, {san} isn't your line. In {rep} you'd play {expected}.",
  "You've left your prep: {rep} calls for {expected} in this position.",
  "Not the move you rehearsed. {rep} goes {expected} here.",
  "Your prep took the other road: {rep} has {expected} in this spot.",
];

// The OPPONENT (the other colour) played something the book doesn't cover:
// there is nothing to recall, only a gap worth filling. The action chip
// ("Add it in Build") follows the sentence.
export const BOOK_OPPONENT_NOVELTY = [
  "New territory: {san} isn't covered in {rep} yet.",
  "{san} steps outside {rep}. Worth deciding on an answer.",
  "{rep} has nothing on {san} yet, so this is uncharted for you.",
  "Off your map: {rep} doesn't cover {san}.",
];

// Compose the departure sentence. kind: "user" | "opponent". Returns the bare
// sentence; the caller appends the action chip (markup stays out of the bank).
export function buildBookline({ kind, san, uci, ply, repName, expectedSan }) {
  const f = { san, uci, ply };
  if (kind === "user") {
    return choose(f, "book-user", BOOK_USER_DEPARTS, {
      san,
      rep: repName,
      expected: expectedSan,
    });
  }
  return choose(f, "book-opp", BOOK_OPPONENT_NOVELTY, { san, rep: repName });
}
