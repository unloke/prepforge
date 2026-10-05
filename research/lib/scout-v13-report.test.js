import { describe, expect, it } from "vitest";

import { V12_BANNED_VOCAB } from "./scout-v12-report.js";
import { PERSONAL_SUBJECT_PHRASES } from "./scout-v13-package.js";
import {
  assertV13ReportClean,
  renderV13PanelShell,
  renderV13Report,
} from "./scout-v13-report.js";

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function personalEdge(uci, games, san = uci) {
  return {
    uci,
    san,
    evidenceSource: "personal",
    receipts: { games, wins: games - 1, draws: 0, losses: 1 },
  };
}

function cohortEdge(uci, san = uci) {
  return {
    uci,
    san,
    evidenceSource: "cohort",
    receipts: {
      explorerGames: 500,
      sharePct: 34,
      ratingBand: "1800,2000",
      speed: "blitz",
    },
  };
}

function engineEdge(uci, evalCp = 25, san = uci) {
  return {
    uci,
    san,
    evidenceSource: "engine",
    receipts: { evalCp, gapToBestCp: 5 },
  };
}

function fixturePackage(overrides = {}) {
  return {
    id: "black:e2e4 c7c5",
    subjectColor: "black",
    trunkUcis: ["e2e4", "c7c5", "g1f3", "d7d6"],
    entryUcis: ["e2e4"],
    trunk: {
      edges: [personalEdge("e2e4", 10, "e4"), personalEdge("c7c5", 8, "c5")],
      personalAnchorPly: 4,
      reachLB: 0.42,
    },
    extension: {
      ok: true,
      mainline: [engineEdge("d2d4", 22, "d4"), cohortEdge("g8f6", "Nf6")],
      branches: [
        {
          forkPlyIndex: 1,
          edges: [cohortEdge("b8c6", "Nc6"), engineEdge("e7e5", 10, "e5")],
        },
      ],
      leafCount: 2,
    },
    primaryStyle: "solid",
    styles: ["solid"],
    riskTags: ["CohortOnly"],
    auditedLeaves: [{ kind: "mainline", evalCp: 22 }],
    ...overrides,
  };
}

function fixtureResult(overrides = {}) {
  return {
    report: {
      packages: [fixturePackage()],
      bucketVacancies: [{ color: "black", bucket: "sharp" }],
      eliminated: [{ id: "x", reasons: ["extension:tooShort"] }],
    },
    meta: {
      sfDepth: 18,
      ratingBand: "1800,2000",
      speeds: "blitz",
      engineLabel: "browser",
      explorerAvailable: true,
    },
    ...overrides,
  };
}

describe("renderV13Report", () => {
  it("escapes XSS payloads in SAN, uci, style, and risk tags", () => {
    const pkg = fixturePackage({
      primaryStyle: `sharp"><img onerror=alert(1)>`,
      riskTags: [`ThinSample"><svg onload=alert(2)>`],
      trunk: {
        edges: [personalEdge("e2e4", 10, `<script>alert(3)</script>`)],
        personalAnchorPly: 2,
        reachLB: 0.2,
      },
      extension: {
        ok: true,
        mainline: [engineEdge("d2d4", 20, `"><img onerror=alert(4)>`)],
        branches: [],
        leafCount: 1,
      },
    });
    const html = renderV13Report({ report: { packages: [pkg], eliminated: [] }, meta: {} }, { escapeHtml: esc });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;script&gt;");
  });

  it("banned-vocab scan passes on realistic fixture HTML", () => {
    const html = renderV13Report(fixtureResult(), { escapeHtml: esc });
    assertV13ReportClean(html);
    for (const word of V12_BANNED_VOCAB) {
      expect(html.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("cohort/engine edges do not use personal-subject phrases", () => {
    const html = renderV13Report(fixtureResult(), { escapeHtml: esc });
    const extSection = html.split("scout-v13-extension")[1] || "";
    for (const phrase of PERSONAL_SUBJECT_PHRASES) {
      expect(extSection).not.toContain(phrase);
    }
    expect(extSection).toContain("同分段對局中常見回應");
    expect(extSection).toMatch(/引擎建議|引擎戰術回應/);
  });

  it("renders personal-anchor divider with correct ply", () => {
    const html = renderV13Report(fixtureResult(), { escapeHtml: esc });
    expect(html).toContain("個人樣本止於此(ply 4)");
    expect(html).toContain("scout-v13-anchor-divider");
  });

  it("renders a source chip on every extension edge", () => {
    const html = renderV13Report(fixtureResult(), { escapeHtml: esc });
    const ext = html.split("scout-v13-extension")[1] || "";
    expect((ext.match(/scout-v13-src/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(ext).toContain("scout-v13-src-cohort");
    expect(ext).toContain("scout-v13-src-engine");
  });

  it("shows honest empty state with elimination reasons", () => {
    const html = renderV13Report(
      {
        report: { packages: [], eliminated: [{ id: "a", reasons: ["factuality:cohort"] }] },
        meta: { explorerAvailable: false },
      },
      { escapeHtml: esc },
    );
    expect(html).toContain("尚無備戰套件");
    expect(html).toContain("同分段資料不可用(未連結 Lichess)");
    expect(html).toContain("延伸段缺少分段事實支撐");
  });

  it("shows bucket vacancy note", () => {
    const html = renderV13Report(fixtureResult(), { escapeHtml: esc });
    expect(html).toContain("此風格桶");
    expect(html).toContain("尖銳");
  });

  it("panel shell exposes generate/cancel controls and determinate progress", () => {
    const html = renderV13PanelShell({
      escapeHtml: esc,
      playerName: "rival",
      canGenerate: true,
      running: true,
      progressDone: 1,
      progressTotal: 4,
      progressLabel: "分析候選路線 2/4…",
    });
    expect(html).toContain("scout-v13-generate-btn");
    expect(html).toContain("scout-v13-cancel-btn");
    expect(html).not.toContain("is-indeterminate");
    expect(html).toContain("25%");
    expect(html).toContain("rival");
  });
});