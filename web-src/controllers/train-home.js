import { html } from "../html.js";
import { countOf } from "../plural.js";
import { closeTrainPicker, openTrainPicker, trainRepertoireItems } from "../train-picker.js";
import { recentRuns } from "../train-history.js";
import { lineTail } from "../views/train.js";
// Train is one loop, Home → Session → Result, shared by the Due queue, line
// rehearsal and practice games. This module owns the loop's chrome: which
// screen is up (data-train-screen on #view-train), the Home rows and their
// pickers, the session header with its scope chip, the shared Result card, the
// board bar's action slot, and the in-Train view transitions. The sessions
// themselves run in train-session.js.

let d; // deps bound once by createTrainHome

const MODE_NAMES = { smart: "Due queue", all_lines: "Rehearse", play: "Practice" };
const BOOK_NAMES = { explorer: "Lichess explorer", maia: "Maia", repertoire: "my repertoires" };
const KIND_NAMES = { weak: "Weak spot", due: "Due review", new: "New move", polish: "Polish" };
const PREVIEW_TTL = 30000;
const preview = { key: "", at: 0, data: null, loading: null, error: false };
const ROW_ERROR_IDS = { smart: "train-due-error", all_lines: "train-rehearse-error", play: "train-play-error" };
const rowErrors = {};

// A Start that could not open its session says why in its own row.
export function trainRowError(mode, text) {
  rowErrors[mode] = text || "";
  paintRowErrors();
}

function paintRowErrors() {
  for (const [mode, id] of Object.entries(ROW_ERROR_IDS)) {
    const el = document.getElementById(id);
    const text = rowErrors[mode] || (mode === "smart" && preview.error && d.appState.signedIn ? "Couldn't load the queue. Start still works." : "");
    el.hidden = !text;
    el.textContent = text;
  }
}

export function createTrainHome(deps) {
  d = deps;
  bind();
  return { openTrain, paintTrainHome, syncTrainScreen, showTrainResult, leaveToHome };
}

// ---------------------------------------------------------------- screen

