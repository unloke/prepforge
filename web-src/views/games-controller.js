import { html } from "../html.js";
import { MAX_FETCH } from "../generated/shared-constants.js";
import { countOf } from "../plural.js";
import { appState } from "../core/state.js";
import { api, currentOwnerId, postJson, setStatus, setStatusError } from "../core/api.js";
import { analysisRecallSeq, invalidateAnalysisSource, recallAnalysis } from "../controllers/analyze-entry.js";
import { localBoardInfo } from "../chess-local.js";
import { parseFenBoard, pieceSvg } from "../board/ui.js";
import { saveReturnState, rememberHandoff, takeHandoff } from "../handoff-context.js";
import { normalizeSelection, openSourceComposer, resolveFetchUsernames, selectionChips } from "./shared/source-composer.js";
import { readSourceStore, writeSourceStore } from "./shared/source-store.js";

// Games: the Lichess comparison, its source picker, the ledger and the handoffs
// the ledger's row actions start. Lazy-loaded with the Games page; the functions
// stay at module level and createGamesController binds the shell's state and
// helpers they share, once.

let requireSignIn, switchView, editRepertoire, isBuildReadOnly, onBuildBoardMove, trainRepertoire,
  orientAnalysisForSelf, loadPgnIntoAnalyze, showAnalysisPly, openSettingsSection, lichessAccounts;

