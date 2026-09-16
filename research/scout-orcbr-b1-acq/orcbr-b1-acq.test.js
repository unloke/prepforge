import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACQ_PROTOCOL_ID,
  ACQ_VERDICTS,
  BURN_ON_EXECUTE,
  assertNoRawIdentityLeakage,
  assertFrozenBeforeFetch,
  acquireSubjectRaw,
  buildAcquisitionReport,
  buildAcquisitionUrl,
  buildFreezeSnapshot,
  buildManifest,
  capNdjsonBytes,
  executeAcquisition,
  extractCandidatesFromSourceText,
  forbiddenSubjectSet,
  selectSubjectPanel,
  sha256Hex,
  stripPanelForReport,
  subjectKey,
  validateAcquisitionProtocol,
  verifyCustodyArtifacts,
} from "./orcbr-b1-acq.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const PROTOCOL = JSON.parse(
  readFileSync(join(HERE, "orcbr-b1-acq.protocol.json"), "utf8"),
);

function makeNdjson(n, { username = "DrNykterstein" } = {}) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      id: `game${i}`,
      createdAt: 1_700_000_000_000 + i,
      players: {
        white: { user: { id: "SomeOpp" } },
        black: { user: { id: username } },
      },
      status: "resign",
      pgn: `[Event "T"]\n[White "SomeOpp"]\n[Black "${username}"]\n[Result "0-1"]\n\n1. e4 e5 *\n`,
    }));
  }
  return `${lines.join("\n")}\n`;
}

describe("protocol locks", () => {
  it("accepts the frozen acquisition protocol", () => {
    const v = validateAcquisitionProtocol(PROTOCOL);
    expect(v.ok).toBe(true);
    expect(PROTOCOL.protocolId).toBe(ACQ_PROTOCOL_ID);
    expect(PROTOCOL.networkEnabledDefault).toBe(false);
    expect(PROTOCOL.orcbrGatesAllowed).toBe(false);
    expect(PROTOCOL.productAuthorization).toBe(false);
    expect(PROTOCOL.productVerdict).toBe("preserve-v2");
    expect(PROTOCOL.moduleAStatus).toBe("CLOSED_NOT_REOPENED");
  });

  it("rejects product authorization true", () => {
    const v = validateAcquisitionProtocol({
      ...PROTOCOL,
      productAuthorization: true,
    });
    expect(v.ok).toBe(false);
  });

  it("rejects networkEnabledDefault true", () => {
    const v = validateAcquisitionProtocol({
      ...PROTOCOL,
      networkEnabledDefault: true,
    });
    expect(v.ok).toBe(false);
  });
});

describe("freeze-before-fetch", () => {
  it("builds freeze snapshot with acquisitionUntilMs boundary", () => {
    const built = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "abc",
      frozenAt: "2026-07-27T12:00:00.000Z",
    });
    expect(built.ok).toBe(true);
    expect(built.verdict).toBe(ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN);
    expect(built.snapshot.acquisitionUntilMs).toBe(
      Date.parse("2026-07-27T12:00:00.000Z"),
    );
    expect(built.snapshot.saltSha256).toBe(
      sha256Hex(PROTOCOL.salt.researchSalt),
    );
    expect(built.snapshot.freezeBeforeFetch).toBe(true);
    expect(built.snapshot.orcbrGatesAllowed).toBe(false);
  });

  it("refuses fetch without freeze snapshot", () => {
    const r = assertFrozenBeforeFetch(null);
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(ACQ_VERDICTS.STOP_ACQUISITION_FREEZE_REQUIRED);
  });

  it("acquireSubjectRaw without freeze returns STOP_ACQUISITION_FREEZE_REQUIRED", async () => {
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: null,
      rawUsername: "DrNykterstein",
      subjectKey: "subj_test",
      confirmExecute: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => "" }),
    });
    expect(r.verdict).toBe(ACQ_VERDICTS.STOP_ACQUISITION_FREEZE_REQUIRED);
  });
});