export function trainScreenOf(state) {
  const mode = state.trainMode || "smart";
  if (state.trainResult && state.trainResult.mode === mode) return "result";
  if (mode === "play") return state.play ? (state.play.active ? "session" : "result") : state.playStarting ? "session" : "home";
  if (state.trainStarting || state.smart?.prompt || state.training?.prompt || state.trainBusy && (state.smart || state.training)) return "session";
  return "home";
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Same-document View Transition around a Train screen change. Only chrome is
// named (row title ↔ header, scope chip, panel body); the board is never part
// of it, and the root snapshot does not animate (train-shell.css).
export function withTrainTransition(update, { from = null, to = null } = {}) {
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  const root = document.documentElement;
  if (from) from.style.viewTransitionName = "train-mode-title";
  root.classList.add("train-vt");
  const transition = document.startViewTransition(() => {
    if (from) from.style.viewTransitionName = "";
    update();
    const target = typeof to === "function" ? to() : to;
    if (target) target.style.viewTransitionName = "train-mode-title";
  });
  transition.ready.catch(() => {}); // skipped by a newer transition: not an error
  transition.finished.finally(() => {
    root.classList.remove("train-vt");
    if (from) from.style.viewTransitionName = "";
    const target = typeof to === "function" ? to() : to;
    if (target) target.style.viewTransitionName = "";
  });
}

export function syncTrainScreen() {
  const view = document.getElementById("view-train");
  if (!view) return;
  const state = d.appState;
  const screen = trainScreenOf(state);
  const mode = state.trainMode || "smart";
  const before = view.dataset.trainScreen;
  const apply = () => {
    view.dataset.trainScreen = screen;
    view.dataset.trainMode = mode;
    view.dataset.playBook = playBook();
    document.getElementById("train-home").hidden = screen !== "home";
    document.getElementById("train-progress-panel").hidden = screen !== "session";
    document.getElementById("train-summary").hidden = screen !== "result";
    // A finished game's move trail belongs to that game only.
    if (mode !== "play" || !state.play) document.getElementById("train-play-trail").hidden = true;
    paintHead(screen, mode);
    paintActions(screen, mode);
    if (screen === "home") void paintTrainHome();
  };
  if (!before || before === screen) {
    apply();
    return;
  }
  const head = document.getElementById("train-head-mode");
  const rowTitle = document.querySelector(`#train-home [data-vt-title="${mode}"]`);
  withTrainTransition(apply, before === "home"
    ? { from: rowTitle, to: head }
    : screen === "home" ? { from: head, to: rowTitle } : {});
}

export function trainScopeLabel(state = d.appState) {
  const mode = state.trainMode || "smart";
  if (mode === "play") {
    const play = state.play;
    if (play?.luckyReason) return luckyLabel(play);
    const book = play?.book || playBook();
    const color = (play?.userColor || playPickerColor()) === "black" ? "Black" : "White";
    return `vs ${BOOK_NAMES[book]} · ${color}`;
  }
  if (mode === "all_lines") return state.training?.repertoire_name || repertoireName(state.trainingRepertoireId) || "";
  if (state.smart) return state.smart.scopeLabel;
  return state.trainScope?.label || dueScopeLabel();
}

function luckyLabel(play) {
  const phase = play.luckyPhase || "critical";
  if (play.luckyReason === "miss") return "Engine miss";
  if (play.luckyReason === "departure") return "Left prep";
  if (play.luckyReason === "fork") return "Repertoire fork";
  if (play.luckyReason === "db-critical") return `Master game · ${phase}`;
  if (play.luckyReason === "titled-game") return `${String(play.luckySource || "").startsWith("lichess-") ? "Live Lichess game" : "Titled reference"} · ${phase}`;
  return play.luckyReason;
}

function paintHead(screen, mode) {
  document.getElementById("train-head-mode").textContent = MODE_NAMES[mode];
  document.getElementById("train-scope-chip").textContent = screen === "home" ? "" : trainScopeLabel();
  const count = document.getElementById("train-line-label");
  if (screen !== "session" || mode === "play") count.textContent = "";
}

// The board bar's action slot: buttons exist only where they work.
function paintActions(screen, mode) {
  const session = screen === "session";
  const drill = session && mode !== "play";
  const game = session && mode === "play";
  for (const id of ["train-hint", "train-skip"]) document.getElementById(id).hidden = !drill;
  for (const id of ["play-takeback", "play-resign"]) document.getElementById(id).hidden = !game;
  document.getElementById("play-analyze").hidden = !(screen === "result" && mode === "play" && d.appState.play?.history?.length);
}

// ---------------------------------------------------------------- entries

// Every way into Train lands here: nav, Library's Train, "Train this
// repertoire", a picked move, the palette. The scope is set explicitly, so a
// one-repertoire queue is never served from "all repertoires".
export async function openTrain({ mode = "smart", repertoireId = null, targets = [], autostart = true, origin = null } = {}) {
  const state = d.appState;
  if (!(await d.confirmAbandonGame(state.play, d.showConfirmModal, "Leave this game?", "Leave game"))) return;
  closeTrainPicker();
  resetSessions();
  for (const key of Object.keys(rowErrors)) rowErrors[key] = "";
  state.trainMode = mode;
  if (mode === "smart") setDueScope(repertoireId);
  if (mode === "all_lines" && repertoireId) state.trainingRepertoireId = String(repertoireId);
  if (autostart && mode !== "play") state.trainStarting = true;
  const enter = () => {
    if (state.currentView !== "train") d.switchView("train");
    syncTrainScreen();
  };
  if (origin && state.currentView !== "train") {
    withTrainTransition(enter, { from: origin, to: () => document.getElementById("train-scope-chip") });
  } else enter();
  if (!autostart) return;
  if (mode === "play") return d.startPlaySessionTracked();
  return d.startTraining(mode, { fresh: !!targets.length, repertoireId, targetNodeIds: targets });
}

function resetSessions() {
  const state = d.appState;
  state.playStartToken = (state.playStartToken || 0) + 1;
  state.playStarting = null;
  state.play = null;
  state.smart = null;
  state.training = null;
  state.trainResult = null;
  state.trainBusy = false;
  state.trainStarting = false;
  d.clearBlitzTimer();
  d.setBlitzBarVisible(false);
}

// "‹ Train": drills keep their progress (Home then offers "Resume"), a live
// game asks first.
export async function leaveToHome() {
  if (!(await d.confirmAbandonGame(d.appState.play, d.showConfirmModal, "Leave this game?", "Leave game"))) return;
  resetSessions();
  invalidateTrainPreview();
  syncTrainScreen();
  void d.resetTrainBoardIdle("");
}

// ---------------------------------------------------------------- Home

function ownActive() {
  const pending = d.appState.pendingRepDeletes || new Set();
  return (d.appState.repertoireList || []).filter((r) => r.is_active !== false && !pending.has(String(r.id)));
}

function allTrainable() {
  return [...ownActive(), ...(d.appState.sharedRepertoireList || [])];
}

function repertoireName(id) {
  return allTrainable().find((r) => String(r.id) === String(id))?.name || "";
}

function dueScopeLabel() {
  const id = d.appState.trainScope?.repertoireId;
  return id ? repertoireName(id) || "Repertoire" : "All repertoires";
}

function setDueScope(repertoireId) {
  d.appState.trainScope = { repertoireId: repertoireId ? String(repertoireId) : null };
  d.appState.trainScope.label = dueScopeLabel();
  invalidateTrainPreview();
}

export function invalidateTrainPreview() {
  preview.at = 0;
  preview.data = null;
}

function previewUrl() {
  const id = d.appState.trainScope?.repertoireId;
  const scope = id ? `repertoire_id=${encodeURIComponent(id)}` : "mixed=true";
  return `/api/train/smart/summary?${scope}&preview=true&local_date=${encodeURIComponent(d.localDateString())}&utc_offset=${-new Date().getTimezoneOffset()}`;
}

async function loadPreview() {
  const url = previewUrl();
  if (preview.key === url && Date.now() - preview.at < PREVIEW_TTL) return preview.data;
  if (preview.loading && preview.key === url) return preview.loading;
  preview.key = url;
  preview.loading = d.api(url).then((data) => {
    preview.data = data;
    preview.error = false;
    preview.at = Date.now();
    return data;
  }).catch(() => {
    preview.data = null;
    preview.error = true;
    return null;
  }).finally(() => { preview.loading = null; });
  return preview.loading;
}

// What a Start of the Due row would serve, or why it cannot. The button says
// the verb; how many cards it holds is the row's own line (dueMeta), so Resume
// does not repeat the count inside a button label.
export function dueStartState(next, { signedIn, hasRepertoire }) {
  if (!signedIn) return { label: "Sign in to train", action: "signin" };
  if (!hasRepertoire) return { label: "Open Library", action: "library" };
  if (next && Number(next.cards) === 0) return { label: "Open Repertoire", action: "build" };
  if (next?.resumed) return { label: "Resume", action: "start" };
  return { label: "Start", action: "start" };
}

// What a Start would serve. The outlook above already counts what is due, so
// this line says the one thing it cannot: how many cards the session holds.
export function dueMeta(next) {
  if (!next) return "";
  if (Number(next.cards) === 0) return "Nothing due";
  return next.resumed ? `${countOf(next.left, "card")} left` : countOf(next.cards, "card");
}

// "in 40 min", "in 5 h", "tomorrow", "in 3 days".
export function dueIn(iso, now = Date.now()) {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60000));
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

