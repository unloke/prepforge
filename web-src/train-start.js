// A Start 400 that only means the server has nothing to serve. The Home row
// already owns that state (its Start reads "Open Repertoire"), so callers must
// not paint it as a fault. Covers the smart single- and mixed-repertoire
// messages and line rehearsal.
export function isNothingToTrainError(error) {
  return error?.status === 400 && /no (active repertoires|trainable (moves|lines))/i.test(error.message || "");
}
