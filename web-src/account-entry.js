import { html } from "./html.js";
import { appState, boards, notices } from "./core/state.js";
import { api, currentOwnerId, postJson, setStatus } from "./core/api.js";
import { refreshAutoMaiaRating } from "./core/prefs.js";
import { showConfirmModal } from "./core/modals.js";
import { setHandoffOwner } from "./handoff-context.js";
import { createAccountController } from "./controllers/account.js";
import { activateModal } from "./core/modals.js";
import { pgnHeaderTags as analyzeHeaderTags } from "./analyze-pgn.js";
import { pgnPlayers, selfSide } from "./analyze-orient.js";

// Sign-in and the Lichess identity: the account controller, its shell-side
// helpers, the "you just finished a game" watcher, the Analyze entry points
// that need the linked identity (My last game, self-orientation), the saved
// analysis history and the recovery bar for an unsaved run. Loaded at boot by
// the shell; createAccountEntry binds the shell's state and helpers, once.

let switchView, loadSettings, openSettingsSection, flushAllPendingForSignOut,
  paintGamesSource, paintScoutSource, clearCoverage, hideAnalysisRetrySave;
// These arrive as getters: the shell creates them after this module binds (a
// view chunk, the app-ready promise), so each read must be live.
let shell = null;
const live = (name) => shell[name];

// What the account entry borrows from the shell and the Analyze entry: the
// watcher's "Analyze" action, the history list's recall, and the sign-out reset.
// The Analyze entry (history + recall) is a separate module; the sign-out reset
// tells it to drop its in-flight list read.
let analyzeEntry = null;

export function createAccountEntry(deps) {
  shell = deps;
  ({ switchView, loadSettings, openSettingsSection, flushAllPendingForSignOut,
    paintGamesSource, paintScoutSource, clearCoverage, hideAnalysisRetrySave } = deps);
  // The functions below are module level; the factory binds the state and the
  // shell helpers they share, once.
  return {
    initAccountController, bindAnalyzeEntry: (entry) => { analyzeEntry = entry; }, accountService, getStoredLichessUsername, setLichessUsername,
    refreshAuthProviders, requireSignIn, openAuthModal, onAccountChipClick, closeAccountMenu,
    isAccountMenuOpen, refreshAuthStatus, syncReplayControls, syncFetchMyGameButton,
    refreshLichessStatus, startLichessOAuth, startLichessGameWatch, noteLichessActivity,
    lichessAccounts, orientAnalysisForSelf, analysisSelfSide, orientAnalysisFromPgn,
    markLichessSeen, dismissNewGameNudge, finishedRecently,
  };
}


let accountController = null;

export function initAccountController() {
  accountController = createAccountController({
    appState,
    api,
    postJson,
    setStatus,
    showConfirmModal,
    refreshAutoMaiaRating,
    onLichessConnected: startLichessGameWatch,
    // The Library setup checklist ticks "Link Lichess" from the live accounts.
    // The Games/Scout source trays resolve "Self" against the same list: painted
    // before it arrived they read "No sources" while Start still fetched every
    // linked account, so repaint them from the live list too.
    onLichessAccountsChanged: () => {
      live("dashboardView")?.refreshSetup?.();
      live("scoutController")?.syncSources();
      paintGamesSource();
      paintScoutSource();
      syncFetchMyGameButton();
    },
    onOpenSettings: () => {
      switchView("settings");
      loadSettings();
    },
    onOpenAccount: () => {
      void openSettingsSection("set-account");
    },
    beforeSignOut: flushAllPendingForSignOut,
    // No auth-known hook here: restoreWorkspaceLocation switches to the URL's
    // view after the session is read (and switchView reloads Teams), so a Teams
    // load deferred on an unread session is retried there. Doing it here as well
    // ran a second /api/teams on every signed-in boot, on every route.
    onOwnerChanged: () => {
      setHandoffOwner(currentOwnerId());
      // Another account's latest game is not this account's: drop the card and
      // the baseline, and let the status refresh re-arm the watch for the new
      // identity (a stale baseline would swallow that account's first game).
      resetLichessGameWatch();
      analyzeEntry?.invalidateAnalysisSource();
      const latestButton = document.getElementById('fetch-my-game');
      if (latestButton) { delete latestButton.dataset.wasDisabled; latestButton.disabled = false; }
      clearCoverage();
      appState.settingsRequestSeq = (appState.settingsRequestSeq || 0) + 1;
      appState.settingsReadSeq = (appState.settingsReadSeq || 0) + 1;
      appState.settingsSaving = null;
      appState.buildMutationSaving = null;
      analyzeEntry?.invalidateHistory();
      live("teamsController")?.invalidateRequests();
      appState.teamsRequestSeq = (appState.teamsRequestSeq || 0) + 1;
      appState.teams = [];
      appState.teamsCache = null;
      appState.analysisRetryCheckpoint = null;
      appState.analysisUnsavedCheckpoint = null;
      hideAnalysisRetrySave();
      for (const id of ["analysis-history", "teams-list", "teams-shared"]) {
        const host = document.getElementById(id);
        if (host) host.innerHTML = "";
      }
      const historyDrawer = document.getElementById("history-drawer");
      if (historyDrawer) historyDrawer.hidden = true;
      live("hideTeamDetail")();
      live("dashboardView")?.renderSignedOut();
    },
  });
}