// The Due row's one figure and the two that follow it. "Due now" is what the
// row is about, so it is the figure in ink and the only one at full size; the
// two horizons behind it are a quieter line, not two more tiles beside it.
export function outlookHtml(outlook, now = Date.now()) {
  if (!outlook) return "";
  if (!outlook.now && !outlook.today && !outlook.week) {
    return outlook.next ? html`<span class="train-outlook-quiet">Nothing due · next ${dueIn(outlook.next, now)}</span>` : "";
  }
  const rest = [];
  if (Number(outlook.today) > Number(outlook.now)) rest.push(`${outlook.today} by tonight`);
  if (Number(outlook.week) > Number(outlook.today)) rest.push(`${outlook.week} this week`);
  return html`<span class="train-outlook-lead"><b>${outlook.now}</b> due now</span>${rest.length
    ? html`<span class="train-outlook-rest">${rest.join(" · ")}</span>`
    : ""}`;
}

function setChip(id, text, disabled = false) {
  const chip = document.getElementById(id);
  chip.querySelector("span").textContent = text;
  chip.disabled = disabled;
}

// The last few finished runs, as one list. Home and Result both show it.
// An empty list shows its one sentence only where one is given (Home); the
// Result card hides the list until there is an earlier run to show.
function paintRecent(el, runs, emptyText = "") {
  el.hidden = !runs.length && !emptyText;
  el.innerHTML = el.hidden ? "" : html`<span class="faint">Recent</span>${runs.length
    ? runs.map((run) => html`<div class="train-recent-row"><span>${MODE_NAMES[run.mode]}${run.blitz ? " · Blitz" : ""}</span><span class="train-recent-name">${run.repertoires.join(" · ")}</span><b>${run.summary}</b></div>`)
    : html`<span class="faint">${emptyText}</span>`}`;
}

