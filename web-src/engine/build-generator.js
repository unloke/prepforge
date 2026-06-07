// Build-Generate browser recursion (docs/browser-engine-migration.md Phase 3c).
//
// A PURE JavaScript port of the server's `OpeningBuilderService._expand` /
// `_upsert_child` (src/prepforge_chess/services/opening_builder.py:228-424). The server
// must never run engine compute in the public flow, so the generation recursion + node
// creation move to the browser; this module builds an in-memory subtree and emits a
// TREE-MUTATION PLAN that the server re-validates and persists (no compute).
//
// PARITY: this mirrors `_expand` line-by-line and adds NO rules of its own. It does NOT
// follow `services/opening_generation.py`, which has drifted from production `_expand`
// (different manual-prepared gating, repertoire-vs-own color, a Stockfish opponent path).
// The oracle for the tests is `tests/test_opening_builder.py`.
//
// PURE: depends only on injected adapters — no DOM, no fetch/API, no ORT/Stockfish import —
// so it unit-tests in node against fakes (like maia3-inference.js). Adapters:
//   engine.candidates(fen, count) -> [{ moveUci, evaluation, rank }]            (async)
//   maia.predictions(fen, rating) -> [{ move_uci, probability, rank }]          (async)
//   chess.sideToMove(fen)         -> "white" | "black"
//   chess.applyUci(fen, uci)      -> { uci, fenAfter } | null   (null = illegal → throw)
//
// The plan proposes INTENT only; the server recomputes the final `is_mainline` /
// `is_user_prepared_move`. The browser never decides persisted flags.

// MoveSource string values mirror core/models.py MoveSource.
export const SOURCE = Object.freeze({
  MANUAL: "manual",
  IMPORTED_PGN: "imported_pgn",
  GENERATED_STOCKFISH: "generated_stockfish",
  GENERATED_MAIA3: "generated_maia3",
});

// _expand thresholds (opening_builder.py imports these from opening_generation).
const MAINLINE_THRESHOLD = 0.1;
const BRANCH_THRESHOLD = 0.3;

// Sources a generation pass must never overwrite (user-authored), mirroring
// _upsert_child's `existing.source not in {MANUAL, IMPORTED_PGN}` guard.
const PROTECTED_SOURCES = new Set([SOURCE.MANUAL, SOURCE.IMPORTED_PGN]);

function abortError() {
  const err = new Error("Build generation aborted");
  err.name = "AbortError";
  return err;
}

// Mirror of OpeningBuilderService._clamp_rating (opening_builder.py:220-226): coerce to int,
// default 2200 on garbage, clamp 600-2600.
function clampRating(rating) {
  const value = Number.parseInt(rating, 10);
  if (Number.isNaN(value)) return 2200;
  return Math.max(600, Math.min(2600, value));
}

// Normalize a server/app subtree node (snake_case payload) into a mutable working node the
// recursion grows. The anchor (root of the recursion) and every existing descendant come
// in this shape so merge / manual-preservation / deeper re-expansion all match _expand.
function toWorkingNode(node, chess) {
  return {
    id: node.id ?? null, // existing node id; null for planned nodes
    tempId: null, // assigned when this is a freshly planned node
    fen: node.fen,
    sideToMove: node.side_to_move ?? chess.sideToMove(node.fen),
    moveUci: node.move_uci ?? node.uci ?? null,
    source: node.source ?? null,
    isMainline: !!node.is_mainline,
    // `/api/build/load` calls it `is_prepared`; accept that alias too so a raw payload
    // node fed directly here still preserves manual moves.
    isUserPreparedMove: !!(node.is_user_prepared_move ?? node.is_prepared),
    engineEvaluation: node.engine_evaluation ?? null,
    maiaProbability: node.maia_probability ?? null,
    children: Array.isArray(node.children) ? node.children.map((c) => toWorkingNode(c, chess)) : [],
  };
}

// child_by_uci (opening_generation.py:111-115).
function childByUci(node, moveUci) {
  return node.children.find((child) => child.moveUci === moveUci) || null;
}

// _manual_prepared_child_ucis (opening_builder.py:615-622): children that are user-prepared
// AND manually authored. These are the moves a generation pass must preserve verbatim.
function manualPreparedChildUcis(node) {
  const ucis = new Set();
  for (const child of node.children) {
    if (child.isUserPreparedMove && child.source === SOURCE.MANUAL && child.moveUci) {
      ucis.add(child.moveUci);
    }
  }
  return ucis;
}