export function accountService() {
  if (!accountController) throw new Error("Account controller is not initialized");
  return accountController;
}

export function getStoredLichessUsername() {
  return accountService().getStoredLichessUsername();
}

export function setLichessUsername(username) {
  return accountService().setLichessUsername(username);
}

// Which sign-in methods the server offers (Google when configured; email/password
// always). Fetched once; drives which buttons the auth modal shows.
export async function refreshAuthProviders() {
  return accountService().refreshAuthProviders();
}

// Owner-scoped actions (create/import a repertoire, teams, analysis) call server endpoints
// that require an account and return 401 for guests. Guard them up front so a guest gets the
// sign-in modal instead of filling out a form only to hit a cryptic 401 in the status bar.
// `reason` is shown inside the modal; `pendingActionId` (allowlisted in
// auth-gate.js) resumes the action after sign-in — see resumePendingAction.
export function requireSignIn(reason = "Sign in (or create an account) to continue", pendingActionId = null, pendingData = null) {
  return accountService().requireSignIn(reason, pendingActionId, pendingData);
}

// The sign-in / create-account modal. Google (when configured) is the primary path;
// email/password is the always-available fallback. Options ({ notice,
// pendingAction, resetToken }) pass straight through to the controller.
export function openAuthModal(mode = "login", options = {}) {
  return accountService().openAuthModal(mode, options);
}

// Guest → the chip is a single Connect action (straight to OAuth). Signed in → the
// chip toggles the account menu.
export function onAccountChipClick(anchor = null, options = {}) {
  return accountService().onAccountChipClick(anchor, options);
}

export function closeAccountMenu(options = {}) {
  return accountService().closeAccountMenu(options);
}

export function isAccountMenuOpen() {
  return accountService().isAccountMenuOpen();
}

// Ask the server whether this browser's session is a real account or a guest, and
// capture the account's stable username for the user-name button.
export async function refreshAuthStatus() {
  return accountService().refreshAuthStatus();
}

export function syncReplayControls() {
  try {
    accountService().syncReplayControls();
  } catch (_) {
    /* controller may not be initialised yet */
  }
  paintGamesSource();
  paintScoutSource();
}

// Analyze's "Last game": it can only load anything once a Lichess account is
// linked, so a guest or an unlinked account sees it disabled with the fix in
// the tooltip rather than a button that silently does nothing. aria-disabled
// rather than disabled: the click is what opens the connect flow, so it must
// still fire.
export function syncFetchMyGameButton() {
  const button = document.getElementById("fetch-my-game");
  if (!button) return;
  if (button.dataset.wasDisabled) return;
  const linked = !!(appState.lichessUsername || lichessAccounts().length);
  const disabled = !linked || !appState.signedIn;
  button.classList.toggle("is-unavailable", disabled);
  button.setAttribute("aria-disabled", String(disabled));
  button.title = disabled
    ? "Connect a Lichess account to load your last game"
    : "Load and analyze your latest Lichess game";
}

// Pull the server's stored Lichess connection state. This is not a PrepForge sign-out;
// the browser remains bound to the account.
export async function refreshLichessStatus() {
  return accountService().refreshLichessStatus();
}

// Open Lichess sign-in in a popup; the callback page postMessages back, and we
// also poll status as a fallback if the message is blocked.
export function startLichessOAuth() {
  return accountService().startLichessOAuth();
}