// The first due cards, each a row that narrows the Due queue to its repertoire
// (the Start button then serves that narrowed queue).
function paintDueNext(upcoming) {
  const list = document.getElementById("train-due-next");
  const rows = upcoming || [];
  list.hidden = !rows.length;
  list.innerHTML = rows.map((row) => html`<li><button type="button" class="train-due-line" data-repertoire-id="${row.repertoire_id}" title="Narrow the due queue to ${row.repertoire_name}"><span class="un-kind">${KIND_NAMES[row.kind] || row.kind}</span><span class="train-due-rep"><span class="color-dot ${row.color === "black" ? "black" : "white"}"></span>${row.repertoire_name}</span><span class="train-due-pos">${row.line ? lineTail(row.line) : ""}</span></button></li>`).join("");
}

export async function paintTrainHome() {
  const state = d.appState;
  const signedIn = !!state.signedIn;
  const reps = allTrainable();
  paintRecent(document.getElementById("train-recent-home"), signedIn ? recentRuns(d.currentOwnerId(), 3) : [], "No finished runs yet.");
  // Due queue
  setChip("train-due-scope", dueScopeLabel(), !signedIn || !ownActive().length && !reps.length);
  const due = document.getElementById("start-train");
  const paintDue = (next) => {
    const start = dueStartState(next, { signedIn, hasRepertoire: reps.length > 0 });
    due.textContent = start.label;
    due.dataset.action = start.action;
    document.getElementById("train-due-meta").textContent = signedIn ? dueMeta(next) : "";
    paintRowErrors();
  };
  paintDue(preview.data?.next_session);
  // Rehearse
  const rehearse = state.trainingRepertoireId && reps.some((r) => String(r.id) === String(state.trainingRepertoireId))
    ? state.trainingRepertoireId : reps.find((r) => !(r.health && Number(r.health.trainable) === 0))?.id || null;
  state.trainingRepertoireId = rehearse ? String(rehearse) : null;
  const rep = reps.find((r) => String(r.id) === String(rehearse));
  setChip("train-rehearse-scope", rep ? rep.name : signedIn ? "No repertoire" : "Your repertoires", !signedIn || !reps.length);
  document.getElementById("train-rehearse-meta").textContent = rep?.health ? countOf(Number(rep.health.trainable) || 0, "move") : "";
  const rehearseBtn = document.getElementById("start-rehearse");
  rehearseBtn.textContent = !signedIn ? "Sign in to train" : rep ? "Start" : "Open Library";
  rehearseBtn.dataset.action = !signedIn ? "signin" : rep ? "start" : "library";
  // Practice
  const book = playBook();
  setChip("train-play-book", `vs ${BOOK_NAMES[book]}`);
  const repsChip = document.getElementById("train-play-reps");
  repsChip.hidden = book !== "repertoire";
  const picked = selectedTrainRepertoireIds();
  if (book === "repertoire") {
    const own = ownActive();
    setChip("train-play-reps", picked.length === own.length && own.length > 1 ? `All ${own.length}` : picked.length === 1 ? repertoireName(picked[0]) : picked.length ? `${picked.length} of ${own.length}` : "Pick repertoires");
  }
  document.getElementById("start-play").disabled = book === "repertoire" && !picked.length;
  document.getElementById("view-train").dataset.playBook = book;
  syncPlayColorLock();
  // Outlook + Due counts (network): repaint when they land.
  const outlook = document.getElementById("train-outlook");
  if (!signedIn || !reps.length) {
    outlook.hidden = true;
    paintDueNext(null);
    return;
  }
  const data = await loadPreview();
  if (trainScreenOf(state) !== "home") return;
  paintDue(data?.next_session);
  paintDueNext(data?.next_session?.upcoming);
  outlook.innerHTML = outlookHtml(data?.outlook);
  outlook.hidden = !outlook.innerHTML;
}

