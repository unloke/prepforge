import { html } from "../html.js";
import { appState } from "../core/state.js";
import { api, currentOwnerId, localDayOf, postJson, setStatus, setStatusError } from "../core/api.js";
import { markLichessSeen, orientAnalysisForSelf } from "../account-entry.js";

// The Analyze entry points that are not the analysis run itself: "My last
// game", the saved-list "Recent analyses", recalling one, and deleting one with
// its undo window. The run and everything it renders stay in analyze-session.js;
// this module is what the shell's Analyze buttons and drawer call.

// The analysis session is lazy (it pulls chess.js, the coach and the engine), so
// its entry points arrive as deps rather than imports; the shell passes the
// wrappers it already keeps.
let requireSignIn, startLichessOAuth, syncFetchMyGameButton, syncViewHeads, lichessAccounts,
  showUndoToast, ensureAnalyzeView, orientAnalysisFromPgn, loadPgnIntoAnalyze, runAnalysis,
  resetAnalysisVariations, showAnalysisPly, revealAnalysisResults, hideAnalysisHandoff;

export function createAnalyzeEntry(deps) {
  ({ requireSignIn, startLichessOAuth, syncFetchMyGameButton, syncViewHeads, lichessAccounts,
    showUndoToast, ensureAnalyzeView, orientAnalysisFromPgn, loadPgnIntoAnalyze, runAnalysis,
    resetAnalysisVariations, showAnalysisPly, revealAnalysisResults, hideAnalysisHandoff } = deps);
  return {
    fetchMyLichessGame, loadAnalysisHistory, refreshAnalysisHistoryIfOpen,
    invalidateAnalysisSource, recallAnalysis, deleteSavedAnalysis, syncPgnFromTree,
    bindAnalyzePgnInput, invalidateHistory: () => { analysisHistorySeq++; },
  };
}

// Analyze source order. A recall, paste or new review must not let an older
// request (including a lazy view load) replace the latest game.
export let analysisRecallSeq = 0;

export async function fetchMyLichessGame(accountId = null) {
  // Your games come from the Lichess account linked to your PrepForge account.
  if (!requireSignIn("Sign in to load your latest Lichess game", "my-last-game")) return;
  if (!appState.lichessUsername && !lichessAccounts().length) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  setStatus("Fetching your latest game...");
  const button = document.getElementById("fetch-my-game");
  // A second click while the fetch is in flight would race two analyses over
  // the same PGN box; the button says it is working instead.
  if (button) {
    button.dataset.wasDisabled = "1";
    button.disabled = true;
  }
  let latest;
  const done = () => {
    if (button?.dataset.wasDisabled) {
      delete button.dataset.wasDisabled;
      syncFetchMyGameButton();
    }
  };
  try {
    latest = await api(`/api/lichess/latest${query}`);
  } catch (error) {
    done();
    setStatusError(error.message);
    return;
  }
  if (!latest.has_game) {
    done();
  setStatus("No recent games found", { severity: "warning" });
    return;
  }
  document.getElementById("pgn-input").value = latest.pgn || "";
  // Show the game in the move list right away, then analyze it in the same step —
  // "My last game" means "review my last game", not "paste it and wait for me".
  await loadPgnIntoAnalyze(latest.pgn || "", { goToEnd: false, quiet: true }).catch(() => {});
  orientAnalysisForSelf(latest.white, latest.black, [latest.source_account]);
  if (latest.lichess_id) markLichessSeen(latest.lichess_id);
  const source = latest.source_account ? ` · from ${latest.source_account}` : "";
  setStatus(`Loaded ${latest.white || "?"} vs ${latest.black || "?"}${source} · analyzing`);
  try {
    await runAnalysis();
  } finally {
    done();
  }
}


// Analyze "History": list previously analyzed games; click to recall a saved
// report without re-running the engine.
// A save adds a row to "Recent analyses": refresh the open drawer so it never
// keeps saying "No saved analyses yet" beside the review just saved.
export function refreshAnalysisHistoryIfOpen() {
  const drawer = document.getElementById("history-drawer");
  if (appState.signedIn && drawer && drawer.open) void loadAnalysisHistory();
}

