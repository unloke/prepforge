import { describe, expect, it } from "vitest";

import { annotateRoute } from "./scout-route-audit.js";
import { renderV12PanelShell, renderV12Report, V12_BANNED_VOCAB } from "./scout-v12-report.js";

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fixtureAudit() {
  const advantage = annotateRoute(
    {
      verdict: "pass",
      sanLine: "e4 c5 Nf3",
      ucis: ["e2e4", "c7c5", "g1f3"],
      nodeGames: 2,
      riskLevel: "low",
      fragility: { narrowPath: false },
      actualReach: { fraction: 0.1, passed: 3, total: 30, reachLB: 0.2 },
      sfVerify: { nodeEvalCp18: 32 },
      robustness: {
        pass: true,
        replies: [
          { san: "d6", piTilt: 0.5, evalAfterCp: 33 },
          { san: "Nc6", piTilt: 0.3, evalAfterCp: 66 },
        ],
      },
    },
    [],
    "white",
  );
  advantage.tier = "advantage";

  const safe = annotateRoute(
    {
      verdict: "pass",
      sanLine: "d4 d5",
      ucis: ["d2d4", "d7d5"],
      nodeGames: 1,
      riskLevel: "medium",
      fragility: { narrowPath: false },
      actualReach: { fraction: 0.05, passed: 2, total: 40, reachLB: 0.1 },
      sfVerify: { nodeEvalCp18: -8 },
      robustness: {
        pass: true,
        replies: [{ san: "c4", piTilt: 0.4, evalAfterCp: -5 }],
      },
      policyResponses: [{ san: "c4", evalAfterCp: -5, internal: { piTilt: "INTERNAL_SENTINEL" } }],
      actualPlayerResponses: {
        responses: [{ san: "Nf6", uci: "g8f6", count: 2, wins: 1, draws: 0, losses: 1 }],
      },
    },
    [],
    "white",
  );
  safe.tier = "safe";
  // annotateRoute recomputes actual responses from games (empty here) — restore the fixture's.
  safe.actualPlayerResponses = {
    responses: [{ san: "Nf6", uci: "g8f6", count: 2, wins: 1, draws: 0, losses: 1 }],
  };

  const info = annotateRoute(
    {
      verdict: "pass",
      sanLine: "c4 e5",
      ucis: ["c2c4", "e7e5"],
      nodeGames: 0,
      riskLevel: "medium",
      fragility: { narrowPath: false },
      actualReach: { fraction: 0.01, passed: 2, total: 50, reachLB: 0.05 },
      sfVerify: { nodeEvalCp18: -25 },
      robustness: { pass: true, replies: [{ san: "Nc3", piTilt: 0.2, evalAfterCp: -22 }] },
      actualPlayerResponses: { responses: [], note: "no actual games reach this node" },
    },
    [],
    "white",
  );
  info.tier = "info";

  const fail = {
    verdict: "fail",
    sanLine: "e4 e5 Nf3",
    ucis: ["e2e4", "e7e5", "g1f3"],
    tier: null,
    riskLevel: "high",
    reasons: ["robustness failed vs top-3 tilted replies"],
    robustness: { pass: false, replies: [{ san: "Nc6", piTilt: 0.9, evalAfterCp: -40 }] },
    policyResponses: [{ san: "Nc6", evalAfterCp: -40, internal: { piTilt: 0.9 } }],
  };

  return {
    meta: { subjectColor: "white", games: 153, sfDepth: 18 },
    tendencies: [
      {
        featureId: "developsMinorFromHome",
        cohortLabel: "cohort-common",
        routes: [advantage, safe, info, fail],
      },
    ],
  };
}

describe("renderV12Report", () => {
  it("omits banned vocabulary from the ENTIRE rendered report, banner included", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    for (const word of V12_BANNED_VOCAB) {
      expect(html.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("renders actual and policy replies in separate labelled columns", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).toContain("他實戰走過(真實對局)");
    expect(html).toContain("模型推估回應(policy audit)");
    expect(html).toContain("scout-v12-replies-actual");
    expect(html).toContain("scout-v12-replies-policy");
    expect(html).toContain("模型排序的主要回應之一");
    expect(html).not.toContain("他最可能走");
  });

  it("never surfaces internal sentinel values in HTML", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).not.toContain("INTERNAL_SENTINEL");
    expect(html).not.toContain("piTilt");
  });

  it("renders per-route Analyze/Build action buttons with resolvable route keys", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).toContain('data-v12-action="analyze"');
    expect(html).toContain('data-v12-action="build"');
    // key format auditIdx:tendencyIdx:routeIdx — first passing route is 0:0:0
    expect(html).toContain('data-v12-route="0:0:0"');
    // fail routes are eliminated and get no action buttons
    const eliminated = html.split("scout-v12-eliminated")[1] || "";
    expect(eliminated).not.toContain("data-v12-action");
  });

  it("renders eval bars and W/D/L bars", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).toContain("scout-v12-evalbar-pos");
    expect(html).toContain("scout-v12-evalbar-neg");
    expect(html).toContain("scout-v12-wdl-bar");
    expect(html).toContain("scout-v12-wdl-w");
  });

  it("renders cards as <details>: advantage open by default, safe/info collapsed", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    const cards = html.match(/<details class="scout-v12-card"[^>]*>/g) || [];
    expect(cards.length).toBe(3); // fail route is eliminated, not a card
    expect(cards[0]).toContain(" open"); // advantage
    expect(cards[1]).not.toContain(" open"); // safe
    expect(cards[2]).not.toContain(" open"); // info
    expect(html).toContain('<summary class="scout-v12-card-head">');
  });

  it("renders a reach bar in the summary row", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).toContain("scout-v12-reachbar");
    expect(html).toContain("reach 10.0%");
  });

  it("renders a mini board per card via the injected renderer, from our side", () => {
    const seen = [];
    const html = renderV12Report(fixtureAudit(), {
      escapeHtml: esc,
      renderMiniBoard: (fen, orientation) => {
        seen.push({ fen, orientation });
        return `<div class="fake-board"></div>`;
      },
    });
    expect(html).toContain("scout-v12-board");
    expect((html.match(/fake-board/g) || []).length).toBe(3);
    // subject is white → we are black → board oriented from black's side
    expect(seen.every((s) => s.orientation === "black")).toBe(true);
    // advantage route e4 c5 Nf3 ends after Nf3 — knight sits on f3
    expect(seen[0].fen).toContain("5N2");
  });

  it("skips the board (keeps the card) when no renderer is supplied", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).not.toContain("scout-v12-board");
    expect(html).toContain("scout-v12-card");
  });

  it("shows tier copy and collapsed eliminated routes", () => {
    const html = renderV12Report(fixtureAudit(), { escapeHtml: esc });
    expect(html).toContain("不虧、可走的路線;不宣稱優勢");
    expect(html).toContain("他常走進來的路徑情報");
    expect(html).toContain("audit 淘汰");
    expect(html).toContain("robustness failed");
  });
});

describe("renderV12PanelShell", () => {
  it("keeps load controls open when no report is loaded", () => {
    const html = renderV12PanelShell({ escapeHtml: esc });
    expect(html).toContain('<details class="scout-v12-load-wrap" open>');
  });

  it("collapses load controls behind the summary once a report is present", () => {
    const html = renderV12PanelShell({ escapeHtml: esc, reportHtml: "<div>r</div>" });
    expect(html).toContain('<details class="scout-v12-load-wrap">');
    expect(html).toContain("replace current report");
  });
});