describe("forbidden-subject exclusion", () => {
  it("includes unbrainless87 and fixture subjects in forbidden set", () => {
    const set = forbiddenSubjectSet(PROTOCOL);
    expect(set.has("unbrainless87")).toBe(true);
    expect(set.has("subject1")).toBe(true);
    expect(set.has("opprepeat")).toBe(true);
  });

  it("never selects forbidden subjects even if present in sources", () => {
    const panel = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": 'const SCOUT_USER = "unbrainless87"; DrNykterstein',
        "scripts/scout-fetch-games.mjs": "subject1 OppRepeat unbrainless87",
      },
    });
    // DrNykterstein appears; forbidden ones excluded
    expect(panel.ok).toBe(true);
    expect(panel.subjects.every((s) => s._rawId !== "unbrainless87")).toBe(true);
    expect(panel.subjects.every((s) => s._rawId !== "subject1")).toBe(true);
    expect(panel.subjects.map((s) => s._rawId)).toEqual(["DrNykterstein"]);
  });

  it("STOP_ACQUISITION_PANEL_UNAVAILABLE when only forbidden appear", () => {
    const panel = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": "unbrainless87 subject1",
        "scripts/scout-fetch-games.mjs": "OppRepeat",
      },
    });
    expect(panel.ok).toBe(false);
    expect(panel.verdict).toBe(ACQ_VERDICTS.STOP_ACQUISITION_PANEL_UNAVAILABLE);
  });
});

describe("no result-based selection", () => {
  it("ignores performance scores and ORCBR outcome order", () => {
    // Only one allowlisted candidate appears; performance map must not change selection.
    const base = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": "DrNykterstein",
        "scripts/scout-fetch-games.mjs": "DrNykterstein",
      },
      performanceScores: { drnykterstein: 0.01 },
      orcbrOutcomeSubjects: ["someone_else_first"],
    });
    const alt = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": "DrNykterstein",
        "scripts/scout-fetch-games.mjs": "DrNykterstein",
      },
      performanceScores: { drnykterstein: 0.99 },
      orcbrOutcomeSubjects: ["drnykterstein"],
    });
    expect(base.ok).toBe(true);
    expect(alt.ok).toBe(true);
    expect(base.subjects.map((s) => s.subjectKey)).toEqual(
      alt.subjects.map((s) => s.subjectKey),
    );
    expect(base.resultBasedSelection).toBe(false);
    expect(base.orcbrOutcomeSelection).toBe(false);
  });

  it("extracts candidates only by literal allowlist match", () => {
    const found = extractCandidatesFromSourceText(
      'default DrNykterstein; not-a-candidate FooBar',
      PROTOCOL.subjectSource.candidateAllowlist,
    );
    expect(found).toEqual(["drnykterstein"]);
  });
});

describe("deterministic cap", () => {
  it("caps to first max complete non-empty lines with stable hash", () => {
    const raw = makeNdjson(5);
    const a = capNdjsonBytes(raw, 3);
    const b = capNdjsonBytes(raw, 3);
    expect(a.lineCount).toBe(3);
    expect(a.cappedText).toBe(b.cappedText);
    expect(sha256Hex(a.cappedText)).toBe(sha256Hex(b.cappedText));
    expect(a.cappedText.endsWith("\n")).toBe(true);
  });

  it("does not count empty lines toward cap", () => {
    const raw = "\n\n" + makeNdjson(2) + "\n\n";
    const c = capNdjsonBytes(raw, 2);
    expect(c.lineCount).toBe(2);
  });

  it("returns empty for max 0", () => {
    const c = capNdjsonBytes(makeNdjson(3), 0);
    expect(c.lineCount).toBe(0);
    expect(c.cappedText).toBe("");
  });
});