// ---------------------------------------------------------------- practice setup

const PLAY_BOOKS = ["explorer", "maia", "repertoire"];

function usableBooks() {
  const state = d.appState;
  const linked = state.signedIn && (!!state.lichessUsername || d.lichessAccounts().length > 0);
  return { explorer: linked, repertoire: !!state.signedIn, maia: true };
}

// The opponent the next game uses: the picked one when it can play here, else Maia.
export function playBook() {
  const want = d?.appState.playBook || "explorer";
  return usableBooks()[want] ? want : "maia";
}

export function playPickerColor() {
  const active = document.querySelector("#train-play-color .seg-btn.is-active");
  return active?.dataset.color === "black" ? "black" : "white";
}

export function setPlayPickerColor(color, { persist = true } = {}) {
  const want = color === "black" ? "black" : "white";
  if (persist) {
    try { localStorage.setItem(d.PLAY_COLOR_KEY, want); } catch (_) { /* private mode */ }
  }
  document.querySelectorAll("#train-play-color .seg-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.color === want);
  });
}

// A repertoire opponent plays the other side of your repertoires: one colour
// among the picked ones locks the colour switch to it.
function syncPlayColorLock() {
  const colors = [...new Set(playRepertoireMeta().map((rep) => (rep.color === "black" ? "black" : "white")))];
  const lock = playBook() === "repertoire" && colors.length === 1;
  if (lock) setPlayPickerColor(colors[0], { persist: false });
  else {
    try {
      const stored = localStorage.getItem(d.PLAY_COLOR_KEY);
      if (stored === "black" || stored === "white") setPlayPickerColor(stored, { persist: false });
    } catch (_) { /* private mode */ }
  }
  document.querySelectorAll("#train-play-color .seg-btn").forEach((btn) => {
    btn.disabled = lock;
    btn.title = lock ? `Locked to your ${colors[0]} repertoire` : "";
  });
}

function playRepertoireStorageKey() {
  const identity = d.appState.accountUsername || d.appState.accountUserId || "guest";
  const safe = String(identity).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_") || "guest";
  return `prepforge.play_repertoires.${safe}`;
}