// Background watch for "you just finished a game". Design goals (vs the old
// "latest id != last_seen → pop", which fired for ANY historical game on a fresh
// app load):
//   1. Silent baseline: on watch start we record the current latest game id
//      WITHOUT popping, so opening the app never resurfaces an old game.
//   2. Recency gate: only auto-pop a game whose true FINISH time (Lichess
//      lastMoveAt) is within LICHESS_RECENT_WINDOW_MS, so a stale baseline can
//      never surface an hours-old game. Strict: a game with no usable timestamp
//      is never auto-popped — it gets a non-intrusive status hint instead.
//   3. Adaptive cadence: short polling right after activity (focus, tab visible,
//      navigation) or on Analyze; back off to a low idle frequency otherwise —
//      instead of a fixed 90s timer that runs even on a hidden tab.
//   4. One probe at a time: focus + visibility fire together when the user comes
//      back to the tab, and the poll timer can land in the same instant, so a
//      burst shares one request instead of spending the /latest rate limit. The
//      response is applied only while it still belongs to the owner that asked.
const LICHESS_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h: "recently finished"
const LICHESS_POLL_ACTIVE_MS = 25 * 1000; // short cadence while active / on Analyze
const LICHESS_POLL_IDLE_MS = 3 * 60 * 1000; // idle back-off
const LICHESS_ACTIVE_WINDOW_MS = 3 * 60 * 1000; // how long activity keeps us "active"
// focus + visibilitychange fire together, and a user alt-tabbing in and out
// raises them again and again. One probe per burst is enough for a game that
// finished seconds ago; the poll timer still runs at its own cadence.
const LICHESS_FOCUS_MIN_GAP_MS = 2000;

// The visible "you just finished a game" card, and the games this session has
// already handled (loading one through Last game counts). The baseline covers
// the poll path; this set covers a probe that was already in flight when the
// user acted, whose response would otherwise re-surface the same game.
let newGameNudgeCard = null;
let acknowledgedGameIds = new Set();
let latestProbe = null;
let newGameNudgeHold = null;
let newGameNudgeVersion = 0;
let watchWasAway = false, foregroundRefreshPending = false;
// The seen writes are ordered: dismissing the card for an older game and then
// loading a newer one must leave the NEWER id as the server's last-seen, or a
// reload would offer the game the user already reviewed.
let seenWrite = Promise.resolve();

export function startLichessGameWatch() {
  // A restart for the SAME identity (a settings refresh, a second status read)
  // keeps the baseline: re-baselining would swallow a game finished while the
  // watch was briefly down. Only a different linked identity starts over.
  const identity = watchIdentity();
  const sameIdentity = appState.lichessWatchIdentity === identity;
  stopLichessGameWatch();
  appState.lichessWatchIdentity = identity;
  appState.lichessWatchStartedAt = Date.now();
  appState.lichessLastActivity = Date.now();
  if (!sameIdentity) {
    appState.lichessBaselineId = null;
    latestProbe = null;
    foregroundRefreshPending = false;
    acknowledgedGameIds = new Set();
    dismissNewGameNudge();
  }
  // Re-check promptly when the user returns to the tab/window (and treat it as
  // activity so the cadence tightens). Bound once; refs kept for clean removal.
  watchWasAway = watchWasAway || document.visibilityState === 'hidden';
  appState.lichessOnFocus = () => {
    if (document.visibilityState === 'hidden') return;
    const returned = watchWasAway;
    watchWasAway = false;
    noteLichessActivity();
    if (returned && latestProbe) { foregroundRefreshPending = true; return; }
    if (!returned && Date.now() - (appState.lichessLastProbeAt || 0) < LICHESS_FOCUS_MIN_GAP_MS) return;
    void checkLatestLichessGame();
  };
  appState.lichessOnBlur = () => { watchWasAway = true; };
  appState.lichessOnVisible = () => {
    if (document.visibilityState === "visible") appState.lichessOnFocus();
    else watchWasAway = true;
  };
  window.addEventListener("focus", appState.lichessOnFocus);
  window.addEventListener('blur', appState.lichessOnBlur);
  document.addEventListener("visibilitychange", appState.lichessOnVisible);
  // Establish the silent baseline (the FIRST sighting of this identity is never
  // a pop) before anything else, then keep polling. Taking it now rather than on
  // a timer is what makes a game finished a moment later readable as new: a
  // fixed 5 s delay left a window where a return to the tab was still "cold" and
  // its game was swallowed. A restart for the same identity keeps its baseline.
  void checkLatestLichessGame();
  scheduleLichessPoll();
}

