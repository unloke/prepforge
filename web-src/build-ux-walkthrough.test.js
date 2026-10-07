// Regressions for the 2026-09-30 UX walkthrough fixes on the Repertoire page
// (Explorer bars, Generate dialog, counts, ⋯ menu, Coverage's Maia gate,
// delete notice, loading state). Pure helpers run from their real app.js
// source; wiring that only exists as DOM glue is pinned by source checks.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appSource } from "./test-app-source.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = appSource();
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const dashboard = readFileSync(join(root, "views", "dashboard.js"), "utf8");

function extractByMarker(marker) {
  const start = app.indexOf(marker);
  if (start < 0) throw new Error("marker not found in app.js: " + marker);
  const nl = app.includes("\r\n") ? "\r\n" : "\n";
  const end = app.indexOf(`${nl}}${nl}`, start) + nl.length + 2;
  return app.slice(start, end);
}

function compile(names, deps = {}) {
  const src = names.map((n) => extractByMarker(n)).join("\n");
  const depNames = Object.keys(deps);
  const ret = names.map((n) => n.match(/function (\w+)/)[1]);
  return new Function(...depNames, `${src}\nreturn { ${ret.join(", ")} };`)(
    ...depNames.map((k) => deps[k]),
  );
}

describe("Explorer bars", () => {
  const { explorerThinSample, explorerSegLabel } = compile(
    ["function explorerThinSample(m) {", "function explorerSegLabel(pct) {"],
    { EXPLORER_THIN_SAMPLE: 10 },
  );

  it("draws every split full width so win rate, not game count, sets the bar", () => {
    const render = extractByMarker("function renderExplorerRows(stats, fen) {");
    expect(render).not.toContain("bar.width");
    expect(render).not.toMatch(/explorer-bar" style="width/);
  });

  it("flags thin samples so the row can step back", () => {
    expect(explorerThinSample({ total: 3 })).toBe(true);
    expect(explorerThinSample({ total: 500 })).toBe(false);
  });

  it("labels a segment only when it is wide enough; narrow ones rely on the tooltip", () => {
    expect(explorerSegLabel(72)).toBe("72%");
    expect(explorerSegLabel(8)).toBe("");
    expect(app).toContain('title="${label} ${value}%"');
  });

  it("uses theme tokens for the W/D/B colours, with a dark-theme override", () => {
    expect(css).toMatch(/\.explorer-bar-d \{ background: var\(--explorer-draw\)/);
    expect(css).toMatch(/\.explorer-bar-b \{ background: var\(--explorer-black\)/);
    const dark = css.slice(css.indexOf(':root[data-theme="dark"] {'));
    expect(dark.slice(0, dark.indexOf("\n}"))).toContain("--explorer-draw:");
  });
});

describe("Generate dialog", () => {
  const helpers = compile(
    [
      "function estimateBuildGenerateTotal({ plyDepth, mainThreshold, branchThreshold, userToMove = true }) {",
      "function clampGenerateInt(raw, min, max, fallback) {",
      "function readGenerateOptions(values, { userToMove = true } = {}) {",
      "function generateEstimateRange(options) {",
      "function generateEstimateText(options) {",
    ],
    {
      GEN_MAX_PLY_DEPTH: 20,
      GEN_MAX_OWN_MOVES: 10,
      GEN_DEFAULT_OWN_MOVES: 6,
      GEN_DEFAULT_MAIN_PCT: 10,
      GEN_DEFAULT_BRANCH_PCT: 30,
      STOCKFISH_MIN_DEPTH: 1,
      STOCKFISH_MAX_DEPTH: 30,
      effectiveMaiaRating: () => 1500,
      effectiveStockfishDepth: () => 16,
    },
  );

  it("counts depth in full moves and always ends the tree on your answer", () => {
    expect(helpers.readGenerateOptions({ own_moves: "3" }, { userToMove: true }).plyDepth).toBe(5);
    expect(helpers.readGenerateOptions({ own_moves: "3" }, { userToMove: false }).plyDepth).toBe(6);
    expect(helpers.readGenerateOptions({ own_moves: "99" }, { userToMove: false }).plyDepth).toBe(20);
    expect(helpers.readGenerateOptions({}).plyDepth).toBe(11);
  });

  it("reads every coverage knob, clamped, with defaults for blanks", () => {
    const opts = helpers.readGenerateOptions({ main_pct: "5", branch_pct: "99", maia_rating: "", engine_depth: "20" });
    expect(opts.mainThreshold).toBeCloseTo(0.05);
    expect(opts.branchThreshold).toBeCloseTo(0.5);
    expect(opts.maiaRating).toBe(1500);
    expect(opts.engineDepth).toBe(20);
    expect(helpers.readGenerateOptions({}).mainThreshold).toBeCloseTo(0.1);
    expect(helpers.readGenerateOptions({}).branchThreshold).toBeCloseTo(0.3);
  });

  it("estimates more moves for deeper or broader coverage", () => {
    const base = { plyDepth: 5, mainThreshold: 0.1, branchThreshold: 0.3 };
    const range = helpers.generateEstimateRange(base);
    expect(range.low).toBeLessThan(range.high);
    expect(helpers.generateEstimateRange({ ...base, plyDepth: 9 }).high).toBeGreaterThan(range.high);
    expect(helpers.generateEstimateRange({ ...base, mainThreshold: 0.05 }).high).toBeGreaterThan(range.high);
    const deep = helpers.generateEstimateRange({ ...base, plyDepth: 11 }).high;
    expect(helpers.generateEstimateRange({ ...base, plyDepth: 11, branchThreshold: 0.5 }).high).toBeLessThan(deep);
    expect(helpers.generateEstimateText(base)).toMatch(/^About \d+–\d+ new moves$/);
  });

  it("has no presets, no own-side alternatives and nothing folded away", () => {
    const fields = extractByMarker("function generateDialogFields() {");
    expect(fields).not.toContain("advanced: true");
    expect(fields).not.toContain("own_side_candidate_count");
    expect(fields).not.toContain("depth_preset");
    expect(fields).not.toContain("own_color");
    expect(app).not.toContain("GEN_DEPTH_PRESETS");
  });
});

describe("Move counts (P2-4)", () => {
  const { countBuildMovesToTrain } = compile(["function countBuildMovesToTrain(build) {"]);

  it("counts own-side moves on the enabled tree, like the Library's trainable count", () => {
    const build = {
      color: "white",
      nodes: [
        { id: "r", depth: 0, parent_id: null },
        { id: "a", depth: 1, parent_id: "r", move_side: "white" },
        { id: "b", depth: 2, parent_id: "a", move_side: "black" },
        { id: "c", depth: 3, parent_id: "b", move_side: "white" },
        { id: "d", depth: 2, parent_id: "a", move_side: "black", is_enabled: false },
        { id: "e", depth: 3, parent_id: "d", move_side: "white" },
      ],
    };
    expect(countBuildMovesToTrain(build)).toBe(2);
  });

  it("uses the same 'to train' wording on the Library row and the Repertoire header", () => {
    expect(dashboard).toContain("to train`");
    expect(dashboard).not.toContain("trainable move");
    expect(app).toContain("` · ${train} to train`");
  });
});

describe("Repertoire ⋯ menu matches the Library menu (P2-14)", () => {
  const { buildMenuItems } = compile(["function buildMenuItems({ hasRep, isActive }) {"]);

  it("offers the Library's repertoire actions (no redundant Open) plus page actions", () => {
    const actions = buildMenuItems({ hasRep: true, isActive: true }).map(([a]) => a);
    for (const shared of ["train", "share-link", "share-team", "toggle-active", "delete"]) {
      expect(actions).toContain(shared);
    }
    expect(actions).toContain("build-rename");
    expect(actions).toContain("build-export-pgn");
    expect(actions).not.toContain("edit");
    expect(buildMenuItems({ hasRep: true, isActive: false }).find(([a]) => a === "toggle-active")[1]).toBe("Enable");
    expect(buildMenuItems({ hasRep: false, isActive: true }).map(([a]) => a)).toEqual(["build-new-rep"]);
  });

  it("retires the 'builder' name in the Library menu", () => {
    expect(app).not.toContain("Edit in builder");
    expect(app).toContain('["edit", "Open in Repertoire"]');
  });
});

describe("Coverage uses explicit operation consent", () => {
  it("delegates to its controller without changing global Analyze preferences", () => {
    const scan = extractByMarker("async function runCoverageScanUI() {");
    expect(scan).toContain("ensureCoverageView()");
    expect(scan).toContain(".scan()");
    expect(scan).not.toContain("setPref(");
    const controller = readFileSync(join(root, "controllers", "coverage.js"), "utf8");
    expect(html).toContain('id="coverage-scope"');
    expect(html).toContain('id="coverage-depth"');
    expect(controller).toContain("getProvider()");
    expect(controller).not.toContain("maiaAnalysis");
    expect(controller).toContain("runCoverageScan(");
  });
});

describe("Move delete shows one notice, beside the tree (P1-1)", () => {
  it("uses the inline Undo card and no extra status toast", () => {
    const del = extractByMarker("async function deleteBuildNodeLocal(nodeId) {");
    expect(del).toContain('host: document.getElementById("build-undo")');
    expect(del).not.toMatch(/setStatus\(`Deleted/);
    expect(html).toContain('id="build-undo"');
    // The undo card sits in the tree column, before the Explorer dock.
    expect(html.indexOf('id="build-undo"')).toBeLessThan(html.indexOf('id="build-inspector"'));
  });
});

describe("Repertoire opens immediately with a loading state (P2-5)", () => {
  it("switches view and shows a skeleton before the load resolves", () => {
    const edit = extractByMarker("async function editRepertoire(repertoireId, nodeId = null) {");
    expect(edit.indexOf("setBuildLoading(true)")).toBeLessThan(edit.indexOf("await api("));
    const loading = extractByMarker("function setBuildLoading(on, { restore = true } = {}) {");
    expect(loading).toContain('switchView("build", { fromUrl: true })');
    expect(loading).toContain("tree-skeleton");
  });
});

describe("Selected tree move keeps contrast (P3-10)", () => {
  it("overrides the opponent-move grey on the selected pill", () => {
    expect(css).toMatch(/\.mtree-move\.is-current\.is-opp,[\s\S]{0,80}\{\s*color: var\(--accent-ink\)/);
  });
});