function persistPlayRepertoireIds() {
  try { localStorage.setItem(playRepertoireStorageKey(), JSON.stringify(d.appState.playRepertoireIds || [])); } catch (_) { /* private mode */ }
}

export function selectedTrainRepertoireIds() {
  const active = new Set(ownActive().map((r) => String(r.id)));
  return (Array.isArray(d.appState.playRepertoireIds) ? d.appState.playRepertoireIds : []).map(String).filter((id) => active.has(id));
}

export function playRepertoireMeta(ids = selectedTrainRepertoireIds()) {
  const wanted = new Set(ids.map(String));
  return (d.appState.repertoireList || []).filter((rep) => wanted.has(String(rep.id)));
}

// The listing every row reads: own + shared repertoires, then the Home repaint.
export async function loadTrainRepertoireOptions() {
  const state = d.appState;
  if (state.signedIn) {
    try {
      const payload = await d.api("/api/repertoires");
      state.repertoireList = payload.repertoires || [];
      state.sharedRepertoireList = payload.shared || [];
    } catch (error) {
      d.setStatusError(error.message);
    }
  }
  const key = playRepertoireStorageKey();
  if (state.playRepertoirePreferenceKey !== key) {
    state.playRepertoirePreferenceKey = key;
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { /* malformed */ }
    state.playRepertoireIds = Array.isArray(stored) ? stored.map(String) : ownActive().map((r) => String(r.id));
  }
  state.playRepertoireIds = selectedTrainRepertoireIds();
  if (state.trainScope?.repertoireId && !allTrainable().some((r) => String(r.id) === state.trainScope.repertoireId)) setDueScope(null);
  syncTrainScreen();
}

// ---------------------------------------------------------------- Result

// The one Result card: cells, an optional what-changed list, one line of
// outlook, and the latest runs of any mode.
export function showTrainResult(result) {
  const state = d.appState;
  state.trainResult = result;
  document.getElementById("train-summary-title").textContent = result.title;
  document.getElementById("train-summary-stats").innerHTML =
    html`${result.cells.map(([value, label], i) => html`${i ? html`<span class="sum-sep">·</span>` : ""}<span><b>${value}</b> ${label}</span>`)}`;
  const delta = document.getElementById("train-summary-delta");
  delta.hidden = !result.delta;
  delta.innerHTML = result.delta || "";
  document.getElementById("train-summary-foot").textContent = result.foot || "";
  document.getElementById("train-summary-new").textContent = result.mode === "play" ? "Play again" : "Again";
  // The run just finished is the card above; Recent is what came before it.
  paintRecent(document.getElementById("train-recent"), recentRuns(d.currentOwnerId(), 4).filter((run) => run.id !== result.runId).slice(0, 3));
  syncTrainScreen();
}

// ---------------------------------------------------------------- wiring

function rowAction(button, start) {
  const action = button.dataset.action || "start";
  if (action === "signin") return d.requireSignIn("Sign in to start training", "train");
  if (action === "library") return d.switchView("dashboard");
  if (action === "build") return d.switchView("build");
  return start();
}

