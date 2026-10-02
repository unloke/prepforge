// Book-departure line — what the coach says when an explored move steps out of the
// player's repertoire. Nothing is shown while the line is still in book; at the exact
// departure ply the coach adds one short sentence, and the caller appends the one useful
// action (train it / add it to the repertoire) as an inline chip.

// buildBookline({ kind, san, repName, expectedSan }) — kind: "user" | "opponent".
export function buildBookline({ kind, san, repName, expectedSan }) {
  if (kind === "user") return `Off your prep: ${repName} plays ${expectedSan} here.`;
  return `${san} isn't in ${repName} yet.`;
}