export function createGamesController(deps) {
  ({ requireSignIn, switchView, editRepertoire, isBuildReadOnly, onBuildBoardMove, trainRepertoire,
    orientAnalysisForSelf, loadPgnIntoAnalyze, showAnalysisPly, openSettingsSection, lichessAccounts } = deps);

async function runLichessCompare() {
  // Games are checked against your repertoires (owner-scoped /api/lichess/compare).
  if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
  const selection = gamesSourceSelection();
  const token = appState.replayCheckToken = (appState.replayCheckToken || 0) + 1;
  const owner = appState.accountUserId;
  const sourceKey = JSON.stringify(selection);
  const isCurrent = () => appState.replayCheckToken === token && appState.signedIn
    && appState.accountUserId === owner && JSON.stringify(gamesSourceSelection()) === sourceKey;
  const usernames = resolveFetchUsernames({
    selection,
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
  if (!usernames.length) {
    setStatus("No Games sources selected — open Add and pick one.");
    return;
  }
  const linkedIds = gamesSourceAccountIds();
  const hasExternal = normalizeSelection(selection).external.length > 0;
  const countInput = document.getElementById("replay-count");
  const count = Math.max(1, Math.min(MAX_FETCH, Number(countInput.value) || 10));
  const button = document.getElementById("lichess-compare-btn");
  button.disabled = true;
  setStatus("Fetching games from Lichess");
  // Paint the ledger's own rows as bars while the fetch runs, so the panel
  // shows what it will fill instead of the flat pre-check text.
  const skeletonHost = document.getElementById("replay-results");
  void renderLedgerSkeleton(skeletonHost);
  try {
    const payload = await postJson("/api/lichess/compare", {
      count,
      // linkedIds is null only for the full-Self default (omit → all linked
      // accounts). Any explicit pick — including [] for external-only — is
      // sent as-is so the server never widens the selection back to Self.
      ...(linkedIds !== null ? { account_ids: linkedIds } : {}),
      ...(hasExternal ? { usernames } : {}),
    });
    if (!isCurrent()) return;
    payload.requested_sources = usernames.length;
    appState.replayResults = payload;
    // The filter is a view preference, not a position in the old list: a new
    // check keeps it (and the return state restored after a reload). The
    // selected game is gone with the old list, so its index is dropped.
    appState.replayOpen = new Set();
    await renderReplayResults(payload, isCurrent);
    if (!isCurrent()) return;
    const queued = Number(payload.misses_recorded) || 0;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const sourceLabel =
      sources.length > 1
        ? `self (${sources.length} accounts)`
        : payload.username === "self"
          ? "self"
          : payload.username;
    setStatus(
      queued > 0
        ? `Fetched ${countOf(payload.count, "game")} · ${queued} forgotten move${queued === 1 ? "" : "s"} added to training`
        : `Fetched ${countOf(payload.count, "game")} for ${sourceLabel}`
    );
  } catch (error) {
    if (isCurrent()) {
      // The fetch painted skeleton rows; a failure must not leave the ledger
      // pulsing forever. The panel carries the one error message and the way
      // to retry; a notification on top of it would say the same thing twice.
      resetGamesResults({ keepPanel: true });
      setStatus("");
      await renderReplayFailure(error.message);
    }
  } finally {
    if (appState.replayCheckToken === token) button.disabled = false;
  }
}

// Games source selection — shared explicit model with Scout:
// { linkedMode: "all" | "subset" | "none", accountIds, external }.
// "all" = Self (every linked identity, the default); "subset" = exactly the
// listed linked ids; "none" = no linked accounts. External Lichess usernames
// ride alongside on both pages (Games fetches them too). Persisted per
// browser as one explicit selection object.
const GAMES_SOURCE_KEY = "prepforge.games_source";


function gamesSourceSelection() {
  return readSourceStore(GAMES_SOURCE_KEY);
}

function writeGamesSelection(selection) {
  writeSourceStore(GAMES_SOURCE_KEY, selection);
}

// The ledger belongs to the sources the last Check fetched from. Changing the
// sources replaces it with the pre-check prompt, otherwise the header keeps
// naming accounts the user just removed ("2 shown · old_account").
function clearGamesResults() {
  appState.replayCheckToken = (appState.replayCheckToken || 0) + 1;
  resetGamesResults();
}

// The visual/state half of clearing, without the check-token bump: a FAILED
// Check must drop its skeleton too, but its own response is still the current
// one, so the finally still has to re-enable the button.
function resetGamesResults({ keepPanel = false } = {}) {
  appState.replayResults = null;
  appState.replayFilter = null;
  appState.replayOpen = new Set();
  saveReturnState("replay", { filter: null, openIndex: null });
  const summary = document.getElementById("replay-summary");
  if (summary) {
    summary.hidden = true;
    summary.innerHTML = "";
  }
  const results = document.getElementById("replay-results");
  if (results && !keepPanel) {
    // Same shape index.html ships: the ledger's columns with the idle message
    // in the table body, so the page never collapses to a floating sentence.
    results.innerHTML =
      html`<div class="triage"><section class="ledger card" aria-label="Games to review"><header class="card-head"><h2>Games to review</h2></header><div class="ledger-table" data-ui><div class="lr head col-head" aria-hidden="true"><span>Preparation</span><span>Game</span><span>Result</span><span>First moves</span><span>Departure</span></div><div class="ledger-empty empty-state big"><h3>No games checked yet</h3><p id="games-idle-hint"></p></div></div></section></div>`;
  }
  paintGamesSource();
  const hint = document.getElementById("games-idle-hint");
  if (hint) hint.textContent = gamesIdleHint();
}


function gamesSourceAccountIds() {
  const sel = gamesSourceSelection();
  if (sel.linkedMode === "none") return [];
  if (sel.linkedMode === "all") return null;
  const valid = sel.accountIds.filter((id) =>
    lichessAccounts().some((a) => a.id === id)
  );
  return valid.length ? valid : [];
}

function openGamesComposer(anchor) {
  const composer = openSourceComposer({
    anchor,
    selection: gamesSourceSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Games sources",
    externalPlaceholder: "Add Lichess username…",
    onChange: (sel) => {
      writeGamesSelection(sel);
      clearGamesResults();
    },
    onClose: () => paintGamesSource(),
  });
  return composer;
}

function paintGamesSource() {
  const tray = document.getElementById("games-source-chips");
  if (!tray) return;
  // Signed out there is no "Self" (no linked accounts) and Check needs an
  // account anyway: a selected-looking "Self · all linked" chip contradicted
  // the "No Games sources selected" error. Offer the sign-in instead. While the
  // session is unread neither is true yet, so the tray stays empty.
  if (!appState.authKnown) {
    tray.hidden = true;
    tray.innerHTML = "";
    return;
  }
  if (!appState.signedIn) {
    tray.hidden = false;
    tray.innerHTML =
      html`<button type="button" class="src-chip src-chip-signin" data-games-signin>Sign in to use your games</button>`;
    return;
  }
  const selection = gamesSourceSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const n = lichessAccounts().length;
  const label = n > 0 ? `Self · ${n} linked account${n === 1 ? "" : "s"}` : "Self · all linked";
  const visible = chips.length ? chips : [{ kind: "self", label }];
  tray.hidden = false;
  // Signed in with nothing linked and no usernames added: "Self · all linked"
  // named an empty set and Check stayed disabled without saying why.
  if (n === 0 && !selection.external.length && selection.linkedMode === "all") {
    tray.innerHTML =
      html`<button type="button" class="src-chip src-chip-signin" data-games-link>Link Lichess to use your games</button>`;
    return;
  }
  tray.innerHTML = html`${visible
    .map((c) =>
      c.kind === "self"
        ? html`<span class="src-chip is-self" data-games-chip-self>${label}</span>`
        : c.kind === "external"
          ? html`<span class="src-chip" data-games-chip="${c.id}">${c.label}<button type="button" class="src-chip-x" data-games-unpick-external="${c.id}" aria-label="Remove ${c.label} from Games sources">×</button></span>`
          : html`<span class="src-chip" data-games-chip="${c.id}">${c.label}${c.primary ? html` <span class="conn-primary">Primary</span>` : ""}<button type="button" class="src-chip-x" data-games-unpick="${c.id}" aria-label="Remove ${c.label} from Games sources">×</button></span>`
    )}`;
  if ((selfState === "none" || (!chips.length && selection.linkedMode !== "all")) && !selection.external.length) {
    tray.innerHTML =
      html`<span class="src-empty">No sources — open Add and pick one</span>`;
    return;
  }
  const hint = document.getElementById("games-idle-hint");
  if (hint) hint.textContent = gamesIdleHint();
}

// The idle card names the next step for where the user actually is. While the
// session is unread it says nothing: a guest/signed-in distinction is a guess.
// It only shows before a check — a rendered result replaces the whole host.
function gamesIdleHint() {
  const selection = gamesSourceSelection();
  if (!appState.authKnown) return "";
  if (!appState.signedIn) return "Sign in to check your games against your repertoires.";
  return lichessAccounts().length || selection.external.length
    ? "Pick a sample size, then run a check."
    : "Connect a Lichess account, then run a check.";
}

function bindGamesSource() {
  document.getElementById("games-source-add")?.addEventListener("click", (event) => {
    // Sources only matter for a Check, which needs an account — don't let a
    // guest collect usernames that would silently ride into their account.
    if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
    openGamesComposer(event?.currentTarget || document.getElementById("games-source-add"));
  });
  document.getElementById("games-source-chips")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-games-signin]")) {
      requireSignIn("Sign in to check your games against your repertoire", "games-check");
      return;
    }
    if (event.target.closest("[data-games-link]")) {
      openSettingsSection("set-connections").catch(() => {});
      return;
    }
    const removeExt = event.target.closest("[data-games-unpick-external]");
    if (removeExt) {
      const sel = gamesSourceSelection();
      writeGamesSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== removeExt.dataset.gamesUnpickExternal),
      });
      clearGamesResults();
      return;
    }
    const remove = event.target.closest("[data-games-unpick]");
    if (!remove) return;
    const sel = gamesSourceSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== remove.dataset.gamesUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeGamesSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeGamesSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    clearGamesResults();
  });
  paintGamesSource();
}