describe("network-disabled default", () => {
  it("returns ACQ_NETWORK_DISABLED without confirmExecute", async () => {
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "x",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: snap,
      rawUsername: "DrNykterstein",
      subjectKey: subjectKey("drnykterstein", PROTOCOL.salt.researchSalt),
      confirmExecute: false,
      fetchFn: async () => {
        throw new Error("fetch must not be called");
      },
    });
    expect(r.verdict).toBe(ACQ_VERDICTS.ACQ_NETWORK_DISABLED);
  });

  it("executeAcquisition respects network default", async () => {
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "x",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const panel = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": "DrNykterstein",
        "scripts/scout-fetch-games.mjs": "DrNykterstein",
      },
    });
    const r = await executeAcquisition({
      protocol: PROTOCOL,
      snapshot: snap,
      panel,
      confirmExecute: false,
      fetchFn: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(r.verdict).toBe(ACQ_VERDICTS.ACQ_NETWORK_DISABLED);
  });
});

describe("HTTP failure stops", () => {
  it("stops on non-2xx with STOP_ACQUISITION_HTTP_FAILURE", async () => {
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "x",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: snap,
      rawUsername: "DrNykterstein",
      subjectKey: "subj_x",
      confirmExecute: true,
      fetchFn: async () => ({ ok: false, status: 503, text: async () => "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(ACQ_VERDICTS.STOP_ACQUISITION_HTTP_FAILURE);
    expect(r.httpStatus).toBe(503);
  });

  it("stops on 429 without aggressive retry", async () => {
    let calls = 0;
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "x",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: snap,
      rawUsername: "DrNykterstein",
      subjectKey: "subj_x",
      confirmExecute: true,
      fetchFn: async () => {
        calls += 1;
        return { ok: false, status: 429, text: async () => "" };
      },
    });
    expect(r.verdict).toBe(ACQ_VERDICTS.STOP_ACQUISITION_RATE_LIMIT);
    expect(calls).toBe(1);
  });
});

describe("successful acquire + receipts (mocked network)", () => {
  it("preserves raw bytes, caps deterministically, and burns on execute", async () => {
    const raw = makeNdjson(5);
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "deadbeef",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const sk = subjectKey("drnykterstein", PROTOCOL.salt.researchSalt);
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: snap,
      rawUsername: "DrNykterstein",
      subjectKey: sk,
      confirmExecute: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => raw }),
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe(ACQ_VERDICTS.ACQ_EXECUTE_OK);
    expect(r.rawSha256).toBe(sha256Hex(raw));
    expect(r.cappedSha256).toBe(
      sha256Hex(capNdjsonBytes(raw, PROTOCOL.fetch.maxGamesPerSubject).cappedText),
    );
    expect(r.burnDeclaration).toBe(BURN_ON_EXECUTE);
    expect(r.httpReceipt.httpStatus).toBe(200);
    expect(r.httpReceipt.cappedLineCount).toBe(5);
  });

  it("builds URL with until boundary and max games", () => {
    const url = buildAcquisitionUrl("DrNykterstein", PROTOCOL, {
      untilMs: 1_720_000_000_000,
    });
    expect(url).toContain("lichess.org/api/games/user/DrNykterstein");
    expect(url).toContain("max=200");
    expect(url).toContain("until=1720000000000");
    expect(url).toContain("pgnInJson=true");
    expect(url).toContain("blitz%2Crapid%2Cclassical");
  });
});

