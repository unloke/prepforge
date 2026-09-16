import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { epdOf } from "./scout-graph.js";
import {
  attachSharedYToPackages,
  buildPinnedSharedEngineIdentity,
  computeShadowPrepBuildArtifactHashes,
  scoreToWhiteCp,
  validateSharedYReceipt,
  verifyShadowPrepBuildArtifacts,
} from "./scout-shadow-prep-p0.js";
import {
  packagesWithSharedY,
  sharedYAttachmentIntegrityIssues,
} from "../scripts/scout-shadow-prep-p0.mjs";

const protocolPath = fileURLToPath(new URL(
  "../research/scout-shadow-prep/ericrosen-shadow-prep-p0.protocol.json",
  import.meta.url,
));
const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));

function legalReceipt(atom) {
  const engineIdentity = buildPinnedSharedEngineIdentity(protocol);
  const sideToMove = atom.postTriggerFen.split(" ")[1] === "b" ? "black" : "white";
  const selectedScoreCp = scoreToWhiteCp({ type: "cp", cp: 10 }, sideToMove);
  return {
    postTriggerEpd: atom.postTriggerUserToMoveEpd,
    postTriggerFen: atom.postTriggerFen,
    userResponseUci: "g1f3",
    safe: true,
    safetyMeasured: true,
    source: "stockfish",
    evalSwingCp: 0,
    bestScoreCp: selectedScoreCp,
    selectedScoreCp,
    multipvReturned: protocol.sharedYEngine.multipv,
    multipvEvidence: [{
      multipv: 1,
      score: { type: "cp", cp: 10 },
      scoreCp: selectedScoreCp,
      pvFirstMove: "g1f3",
    }],
    searchedDepth: protocol.sharedYEngine.depth,
    searchedMultipv: protocol.sharedYEngine.multipv,
    selectedMultipv: 1,
    selectedPv: ["g1f3"],
    selectedScore: { type: "cp", cp: 10 },
    engineIdentity,
  };
}

function syntheticBuildArtifacts() {
  const triggerFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const postTriggerFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const atom = {
    atomKey: "a",
    triggerEpd: epdOf(triggerFen),
    triggerFen,
    subjectUci: "e2e4",
    postTriggerUserToMoveEpd: epdOf(postTriggerFen),
    postTriggerFen,
    color: "white",
  };
  const candidatePackages = { white: { atoms: [atom] }, black: { atoms: [] } };
  const baselinePackages = { white: { atoms: [atom] }, black: { atoms: [] } };
  const sharedYReceipts = [legalReceipt(atom)];
  const materialChecks = { white: { ok: true, errors: [] }, black: { ok: true, errors: [] } };
  const materials = {
    candidate: {
      white: [{
        triggerEpd: atom.triggerEpd,
        subjectUci: atom.subjectUci,
        postTriggerEpd: atom.postTriggerUserToMoveEpd,
        userResponseUci: "g1f3",
        sanLine: "e4 Nf3",
        diagramCount: 1,
        textCharCount: 6,
        engineIdentityKey: "engine-key",
        ySource: "stockfish",
      }],
      black: [],
    },
    baseline: {
      white: [{
        triggerEpd: atom.triggerEpd,
        subjectUci: atom.subjectUci,
        postTriggerEpd: atom.postTriggerUserToMoveEpd,
        userResponseUci: "g1f3",
        sanLine: "e4 Nf3",
        diagramCount: 1,
        textCharCount: 6,
        engineIdentityKey: "engine-key",
        ySource: "stockfish",
      }],
      black: [],
    },
  };
  return {
    candidatePackages,
    baselinePackages,
    sharedYReceipts,
    materialChecks,
    materials,
  };
}