function stopLichessGameWatch() {
  if (appState.lichessPollTimer) {
    window.clearTimeout(appState.lichessPollTimer);
    appState.lichessPollTimer = null;
  }
  if (appState.lichessOnFocus) {
    window.removeEventListener("focus", appState.lichessOnFocus);
    appState.lichessOnFocus = null;
  }
  if (appState.lichessOnBlur) {
    window.removeEventListener('blur', appState.lichessOnBlur);
    appState.lichessOnBlur = null;
  }
  if (appState.lichessOnVisible) {
    document.removeEventListener("visibilitychange", appState.lichessOnVisible);
    appState.lichessOnVisible = null;
  }
}

// Sign-out / account switch: everything the watcher knows belongs to the owner
// that is leaving.
function resetLichessGameWatch() {
  stopLichessGameWatch();
  appState.lichessBaselineId = null;
  appState.lichessWatchIdentity = null;
  acknowledgedGameIds = new Set();
  latestProbe = null;
  newGameNudgeHold = null;
  watchWasAway = foregroundRefreshPending = false;
  seenWrite = Promise.resolve();
  appState.lichessLastProbeAt = 0;
  dismissNewGameNudge();
}

// What the watch is watching: the linked identities, so re-reading the same
// links is not mistaken for a new account.
function watchIdentity() {
  const ids = lichessAccounts().map((account) => account.id).join(",");
  return ids || appState.lichessUsername || "";
}

// Record user activity so the poll cadence stays short for a short window after.
export function noteLichessActivity() {
  appState.lichessLastActivity = Date.now();
}

// Self-rescheduling poll: short cadence while recently active or on Analyze (where
// a just-finished game is most relevant), otherwise a low idle frequency. Skips the
// work entirely while the tab is hidden (the focus/visibility handlers catch up).
function scheduleLichessPoll() {
  if (appState.lichessPollTimer) window.clearTimeout(appState.lichessPollTimer);
  if (!appState.lichessUsername) return;
  const recentlyActive =
    Date.now() - (appState.lichessLastActivity || 0) < LICHESS_ACTIVE_WINDOW_MS;
  const active = recentlyActive || appState.currentView === "analyze";
  const delay = active ? LICHESS_POLL_ACTIVE_MS : LICHESS_POLL_IDLE_MS;
  appState.lichessPollTimer = window.setTimeout(async () => {
    if (document.visibilityState !== "hidden") await checkLatestLichessGame();
    scheduleLichessPoll();
  }, delay);
}

// Tri-state recency: true = finished within the window, false = finished but stale,
// null = no usable timestamp. We keep null distinct so the caller can degrade to a
// non-intrusive hint rather than guessing (strict gate — never auto-pop on unknown).
export function finishedRecently(finishedAt) {
  if (!finishedAt) return null;
  const t = Date.parse(finishedAt);
  if (Number.isNaN(t)) return null;
  return Date.now() - t <= LICHESS_RECENT_WINDOW_MS;
}

// The pre-existing latest game is never treated as "just finished": the FIRST
// sighting of a watch (cold start, or a new linked identity) is adopted as the
// silent baseline and never popped.
// Concurrent callers (focus + visibility + poll) share the one probe in flight.
function checkLatestLichessGame() {
  if (!appState.lichessUsername) return Promise.resolve();
  if (latestProbe) return latestProbe;
  const probe = probeLatestLichessGame().finally(() => {
    if (latestProbe !== probe) return;
    latestProbe = null;
    if (foregroundRefreshPending) { foregroundRefreshPending = false; void checkLatestLichessGame(); }
  });
  latestProbe = probe;
  return probe;
}