// Convert the FLAT `/api/build/load` node list (each: id, parent_id, uci, fen,
// side_to_move, source, is_mainline, is_prepared, maia_probability, engine_evaluation, …)
// into the nested anchor subtree `generateBuildPlan` consumes. Pure + exported so app.js
// (Stage 4) doesn't hand-roll the conversion and lose manual/prepared or existing children.
// Field names are the REAL payload names (`uci`, `is_prepared`, `parent_id`); throws if the
// anchor id isn't present.
export function buildExistingSubtreeFromFlatNodes(flatNodes, rootNodeId) {
  const byId = new Map();
  const childrenByParent = new Map();
  for (const n of flatNodes || []) {
    byId.set(n.id, n);
    if (n.parent_id != null) {
      if (!childrenByParent.has(n.parent_id)) childrenByParent.set(n.parent_id, []);
      childrenByParent.get(n.parent_id).push(n);
    }
  }
  const anchor = byId.get(rootNodeId);
  if (!anchor) throw new Error(`anchor node ${rootNodeId} not found in build nodes`);

  const build = (flat) => ({
    id: flat.id,
    fen: flat.fen,
    side_to_move: flat.side_to_move,
    move_uci: flat.uci ?? flat.move_uci ?? null,
    source: flat.source ?? null,
    is_mainline: !!flat.is_mainline,
    is_user_prepared_move: !!(flat.is_user_prepared_move ?? flat.is_prepared),
    engine_evaluation: flat.engine_evaluation ?? null,
    maia_probability: flat.maia_probability ?? null,
    children: (childrenByParent.get(flat.id) || []).map(build),
  });
  return build(anchor);
}