let analysisHistorySeq = 0;
export async function loadAnalysisHistory() {
  const seq = ++analysisHistorySeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === analysisHistorySeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const host = document.getElementById("analysis-history");
  if (!host) return;
  host.innerHTML = html`<div class="muted hint">Loading…</div>`;
  const rows = new Map();
  let cursor = null, loading = false;
  async function loadPage() {
    if (loading || !isCurrent()) return;
    loading = true;
    const button = host.querySelector("[data-history-more]");
    if (button) button.disabled = true;
    try {
      const payload = await api(`/api/analyses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!isCurrent()) return;
      for (const row of payload.analyses || []) rows.set(row.game_id, row);
      cursor = payload.next_cursor || null;
      const scroll = host.scrollTop;
      host.innerHTML = html`${[...rows.values()].map((a) =>
        html`<div class="history-item" data-game-id="${a.game_id}"><button class="hi-open" type="button"><span class="hi-players">${a.white || "?"} vs ${a.black || "?"}</span><span class="hi-meta">${a.result || ""} · ${localDayOf(a.analyzed_at)}</span></button><button class="btn icon sm hi-delete" type="button" data-history-delete="${a.game_id}" data-history-label="${a.white || "?"} vs ${a.black || "?"}" title="Delete this analysis" aria-label="Delete analysis of ${a.white || "?"} vs ${a.black || "?"}"><svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`
      )}` || html`<div class="muted hint">No saved analyses yet.</div>`;
      if (cursor) host.innerHTML += html`<button class="btn sm" data-history-more>Load more</button>`;
      host.scrollTop = scroll;
      host.querySelectorAll(".hi-open").forEach((open) => {
        open.addEventListener("click", () => {
          if (isCurrent()) recallAnalysis(open.closest(".history-item").dataset.gameId, rows.get(open.closest(".history-item").dataset.gameId));
        });
      });
      host.querySelectorAll("[data-history-delete]").forEach((del) => {
        del.addEventListener("click", () => deleteSavedAnalysis(del));
      });
      host.querySelector("[data-history-more]")?.addEventListener("click", loadPage);
    } catch (error) {
      if (!isCurrent()) return;
      if (rows.size) {
        if (button) button.textContent = "Retry load more";
        setStatusError(error.message);
      } else host.innerHTML = html`<div class="empty-state">${error.message}</div>`;
    } finally {
      loading = false;
      if (button && isCurrent()) button.disabled = false;
    }
  }
  await loadPage();
}

// Delete one saved analysis, with an undo window: the row disappears at once and
// the DELETE only fires once the window closes, so a misclick costs one notice
// rather than a lost analysis.
export function deleteSavedAnalysis(delButton) {
  const gameId = delButton.dataset.historyDelete;
  const label = delButton.dataset.historyLabel || "this game";
  if (!gameId || appState.pendingAnalysisDeletes.has(gameId)) return;
  appState.pendingAnalysisDeletes.add(gameId);
  const restore = () => {
    appState.pendingAnalysisDeletes.delete(gameId);
    void loadAnalysisHistory();
  };
  showUndoToast({
    title: "Analysis deleted",
    message: `"${label}" removed from your history.`,
    onUndo: () => {
      setStatus("Delete undone");
      restore();
    },
    onCommit: () => {
      api(`/api/analyses/${encodeURIComponent(gameId)}`, { method: "DELETE" })
        .then(() => appState.pendingAnalysisDeletes.delete(gameId))
        .catch((error) => {
          setStatus(`Delete failed — ${error.message}`, { severity: "error" });
          restore();
        });
    },
  });
  // Optimistic paint: the row goes now, the server hears about it when the
  // undo window closes.
  delButton.closest(".history-item")?.remove();
  const host = document.getElementById("analysis-history");
  if (host && !host.querySelector(".history-item")) {
    host.innerHTML = html`<div class="muted hint">No saved analyses yet.</div>`;
  }
}

export function invalidateAnalysisSource() {
  appState.analysisFileSeq = null;
  clearTimeout(analyzePgnInputTimer);
  return ++analysisRecallSeq;
}

export async function recallAnalysis(gameId, listItem = null) {
  const seq = invalidateAnalysisSource();
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  try {
    const payload = await api(`/api/analyses/${encodeURIComponent(gameId)}`);
    const view = await ensureAnalyzeView();
    if (seq !== analysisRecallSeq) return;
    // The saved result carries no player names; the history row does. Without
    // them the head fell back to "Analysis board" for a named game.
    for (const key of ["white", "black", "result"]) {
      if (!payload[key] && listItem?.[key]) payload[key] = listItem[key];
    }
    appState.analysis = payload;
    // Mirror the recalled game into the PGN box for further exploration.
    // Clear it before rendering: the head reads its tags first, and a leftover
    // (e.g. the demo PGN) would title the recalled game "PrepForge vs Demo".
    const pgnInput = document.getElementById("pgn-input");
    if (pgnInput) pgnInput.value = "";
    orientAnalysisForSelf(payload.white, payload.black);
    resetAnalysisVariations();
    await showAnalysisPly(0);
    if (seq !== analysisRecallSeq) return;
    view.renderAnalysis(payload);
    syncViewHeads();
    revealAnalysisResults();
    // The list sits at the panel's foot; open the new game at its summary.
    document.querySelector("#analyze-sidebar .panel-scroll")?.scrollTo({ top: 0 });
    await syncPgnFromTree();
    if (seq !== analysisRecallSeq) return;
  } catch (error) {
    if (seq !== analysisRecallSeq) return;
    setStatusError(error.message);
  }
}

// ----- Analyze PGN ↔ move-list two-way sync ------------------------------------
// The PGN drawer and the move list are two views of one game. Typing legal moves
// into the PGN box rebuilds the move list (and drives the board); playing moves on
// the board (or stepping into variations) rewrites the PGN box. The two directions
// are event-driven and guarded against feedback loops:
//   • board / move-list → PGN  : syncPgnFromTree() — skipped while the textarea is
//     focused, so a user mid-edit is never clobbered.
//   • PGN box → board / list   : loadPgnIntoAnalyze() — fired (debounced) on the
//     textarea `input` event and called directly by every importer.
// A plain typed/pasted game carries no engine classifications, so its move list
// shows neutral dots and an empty eval chart until the user presses Analyze.
let analyzePgnInputTimer = null;
// True only while we programmatically rewrite #pgn-input from the tree, so the
// defensive guard below can tell our own writes from user edits. (Assigning
// `.value` does not fire `input`, so this is belt-and-suspenders.)
let analyzePgnWriting = false;

// Board / move-list → PGN box. Serialize the current Analyze tree (analyzed or
// typed mainline + explored variations) and write it back, preserving the header
// block. No-op while the textarea is focused (board moves happen with the board
// focused, so this only fires when it's safe).
export async function syncPgnFromTree() {
  const input = document.getElementById("pgn-input");
  if (!input || document.activeElement === input) return;
  const analysis = appState.analysis;
  const seq = analysisRecallSeq;
  const original = input.value;
  const moves = analysis ? analysis.moves : [];
  const hasVars = appState.analysisVarNodes && appState.analysisVarNodes.size;
  if ((!moves || !moves.length) && !hasVars) return;
  const view = await ensureAnalyzeView();
  if (seq !== analysisRecallSeq || input.value !== original || document.activeElement === input) return;
  const next = view.serializeAnalysisPgn(input.value);
  if (!next) return;
  if (next !== input.value && document.activeElement !== input) {
    analyzePgnWriting = true;
    input.value = next;
    analyzePgnWriting = false;
  }
}

// Live PGN → move-list sync: every edit (debounced) re-parses the box and
// rebuilds the move list + board. Invalid/half-typed movetext is ignored
// (quiet) so the list never flickers mid-keystroke.
export function bindAnalyzePgnInput() {
  const pgnInput = document.getElementById("pgn-input");
  if (!pgnInput) return;
  pgnInput.addEventListener("input", () => {
    if (analyzePgnWriting) return;
    invalidateAnalysisSource();
    syncViewHeads();
    analyzePgnInputTimer = setTimeout(() => {
      orientAnalysisFromPgn(pgnInput.value);
      void loadPgnIntoAnalyze(pgnInput.value, { goToEnd: true, quiet: true }).catch(
        () => {}
      );
    }, 300);
  });
}
