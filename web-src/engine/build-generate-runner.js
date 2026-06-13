// Build-Generate browser orchestrator (docs/browser-engine-migration.md Phase 3c, Stage 2).
//
// Binds the pure recursion planner (build-generator.js) to the REAL browser engines:
//   - Stockfish candidates on our turn  (stockfish-provider.js, MultiPV, depth 8)
//   - Maia predictions on the opponent's turn (maia3-provider.js)
// One provider/worker is reused across the whole recursion (NOT one per node). The server
// never computes — this produces a tree-mutation plan the server later re-validates.
//
// The adapters are exported separately so they unit-test against fake providers; the
// orchestrator takes injectable factories for the same reason.
import { Chess } from "chess.js";

import { createEngineProvider, isBrowserEngineAvailable } from "./stockfish-provider.js";
import { createMaia3Provider } from "./maia3-provider.js";
import { isTerminalPosition } from "./game-analyzer.js";
import { generateBuildPlan, buildExistingSubtreeFromFlatNodes, SOURCE } from "./build-generator.js";

const DEFAULT_GEN_DEPTH = 8; // match the server's GenerateConfig / EngineAnalysisConfig(depth=8)
const DEFAULT_MAX_MULTIPV = 5; // standalone adapter default; the orchestrator sizes it precisely
const MULTIPV_CEILING = 256; // Stockfish's hard MultiPV maximum
const POLL_MS = 90;
const PER_POSITION_TIMEOUT_MS = 30000; // a stuck search must fail, not silently under-generate

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError() {
  const err = new Error("Build generation aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

// Stockfish candidate adapter. Reuses ONE provider/worker (open the first position, update
// the rest) and runs each search to the provider's fixed depth. `maxMultipv` is the cap the
// provider was created with: requesting MORE would silently under-serve and break the
// server's manual-preserve parity (it asks for branchLimit + manualCount so it can skip
// preserved manual moves and still find a new branch), so an over-cap request THROWS rather
// than clamps. A search that exceeds `timeoutMs` also THROWS — a half-finished candidate set
// must not be persisted into the repertoire.
export function createEngineCandidateAdapter(
  provider,
  { signal = null, maxMultipv = DEFAULT_MAX_MULTIPV, pollMs = POLL_MS, timeoutMs = PER_POSITION_TIMEOUT_MS } = {},
) {
  let opened = false;
  return {
    async candidates(fen, count) {
      throwIfAborted(signal);
      if (isTerminalPosition(fen)) return []; // no legal continuation → no candidates (== server)

      const want = Math.max(1, Math.floor(Number(count)) || 1);
      if (want > maxMultipv) {
        throw new Error(
          `Browser Stockfish supports at most ${maxMultipv} candidate lines at this position ` +
            `but ${want} were requested (too many preserved manual moves / branch count for the ` +
            `engine cap). Reduce preserved manual moves or the branch count.`,
        );
      }

      if (!opened) {
        await provider.open({ fen, multipv: want });
        opened = true;
      } else {
        await provider.update({ fen, multipv: want });
      }

      // Wait for this position to finish: done when no longer running with at least one depth,
      // or it reached the target depth. The depth guard ignores the spurious `bestmove` the
      // engine emits for the `stop` that precedes each search (mirrors game-analyzer).
      const started = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        throwIfAborted(signal);
        const snap = provider.snapshot();
        if (snap.error) throw new Error(snap.error);
        const done = !snap.running && snap.current_depth > 0;
        const reached = snap.current_depth >= (snap.max_depth || 0) && snap.pvs.length > 0;
        if (done || reached) break;
        if (Date.now() - started > timeoutMs) {
          // Fail fast — Build Generate persists these candidates, so a partial set is wrong.
          throw new Error(`Browser Stockfish timed out after ${timeoutMs}ms at ${fen}`);
        }
        await sleep(pollMs);
      }
      throwIfAborted(signal);

      const snap = provider.snapshot();
      const out = [];
      for (const pv of (snap.pvs || []).slice(0, want)) {
        if (!pv || !pv.pv_uci || pv.pv_uci.length === 0) continue; // empty placeholder slot
        if (pv.score_cp === null && pv.mate_in === null) continue; // no eval yet
        out.push({
          moveUci: pv.pv_uci[0],
          // White-POV eval (the provider already flips for Black) — matches the server's
          // EngineEvaluation and the _engine_eval_to_json build-load payload shape.
          evaluation: {
            engine: snap.engine || "stockfish (browser)",
            depth: pv.depth || snap.current_depth || null,
            score_cp: pv.score_cp,
            mate_in: pv.mate_in,
            best_move_uci: pv.pv_uci[0],
            pv: pv.pv_uci.slice(),
          },
          rank: pv.rank,
        });
      }
      return out;
    },
  };
}

// Maia prediction adapter. Reuses one provider session; predictions() returns the provider's
// [{ move_uci, probability, rank }] (already legal-masked + sorted); [] for a terminal
// position is passed through (the planner's opponent turn returns with no children).
export function createMaiaPredictionAdapter(provider, { signal = null } = {}) {
  return {
    async predictions(fen, rating) {
      throwIfAborted(signal);
      const preds = await provider.predictions({ fen, rating });
      throwIfAborted(signal);
      return preds || [];
    },
  };
}

// chess.js-backed adapter for side-to-move + applyUci. applyUci returns null for an illegal
// move (the planner then throws — fail fast, matching the server's apply_uci raising).
export function createChessAdapter() {
  return {
    sideToMove(fen) {
      return new Chess(fen).turn() === "w" ? "white" : "black";
    },
    applyUci(fen, uci) {
      try {
        const game = new Chess(fen);
        const move = game.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        if (!move) return null;
        return { uci, fenAfter: game.fen() };
      } catch (_) {
        return null; // unparseable FEN / illegal move
      }
    },
  };
}

// Largest number of MANUAL prepared children at any single node in the existing subtree.
// New (generated) nodes are never manual-prepared, so this bounds the manual count the
// recursion can ever encounter — used to size the engine's MultiPV cap precisely so no
// node under-generates (server parity) and an over-cap request is a genuine error.
function maxManualPreparedChildren(node) {
  if (!node || !Array.isArray(node.children)) return 0;
  let here = 0;
  let deeper = 0;
  for (const child of node.children) {
    if (child.is_user_prepared_move && child.source === SOURCE.MANUAL) here += 1;
    deeper = Math.max(deeper, maxManualPreparedChildren(child));
  }
  return Math.max(here, deeper);
}

// Resolve the browser engines and run the recursion from `rootNodeId` of a loaded build
// payload (appState.build), returning a tree-mutation plan. NO server fallback: if the
// browser engine is unavailable this throws an actionable error. Factories +
// availability check are injectable so the wiring unit-tests without a browser.
export async function runBrowserBuildGenerate({
  build,
  rootNodeId,
  ownColor = null,
  plyDepth,
  detailMode = "balanced",
  maiaRating,
  ownSideCandidateCount = 1,
  preserveManualPreparedMoves = true,
  depth = DEFAULT_GEN_DEPTH,
  signal = null,
  onProgress = () => {},
  onEvent = () => {},
  onMaiaInitProgress = null,
  maiaProvider: borrowedMaia = null,
  createEngine = (opts) => createEngineProvider(opts),
  createMaia = (opts) => createMaia3Provider(opts),
  isEngineAvailable = isBrowserEngineAvailable,
} = {}) {
  if (!build || !Array.isArray(build.nodes)) throw new Error("runBrowserBuildGenerate requires a loaded build payload");
  if (!rootNodeId) throw new Error("runBrowserBuildGenerate requires rootNodeId");
  if (!isEngineAvailable()) {
    throw new Error(
      "Browser engine unavailable: this page is not cross-origin isolated (COOP/COEP " +
        "required). Build Generate runs locally; there is no server fallback.",
    );
  }

  const repertoireColor = build.color === "black" ? "black" : "white";
  const existingSubtree = buildExistingSubtreeFromFlatNodes(build.nodes, rootNodeId);

  // Size the engine's MultiPV cap to the worst-case request the recursion can make
  // (branchLimit + the largest manual-prepared child count), so a node never under-generates
  // by hitting an artificial cap — preserving server _expand parity.
  const branchLimit = Math.max(1, Math.floor(Number(ownSideCandidateCount) || 1));
  const maxManual = preserveManualPreparedMoves ? maxManualPreparedChildren(existingSubtree) : 0;
  const engineMaxMultipv = Math.min(MULTIPV_CEILING, Math.max(1, branchLimit + maxManual));

  const engineProvider = createEngine({ maxDepth: depth, maxMultipv: engineMaxMultipv });
  if (engineProvider && engineProvider.kind === "unavailable") {
    const msg =
      (engineProvider.snapshot && engineProvider.snapshot().error) || "Browser engine unavailable";
    throw new Error(msg);
  }

  // Maia provider: reuse a borrowed (shared) provider when given so repeated runs don't
  // re-download/re-create the ~46 MB model (Stage 4b); otherwise create+own a fresh one.
  // Acquired inside the try so an engine teardown still runs if anything below throws.
  let maiaProvider = null;
  const ownsMaia = !borrowedMaia;
  try {
    maiaProvider = borrowedMaia || createMaia({});
    // Route the worker's cold-init download/verify/session progress to the caller for the
    // duration of this run (cleared in finally so a shared provider doesn't hold a stale cb).
    if (onMaiaInitProgress && typeof maiaProvider.setInitProgressHandler === "function") {
      maiaProvider.setInitProgressHandler(onMaiaInitProgress);
    }
    return await generateBuildPlan({
      existingSubtree,
      rootNodeId,
      repertoireColor,
      ownColor,
      plyDepth,
      detailMode,
      maiaRating,
      ownSideCandidateCount,
      preserveManualPreparedMoves,
      engine: createEngineCandidateAdapter(engineProvider, { signal, maxMultipv: engineMaxMultipv }),
      maia: createMaiaPredictionAdapter(maiaProvider, { signal }),
      chess: createChessAdapter(),
      onProgress,
      onEvent,
      signal,
    });
  } finally {
    try {
      if (engineProvider && engineProvider.close) await engineProvider.close();
    } catch (_) {
      /* ignore teardown errors */
    }
    // Detach our progress handler so a borrowed/shared provider doesn't keep calling a
    // stale callback after this run ends.
    try {
      if (maiaProvider && typeof maiaProvider.setInitProgressHandler === "function") {
        maiaProvider.setInitProgressHandler(null);
      }
    } catch (_) {
      /* ignore */
    }
    // Only tear down a provider we created; a borrowed (shared) one stays warm for reuse.
    if (ownsMaia) {
      try {
        if (maiaProvider && maiaProvider.terminate) maiaProvider.terminate();
      } catch (_) {
        /* ignore teardown errors */
      }
    }
  }
}