function bind() {
  const $ = (id) => document.getElementById(id);
  $("start-train").addEventListener("click", (e) => rowAction(e.currentTarget, () =>
    openTrain({ mode: "smart", repertoireId: d.appState.trainScope?.repertoireId || null })));
  $("start-rehearse").addEventListener("click", (e) => rowAction(e.currentTarget, () =>
    openTrain({ mode: "all_lines", repertoireId: d.appState.trainingRepertoireId })));
  $("start-play").addEventListener("click", () => openTrain({ mode: "play" }));
  $("train-due-next").addEventListener("click", (e) => {
    const line = e.target.closest(".train-due-line");
    if (!line) return;
    setDueScope(line.dataset.repertoireId);
    void paintTrainHome();
  });
  $("feeling-lucky").addEventListener("click", async () => {
    await openTrain({ mode: "play", autostart: false });
    void d.onFeelingLucky();
  });
  $("train-back").addEventListener("click", () => void leaveToHome());
  $("train-summary-home").addEventListener("click", () => void leaveToHome());
  $("train-summary-new").addEventListener("click", () => {
    const mode = d.appState.trainMode || "smart";
    const repertoireId = mode === "smart" ? d.appState.trainScope?.repertoireId : d.appState.trainingRepertoireId;
    void openTrain({ mode, repertoireId });
  });
  $("train-due-scope").addEventListener("click", (e) => openTrainPicker(e.currentTarget, {
    label: "Due queue from",
    items: [{ id: "", label: "All repertoires" }, ...trainRepertoireItems(d.appState)],
    selected: [d.appState.trainScope?.repertoireId || ""],
    onChange: ([id]) => { setDueScope(id || null); void paintTrainHome(); },
  }));
  $("train-rehearse-scope").addEventListener("click", (e) => openTrainPicker(e.currentTarget, {
    label: "Rehearse",
    items: trainRepertoireItems(d.appState),
    selected: [d.appState.trainingRepertoireId || ""],
    onChange: ([id]) => { d.appState.trainingRepertoireId = id; void paintTrainHome(); },
  }));
  $("train-play-book").addEventListener("click", (e) => {
    const usable = usableBooks();
    openTrainPicker(e.currentTarget, {
      label: "Opponent",
      items: PLAY_BOOKS.map((id) => ({
        id, label: BOOK_NAMES[id][0].toUpperCase() + BOOK_NAMES[id].slice(1), disabled: !usable[id],
        sub: usable[id] ? "" : id === "explorer" ? "Link Lichess in Settings" : "Sign in",
      })),
      selected: [playBook()],
      onChange: ([id]) => { d.appState.playBook = id; void paintTrainHome(); },
    });
  });
  $("train-play-reps").addEventListener("click", (e) => openTrainPicker(e.currentTarget, {
    label: "Opponent plays from",
    items: trainRepertoireItems(d.appState, { shared: false }),
    selected: selectedTrainRepertoireIds(),
    multi: true,
    onChange: (ids) => { d.appState.playRepertoireIds = ids; persistPlayRepertoireIds(); void paintTrainHome(); },
  }));
  document.querySelectorAll("#train-play-color .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => { if (!btn.disabled) setPlayPickerColor(btn.dataset.color); });
  });
  try {
    if (localStorage.getItem(d.PLAY_COLOR_KEY) === "black") setPlayPickerColor("black", { persist: false });
  } catch (_) { /* private mode */ }
  $("train-blitz-toggle").addEventListener("click", (e) => {
    const next = !d.blitzEnabled();
    d.setBlitzEnabled(next);
    e.currentTarget.classList.toggle("is-on", next);
    e.currentTarget.setAttribute("aria-checked", String(next));
  });
  $("train-blitz-toggle").classList.toggle("is-on", d.blitzEnabled());
  $("train-blitz-toggle").setAttribute("aria-checked", String(d.blitzEnabled()));
  $("train-history-open").addEventListener("click", async () => {
    if (!d.requireSignIn("Sign in to view your training history", "train-history")) return;
    const owner = d.currentOwnerId();
    try {
      const { openTrainingHistory } = await import("../views/train-history.js");
      if (d.currentOwnerId() === owner) openTrainingHistory(owner);
    } catch { d.setStatusError("Could not open History. Reload and try again."); }
  });
  $("train-hint").addEventListener("click", () => d.trainHint());
  $("train-skip").addEventListener("click", () => d.skipTrainingLine());
  $("play-takeback").addEventListener("click", () => d.takebackPlaySession());
  $("play-resign").addEventListener("click", () => d.resignPlaySession());
  $("play-analyze").addEventListener("click", () => d.openPlayInAnalyze());
}
