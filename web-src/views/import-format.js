// File-type routing for the Dashboard's repertoire import (and any other caller that
// accepts either a PrepForge package or a PGN).
//
// The decision is EXTENSION-ONLY, deliberately: content sniffing (a leading "{") reads
// a PGN whose first line is a brace comment ({[%ev ...]} annotations, engine chatter)
// as JSON and sends it to the package importer, which fails with a confusing parse
// error. A .pgn file is always PGN; a .json file is always a PrepForge package.
// Anything else (no extension, .txt, …) is treated as PGN — PGN is the historical
// default and the more forgiving format.

export function isPackageJsonFilename(filename) {
  return String(filename || "")
    .toLowerCase()
    .endsWith(".json");
}

export const MALFORMED_JSON_IMPORT_ERROR =
  "This .json file is not a valid PrepForge repertoire package. Import PGNs as .pgn files.";