let replayModule = null;
let replayView = null;

function preloadReplayView() {
  if (!replayModule) {
    replayModule = import("./replay.js").catch((err) => {
      replayModule = null;
      throw err;
    });
  }
  return replayModule;
}

async function ensureReplayView() {
  const mod = await preloadReplayView();
  if (!replayView) {
    replayView = mod.createReplayView({
      onError: setStatusError,
      // Focus-board renderers: the production FEN decoder + active piece-SVG
      // set, shared with the Library preview (piece style follows Settings).
      boardRenderers: { parseFenBoard, pieceSvg },
      getReplayFilter: () => appState.replayFilter,
      isGameOpen: (index) => appState.replayOpen.has(index),
      onToggleFilter: (kind) => {
        appState.replayFilter = appState.replayFilter === kind ? null : kind;
        // The selection survives the filter: the ledger falls back to the
        // first visible row while the open game is filtered out, so clearing
        // the filter again brings the user's own game back.
        saveReturnState("replay", {
          filter: appState.replayFilter,
          openIndex: [...appState.replayOpen][0] ?? null,
        });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onToggleGame: (index) => {
        appState.replayOpen = new Set([index]);
        saveReturnState("replay", { filter: appState.replayFilter, openIndex: index });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onTrainMiss: async (game, focus) => {
        const task = rememberHandoff(gameHandoff(game, focus, "practice-missed-move"));
        if (task.persisted === false) setStatus("Task kept in this tab only; browser storage is unavailable", { severity: "warning" });
        if (!game.expected_node_id || !game.repertoire_id) throw new Error("Prepared move unavailable; reopen the repertoire");
        await trainRepertoire(game.repertoire_id, { targetNodeIds: [game.expected_node_id], fresh: true });
      },
      onBuildReply: async (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "build-reply"));
        const owner = currentOwnerId(), generation = appState.ownerGeneration;
        const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
        const mod = await import("../controllers/replay-actions.js");
        if (!isCurrent()) return;
        await mod.buildReply(game, { editRepertoire,
          getNode: () => appState.buildNodeById.get(appState.buildCurrentNodeId),
          isBuildReadOnly, localBoardInfo, onBuildBoardMove, isCurrent });
      },
      onAnalyze: (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "review-in-analyze"));
        return replayToAnalyze(game);
      },
      onRetry: () => void runLichessCompare(),
    });
  }
  return replayView;
}