export async function generateBuildPlan({
  rootFen,
  rootNodeId = null,
  existingSubtree = null,
  repertoireColor,
  ownColor = null,
  plyDepth,
  detailMode = "balanced",
  maiaRating,
  ownSideCandidateCount = 1,
  preserveManualPreparedMoves = true,
  engine,
  maia,
  chess,
  onProgress = () => {},
  signal = null,
} = {}) {
  if (!engine || !maia || !chess) throw new Error("generateBuildPlan requires engine, maia, and chess adapters");
  if (!repertoireColor) throw new Error("generateBuildPlan requires repertoireColor");

  // The recursion follows ownColor for "whose turn is the user's"; persisted
  // is_user_prepared_move is keyed to repertoireColor (recomputed server-side).
  const resolvedOwnColor = ownColor || repertoireColor;
  const depthLimit = Math.max(1, Math.floor(Number(plyDepth) || 1));
  const branchLimit = Math.max(1, Math.floor(Number(ownSideCandidateCount) || 1));
  const rating = clampRating(maiaRating);
  const mode = String(detailMode || "balanced").toLowerCase();

  // Anchor = root of the recursion. Use the supplied subtree when present (so existing
  // children merge), else synthesize a childless anchor from rootFen.
  const anchorSource =
    existingSubtree ||
    { id: rootNodeId, fen: rootFen, side_to_move: chess.sideToMove(rootFen), children: [] };
  const anchor = toWorkingNode(anchorSource, chess);
  // Every planned_add anchored at the root needs a real parentRef; a null anchor id would
  // produce an unanchored plan apply-plan must reject. Require it up front.
  if (anchor.id == null) {
    throw new Error("generateBuildPlan requires existingSubtree.id or rootNodeId (the anchor node id)");
  }

  const changes = [];
  const summary = { addedCount: 0, updatedCount: 0, highProbabilityUnprepared: 0 };
  let tempCounter = 0;

  const checkAbort = () => {
    if (signal && signal.aborted) throw abortError();
  };

  // _upsert_child (opening_builder.py:357-424). Returns the existing-or-new working node;
  // the caller recurses into it either way. Records the corresponding plan change.
  const upsertChild = (parent, moveUci, source, evaluation, probability, intendedMainline) => {
    const existing = childByUci(parent, moveUci);
    if (existing) {
      const changed = {};
      if (evaluation != null && existing.engineEvaluation == null) {
        existing.engineEvaluation = evaluation;
        changed.engineEvaluation = evaluation;
      }
      if (probability != null && existing.maiaProbability == null) {
        existing.maiaProbability = probability;
        changed.maiaProbability = probability;
      }
      if (!PROTECTED_SOURCES.has(existing.source) && existing.source !== source) {
        existing.source = source;
        changed.source = source;
      }
      if (Object.keys(changed).length > 0) {
        summary.updatedCount += 1;
        changes.push({ action: "updated", nodeId: existing.id, ...changed });
      }
      return existing;
    }

    // New child. An illegal move FAILS FAST (server apply_uci raises) — never a silent skip.
    const applied = chess.applyUci(parent.fen, moveUci);
    if (applied == null) {
      throw new Error(`illegal move ${moveUci} from ${parent.fen} (adapter returned no legal result)`);
    }
    // is_mainline = intended AND no existing sibling already claims the mainline.
    const isMainline = !!intendedMainline && !parent.children.some((c) => c.isMainline);
    // is_user_prepared_move keyed to REPERTOIRE color (not ownColor) — recomputed by the
    // server; tracked here only so we don't drift, never sent as a final flag.
    const isUserPreparedMove = parent.sideToMove === repertoireColor;
    const tempId = `tmp-${++tempCounter}`;
    const child = {
      id: null,
      tempId,
      fen: applied.fenAfter,
      sideToMove: chess.sideToMove(applied.fenAfter),
      moveUci,
      source,
      isMainline,
      isUserPreparedMove,
      engineEvaluation: evaluation ?? null,
      maiaProbability: probability ?? null,
      children: [],
    };
    parent.children.push(child);
    summary.addedCount += 1;
    // parentRef: existing node id, or a same-run tempId (tmp- prefix is never a real uuid).
    changes.push({
      action: "planned_add",
      tempId,
      parentRef: parent.id ?? parent.tempId,
      moveUci,
      source,
      intendedMainline: !!intendedMainline, // INTENT only; server computes final is_mainline
      engineEvaluation: evaluation ?? null,
      maiaProbability: probability ?? null,
    });
    if (probability != null && probability >= MAINLINE_THRESHOLD) summary.highProbabilityUnprepared += 1;
    onProgress(summary.addedCount);
    return child;
  };

  // _expand (opening_builder.py:228-355).
  const expand = async (node, relativePly, onMainlinePath) => {
    if (relativePly >= depthLimit) return;
    checkAbort();

    const userTurn = node.sideToMove === resolvedOwnColor;
    if (userTurn) {
      const manualPreparedUcis = preserveManualPreparedMoves
        ? manualPreparedChildUcis(node)
        : new Set();
      const candidateCount = branchLimit + manualPreparedUcis.size;

      checkAbort();
      const candidates = (await engine.candidates(node.fen, candidateCount)) || [];
      checkAbort();
      if (candidates.length === 0) return;

      let generatedBranches = 0;
      for (const candidate of candidates) {
        if (manualPreparedUcis.has(candidate.moveUci)) continue; // preserve manual move verbatim
        const child = upsertChild(
          node,
          candidate.moveUci,
          SOURCE.GENERATED_STOCKFISH,
          candidate.evaluation ?? null,
          null,
          manualPreparedUcis.size === 0, // intended mainline only when nothing manual is present
        );
        // off the mainline path once any manual-prepared move owns this node
        await expand(child, relativePly + 1, onMainlinePath && manualPreparedUcis.size === 0);
        generatedBranches += 1;
        if (generatedBranches >= branchLimit) break;
      }
      return;
    }

    // Opponent's turn → Maia only (no Stockfish), threshold 10% on mainline path else 30%.
    const threshold = onMainlinePath ? MAINLINE_THRESHOLD : BRANCH_THRESHOLD;
    checkAbort();
    const raw = (await maia.predictions(node.fen, rating)) || [];
    checkAbort();
    if (raw.length === 0) return;

    const predictions = raw.slice().sort((a, b) => b.probability - a.probability);
    let kept = predictions.filter((p) => p.probability >= threshold);
    if (kept.length === 0) kept = [predictions[0]];

    const mainlinePred = kept[0];
    const branchPreds = kept.slice(1);

    const mainChild = upsertChild(
      node,
      mainlinePred.move_uci,
      SOURCE.GENERATED_MAIA3,
      null,
      mainlinePred.probability,
      true,
    );
    await expand(mainChild, relativePly + 1, onMainlinePath); // mainline path unchanged

    for (const branchPred of branchPreds) {
      const branchChild = upsertChild(
        node,
        branchPred.move_uci,
        SOURCE.GENERATED_MAIA3,
        null,
        branchPred.probability,
        false,
      );
      if (mode === "simple") continue; // create the branch node but don't recurse
      await expand(branchChild, relativePly + 1, false); // now off the mainline path
    }
  };

  await expand(anchor, 0, true);

  return {
    rootNodeId: anchor.id ?? rootNodeId ?? null,
    addedCount: summary.addedCount,
    updatedCount: summary.updatedCount,
    highProbabilityUnprepared: summary.highProbabilityUnprepared,
    changes,
  };
}