describe("scout-shadow-prep-p0 CLI helpers", () => {
  it("does not double-wrap protocol when attaching shared Y for census", () => {
    const triggerFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const postTriggerFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const atom = {
      atomKey: "a",
      triggerEpd: epdOf(triggerFen),
      triggerFen,
      subjectUci: "e2e4",
      postTriggerUserToMoveEpd: epdOf(postTriggerFen),
      postTriggerFen,
      color: "white",
    };
    const packages = {
      candidate: { white: { atoms: [atom] }, black: { atoms: [] } },
      baseline: { white: { atoms: [atom] }, black: { atoms: [] } },
    };
    const receipts = { white: [legalReceipt(atom)], black: [] };
    const engineIdentity = buildPinnedSharedEngineIdentity(protocol);
    expect(validateSharedYReceipt(receipts.white[0], {
      postTriggerEpd: atom.postTriggerUserToMoveEpd,
      engineIdentity,
      protocol,
    }).ok).toBe(true);
    const wrapped = packagesWithSharedY(packages, receipts, { protocol });
    const direct = attachSharedYToPackages(
      packages.candidate,
      receipts,
      { protocol },
    );
    expect(direct.ok).toBe(true);
    expect(wrapped.packages.candidate.white.atoms[0].userResponseUci)
      .toBe(direct.packages.white.atoms[0].userResponseUci);

    const doubleWrapped = attachSharedYToPackages(
      packages.candidate,
      receipts,
      { protocol: { protocol } },
    );
    expect(doubleWrapped.ok).toBe(false);
  });

  it("detects tampered build artifacts against manifest using temporary synthetic files", () => {
    const artifacts = syntheticBuildArtifacts();
    const artifactHashes = computeShadowPrepBuildArtifactHashes(artifacts);
    const manifest = {
      kind: "scout-shadow-prep-p0-build-manifest",
      version: 1,
      artifactHashes,
      materialChecks: artifacts.materialChecks,
    };
    const dir = mkdtempSync(join(tmpdir(), "shadow-prep-p0-"));
    try {
      const writeArtifact = (name, value) => {
        writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
      };
      writeArtifact("candidate-packages.json", artifacts.candidatePackages);
      writeArtifact("baseline-packages.json", artifacts.baselinePackages);
      writeArtifact("shared-y-receipts.json", artifacts.sharedYReceipts);
      writeArtifact("material-checks.json", artifacts.materialChecks);
      writeArtifact("candidate-white.json", artifacts.materials.candidate.white);
      writeArtifact("candidate-black.json", artifacts.materials.candidate.black);
      writeArtifact("baseline-white.json", artifacts.materials.baseline.white);
      writeArtifact("baseline-black.json", artifacts.materials.baseline.black);

      const loaded = {
        candidatePackages: JSON.parse(readFileSync(join(dir, "candidate-packages.json"), "utf8")),
        baselinePackages: JSON.parse(readFileSync(join(dir, "baseline-packages.json"), "utf8")),
        sharedYReceipts: JSON.parse(readFileSync(join(dir, "shared-y-receipts.json"), "utf8")),
        materialChecks: JSON.parse(readFileSync(join(dir, "material-checks.json"), "utf8")),
        materials: {
          candidate: {
            white: JSON.parse(readFileSync(join(dir, "candidate-white.json"), "utf8")),
            black: JSON.parse(readFileSync(join(dir, "candidate-black.json"), "utf8")),
          },
          baseline: {
            white: JSON.parse(readFileSync(join(dir, "baseline-white.json"), "utf8")),
            black: JSON.parse(readFileSync(join(dir, "baseline-black.json"), "utf8")),
          },
        },
      };
      expect(verifyShadowPrepBuildArtifacts(manifest, loaded).ok).toBe(true);

      const tamperedCandidate = {
        ...loaded.candidatePackages,
        white: { atoms: [{ atomKey: "tampered" }] },
      };
      writeArtifact("candidate-packages.json", tamperedCandidate);
      const tamperedLoaded = {
        ...loaded,
        candidatePackages: JSON.parse(readFileSync(join(dir, "candidate-packages.json"), "utf8")),
      };
      const check = verifyShadowPrepBuildArtifacts(manifest, tamperedLoaded);
      expect(check.ok).toBe(false);
      expect(check.issues.some((issue) => issue.kind === "artifact-hash-mismatch")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps scientific atom-count failures separate from shared-Y integrity failures", () => {
    expect(sharedYAttachmentIntegrityIssues([
      { arm: "candidate", color: "white", kind: "atom-count-after-y", count: 0, target: 6 },
      { arm: "candidate", color: "black", kind: "atom-count-after-y", count: 0, target: 6 },
    ])).toEqual([]);
    expect(sharedYAttachmentIntegrityIssues([
      { arm: "candidate", color: "white", atomKey: "a", errors: ["engine identity mismatch"] },
    ])).toHaveLength(1);
  });
});