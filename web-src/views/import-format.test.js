import { describe, it, expect } from "vitest";

import {
  isPackageJsonFilename,
  MALFORMED_JSON_IMPORT_ERROR,
} from "./import-format.js";

describe("isPackageJsonFilename", () => {
  it("routes .json (any case) to the package importer", () => {
    expect(isPackageJsonFilename("prep.repforge.json")).toBe(true);
    expect(isPackageJsonFilename("CAROLINE.PREPForge.JSON")).toBe(true);
    expect(isPackageJsonFilename("carolinson.eyring.json")).toBe(true);
    expect(isPackageJsonFilename("1-sicilian.json")).toBe(true);
  });

  it("routes a {comment}-opening PGN to the PGN importer (the content-sniffing regression)", () => {
    // The old sniffing logic treated ANY text starting with "{" as JSON, so a PGN whose
    // first line is a brace comment failed as a package import. Extension-only routing
    // must keep every brace-comment PGN on the PGN path regardless of its filename.
    const pgnWithBraceComment = `{[%ev 0.32] {engine chatter} }
[Event "Training Game"]

1. e4 e5 2. Nf3 Nc6 *`;
    expect(pgnWithBraceComment.trim().startsWith("{")).toBe(true); // old sniff would say JSON
    expect(isPackageJsonFilename("annotated.pgn")).toBe(false);
    expect(isPackageJsonFilename("annotated.json.pgn")).toBe(false);
  });

  it("routes extensionless and unknown extensions to PGN (the forgiving default)", () => {
    expect(isPackageJsonFilename("game")).toBe(false);
    expect(isPackageJsonFilename("game.txt")).toBe(false);
    expect(isPackageJsonFilename("game.pgn.txt")).toBe(false);
    expect(isPackageJsonFilename("")).toBe(false);
    expect(isPackageJsonFilename(null)).toBe(false);
    expect(isPackageJsonFilename(undefined)).toBe(false);
  });

  it("does not treat a bare '{' body as JSON (routing is not content-based)", () => {
    // Even a file literally named after its content cannot flip the decision: only the
    // extension matters, so the malformed-JSON error below can only come from .json files.
    expect(isPackageJsonFilename("looks-like-json")).toBe(false);
  });

  it("exposes a clear malformed-package message", () => {
    expect(MALFORMED_JSON_IMPORT_ERROR).toMatch(/not a valid PrepForge repertoire package/i);
  });
});