describe("no raw identity in receipts/reports", () => {
  it("http receipt and report omit raw username", async () => {
    const raw = makeNdjson(2, { username: "DrNykterstein" });
    const snap = buildFreezeSnapshot(PROTOCOL, {
      protocolSha256: "p",
      frozenAt: "2026-07-27T12:00:00.000Z",
    }).snapshot;
    const sk = subjectKey("drnykterstein", PROTOCOL.salt.researchSalt);
    const r = await acquireSubjectRaw({
      protocol: PROTOCOL,
      snapshot: snap,
      rawUsername: "DrNykterstein",
      subjectKey: sk,
      confirmExecute: true,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => raw }),
    });
    const leak = assertNoRawIdentityLeakage(r.httpReceipt, "$.httpReceipt", {
      knownRawTokens: ["DrNykterstein", "drnykterstein"],
    });
    expect(leak.ok).toBe(true);

    const panel = selectSubjectPanel(PROTOCOL, {
      sourceTexts: {
        "tests/e2e/scout_smoke.mjs": "DrNykterstein",
        "scripts/scout-fetch-games.mjs": "DrNykterstein",
      },
    });
    const publicPanel = stripPanelForReport(panel);
    expect(JSON.stringify(publicPanel).toLowerCase()).not.toContain("drnykterstein");

    const manifest = buildManifest({
      protocol: PROTOCOL,
      snapshot: snap,
      panelPublic: publicPanel,
      subjectReceipts: [r],
    });
    const report = buildAcquisitionReport({
      protocol: PROTOCOL,
      snapshot: snap,
      panelPublic: publicPanel,
      executeResult: { ok: true, verdict: ACQ_VERDICTS.ACQ_EXECUTE_OK, subjects: [r], burnDeclaration: BURN_ON_EXECUTE },
      manifest,
    });
    for (const obj of [manifest, report, publicPanel]) {
      const L = assertNoRawIdentityLeakage(obj, "$", {
        knownRawTokens: ["DrNykterstein", "drnykterstein"],
      });
      expect(L.ok).toBe(true);
    }
    expect(report.productAuthorization).toBe(false);
    expect(report.orcbrGatesAllowed).toBe(false);
  });
});

describe("hash verification / tamper detection", () => {
  it("detects mutated raw bytes", () => {
    const raw = makeNdjson(2);
    const rawSha = sha256Hex(raw);
    const capped = capNdjsonBytes(raw, 2);
    const v = verifyCustodyArtifacts({
      snapshot: { protocolSha256: "x" },
      manifest: null,
      report: null,
      subjectFiles: [{
        subjectKey: "subj_a",
        rawBytes: Buffer.from(`${raw}tamper`, "utf8"),
        rawSha256: rawSha,
        cappedBytes: Buffer.from(capped.cappedText, "utf8"),
        cappedSha256: sha256Hex(capped.cappedText),
      }],
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe(ACQ_VERDICTS.TAMPER_DETECTED);
    expect(v.issues.some((i) => i.includes("raw tamper"))).toBe(true);
  });

  it("passes when hashes match", () => {
    const raw = makeNdjson(2);
    const capped = capNdjsonBytes(raw, 2);
    const report = { kind: "t", a: 1 };
    report.reportSha256 = sha256Hex(
      `${JSON.stringify({ kind: "t", a: 1 }, null, 2)}\n`,
    );
    // use computeReportSha256 path via verifyCustodyArtifacts
    const v = verifyCustodyArtifacts({
      snapshot: { protocolSha256: "x" },
      report: {
        kind: "t",
        a: 1,
        reportSha256: sha256Hex(`${JSON.stringify({ kind: "t", a: 1 }, null, 2)}\n`),
      },
      subjectFiles: [{
        subjectKey: "subj_a",
        rawBytes: Buffer.from(raw, "utf8"),
        rawSha256: sha256Hex(raw),
        cappedBytes: Buffer.from(capped.cappedText, "utf8"),
        cappedSha256: sha256Hex(capped.cappedText),
      }],
    });
    expect(v.ok).toBe(true);
  });
});

describe("live repo metadata selection", () => {
  it("selects panel from real source files without network", () => {
    const panel = selectSubjectPanel(PROTOCOL, { repoRoot: ROOT });
    // Allowlist candidate must appear in e2e + fetch scripts in this repo.
    expect(panel.ok).toBe(true);
    expect(panel.verdict).toBe(ACQ_VERDICTS.ACQ_PANEL_SELECTED);
    expect(panel.subjects.length).toBe(1);
    expect(panel.subjects[0]._rawId).toBe("DrNykterstein");
    expect(panel.subjects[0].subjectKey.startsWith("subj_")).toBe(true);
  });
});