async function renderReplayResults(payload, isCurrent = () => true) {
  const view = await ensureReplayView();
  if (isCurrent()) return view.renderReplayResults(payload);
}

async function renderLedgerSkeleton(host) {
  if (!host) return;
  const view = await ensureReplayView();
  host.innerHTML = view.renderLedgerSkeleton();
}

async function renderReplayFailure(message) {
  const view = await ensureReplayView();
  view.renderReplayError(message);
}

// F-06: the Games→Train/Analyze handoff record — source game, the decision
// ply + anchor FEN (the position where the user left prep), the user's side and
// the matched repertoire. Identity covers the whole tuple, so white/black,
// transpositions and different root FENs never interleave.
function gameHandoff(game, focus, reason) {
  return {
    source: "games",
    sourceView: "replay",
    reason,
    gameId: game.lichess_id || null,
    lineUcis: [game.expected_move_uci].filter(Boolean),
    ply: Number(game.departure_ply) || null,
    anchorFen: (focus && focus.fen) || null,
    side: game.user_color === "black" ? "black" : "white",
    repertoireId: game.repertoire_id ?? null,
    targetNodeIds: [game.expected_node_id].filter(Boolean),
  };
}

// Reuse this game's saved review, or load its PGN ready for a first analysis.
async function replayToAnalyze(game) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const sourceSeq = invalidateAnalysisSource();
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration && sourceSeq === analysisRecallSeq;
  const mod = await import("../controllers/replay-actions.js");
  if (!isCurrent()) return;
  return mod.replayToAnalyze(game, { switchView, orientAnalysisForSelf,
    loadPgnIntoAnalyze, showAnalysisPly, takeHandoff, setStatus, isCurrent,
    api, recallAnalysis, sourceSeq });
}

  return {
    runLichessCompare, gamesSourceSelection, writeGamesSelection, clearGamesResults,
    resetGamesResults, paintGamesSource, bindGamesSource, renderReplayResults,
    renderLedgerSkeleton, renderReplayFailure, replayToAnalyze, ensureReplayView,
  };
}