async function probeLatestLichessGame() {
  const owner = currentOwnerId(), generation = appState.ownerGeneration, identity = appState.lichessWatchIdentity, version = newGameNudgeVersion;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration && identity === appState.lichessWatchIdentity && version === newGameNudgeVersion;
  appState.lichessLastProbeAt = Date.now();
  let latest;
  try {
    // Lightweight NDJSON metadata probe (no move text) — fast, and enough to decide
    // whether to surface the nudge. The full PGN is fetched only if the user acts on it.
    latest = await api("/api/lichess/latest?light=1");
  } catch (_) {
    // A failed probe leaves no baseline behind. Do not let it hold the focus
    // throttle: the next return to the tab tries again instead of waiting out a
    // probe that never answered (the game is still there when it works).
    if (isCurrent()) appState.lichessLastProbeAt = 0;
    return;
  }
  // The account changed while the probe was out: its game belongs to somebody
  // else, and the new owner's watch has its own baseline.
  if (!isCurrent() || newGameNudgeHold?.isCurrent()) return;
  if (foregroundRefreshPending && appState.lichessBaselineId !== null) return;
  if (!latest || !latest.has_game) return;
  if (appState.lichessBaselineId === null) {
    // First sighting this session: adopt as baseline, never pop.
    appState.lichessBaselineId = latest.lichess_id;
    return;
  }
  const isNewerThanBaseline = latest.lichess_id !== appState.lichessBaselineId;
  // Advance the baseline regardless, so we evaluate each newly-latest game once.
  appState.lichessBaselineId = latest.lichess_id;
  if (!isNewerThanBaseline || !latest.is_new) return;
  // Already handled in this tab (loaded through Last game, or closed earlier):
  // a probe that started before that must not bring the card back.
  if (acknowledgedGameIds.has(String(latest.lichess_id))) return;
  const recent = finishedRecently(latest.finished_at);
  if (recent === true) {
    showNewGameWidget(latest);
  } else if (recent === null) {
    // Passed the baseline + is_new gates but we can't confirm it finished recently.
    // Strict gate: don't pop the widget — just surface a quiet, dismissible hint.
    setStatus(
      `New Lichess game synced: ${latest.white || "?"} vs ${latest.black || "?"}`
    );
  }
  // recent === false: a genuinely older game; stay silent.
}

// Surface a "you just finished a game" nudge as a notice with an Analyze action.
function showNewGameWidget(game) {
  if (newGameNudgeHold?.isCurrent()) return;
  if (!game.lichess_id) return;
  if (appState.newGameWidgetId === game.lichess_id) return;
  if (acknowledgedGameIds.has(String(game.lichess_id))) return;
  dismissNewGameNudge();
  appState.newGameWidgetId = game.lichess_id;
  const sub =
    `${game.white || "?"} vs ${game.black || "?"}` +
    `${game.result ? " · " + game.result : ""}`;
  // Auto-dismiss after ~45s of being ignored; hover keeps it alive. Closing it
  // any way marks the game seen so the watcher doesn't re-surface it.
  const card = notices.show(sub, {
    key: `newgame-${game.lichess_id}`,
    title: "You just finished a game!",
    duration: 45000,
    onClose: () => {
      if (newGameNudgeCard !== card) return;
      newGameNudgeCard = null;
      appState.newGameWidgetId = null;
      void markLichessSeen(game.lichess_id);
    },
    actions: [
      {
        label: "Analyze",
        primary: true,
        closeOnClick: false,
        onClick: async () => {
          switchView("analyze");
          // The same import Analyze's "Last game" runs: one path, so the board is
          // oriented for this game and the game is acknowledged the same way. The
          // probe skipped the move text, so the importer fetches the full game.
          await analyzeEntry?.importLatestGame(game);
        },
      },
    ],
  });
  if (card) newGameNudgeCard = card;
}

// The nudge and Analyze's "Last game" are the same latest-game workflow, so
// loading the latest game dismisses the card at once instead of leaving it to be
// closed by hand a second later. This dismissal is not an acknowledgement: the
// card may be showing a game other than the one just loaded, and only the game
// actually loaded may be marked seen.
export function holdNewGameNudge(isCurrent) {
  const hold = { isCurrent };
  newGameNudgeHold = hold;
  newGameNudgeVersion++;
  dismissNewGameNudge();
  return () => {
    if (newGameNudgeHold !== hold) return;
    if (isCurrent()) newGameNudgeVersion++;
    newGameNudgeHold = null;
  };
}

export function dismissNewGameNudge(lichessId = null) {
  if (lichessId !== null && appState.newGameWidgetId !== lichessId) return;
  const card = newGameNudgeCard;
  newGameNudgeCard = null;
  appState.newGameWidgetId = null;
  if (!card || card.removed) return;
  card.onClose = null;
  card.dismiss();
}

export async function markLichessSeen(lichessId) {
  if (!lichessId) return;
  acknowledgedGameIds.add(String(lichessId));
  dismissNewGameNudge(String(lichessId));
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  seenWrite = seenWrite
    .then(() => {
      if (owner === currentOwnerId() && generation === appState.ownerGeneration) return postJson("/api/lichess/seen", { lichess_id: lichessId });
    })
    .catch(() => {
      /* a lost ack is not worth a status line; the next probe re-evaluates */
    });
  await seenWrite;
}

// Linked Lichess identities for one-time per-action selection. `null` = not yet
// loaded; `[]` = none linked. Identity-changing actions (My last game,
// Replay compare, new-game watcher) resolve through resolveLichessAccountId():
// zero → connect flow, one → use it directly, many → compact chooser.
export function lichessAccounts() {
  const accounts = appState.lichessAccounts;
  return Array.isArray(accounts) ? accounts : [];
}

function lichessPrimaryAccount() {
  const accounts = lichessAccounts();
  return accounts.find((a) => a.is_primary) || accounts[0] || null;
}

// One-time account chooser for a single action: compact modal listing linked
// identities, Primary defaulted/highlighted, closes on select or cancel.
// Resolves to the chosen account id, or null when cancelled.
function chooseLichessAccount(actionLabel) {
  const accounts = lichessAccounts();
  const primary = lichessPrimaryAccount();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const rows = accounts
      .map(
        (account) => html`
      <button type="button" class="btn ghost account-choice${account.is_primary ? " is-primary" : ""}" data-account-id="${account.id}">
        ${account.username}${account.is_primary ? " — Primary" : ""}
      </button>`,
      );
    overlay.innerHTML = html`
      <div class="modal account-chooser" role="dialog" aria-modal="true" aria-label="${actionLabel}">
        <div class="modal-title">${actionLabel}</div>
        <div class="modal-body">
          <p class="modal-copy">Which Lichess account should this use? Primary is preselected.</p>
          <div class="account-chooser-list">${rows}</div>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const cleanup = () => overlay.remove();
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const primaryBtn = primary && overlay.querySelector(`[data-account-id="${primary.id}"]`);
    if (primaryBtn) primaryBtn.focus();
    overlay.addEventListener("click", (event) => {
      const choice = event.target.closest("[data-account-id]");
      if (choice) {
        close(choice.dataset.accountId);
        return;
      }
      if (event.target === overlay || event.target.closest('[data-action="cancel"]')) {
        close(null);
      }
    });
    document.addEventListener(
      "keydown",
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          document.removeEventListener("keydown", onKey);
          close(null);
        }
      },
      { once: false },
    );
  });
}

// Resolve which linked identity an identity-changing action should read:
// null = caller must run the connect flow first; otherwise an account id
// (single account → immediate, multiple → one-time chooser, primary default).
async function resolveLichessAccountId(actionLabel) {
  const accounts = lichessAccounts();
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0].id;
  const primary = lichessPrimaryAccount();
  const chosen = await chooseLichessAccount(actionLabel);
  return chosen || null;
}

// "My game" button: pull the newest game across ALL linked Lichess identities
// ("self") straight into the PGN box — no chooser. account_id is only for
// explicit single-account callers; the default path aggregates.

let lastOrientedPgnPlayers = "";
// Point Analyze's board at the user's side of a game they played: match either
// player name against every linked Lichess identity (plus the account the game
// came from). Leaves the orientation alone when neither side is recognisably Self.
export function orientAnalysisForSelf(white, black, extraNames = []) {
  if (!boards.analysis) return;
  // Remember the pair here: every caller (a recall, a fetched game, a paste)
  // funnels through this, so the debounced re-parse of the same names never
  // undoes a manual flip.
  lastOrientedPgnPlayers = `${white || ""}
${black || ""}`;
  const side = selfSide(white, black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
    ...extraNames,
  ]);
  if (side) boards.analysis.setOrientation(side);
}

// Which side of the Analyze game is the user ("white" | "black" | null): the PGN box's
// White/Black tags, else the recalled analysis, matched against linked Lichess names.
export function analysisSelfSide() {
  const tags = analyzeHeaderTags(document.getElementById("pgn-input")?.value || "");
  const analysis = appState.analysis || {};
  return selfSide(tags.White || analysis.white, tags.Black || analysis.black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
  ]);
}

// Same, for a PGN the user pasted or dropped: read its White/Black headers.
// Only re-orients when the pair of names changes, so the debounced re-parse on
// every keystroke never undoes a manual flip.
export function orientAnalysisFromPgn(text) {
  const { white, black } = pgnPlayers(text);
  const key = `${white}
${black}`;
  if (!white && !black) return;
  if (key === lastOrientedPgnPlayers) return;
  lastOrientedPgnPlayers = key;
  orientAnalysisForSelf(white, black);
}
