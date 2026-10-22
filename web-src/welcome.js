import { html } from "./html.js";
import { activateModal } from "./core/modals.js";
import { appState } from "./core/state.js";
import { hooks } from "./core/hooks.js";
import { maiaAnalysisEnabled, setPref } from "./core/prefs.js";
import { fetchLichessProfile } from "./lichess-profile.js";
import { downloadState, formatMB, startDownload } from "./engine/engine-downloads.js";
import { ENGINE_NAMES } from "./engine-unlock.js";
import "./welcome.css";

// First visit, signed in or not: three short questions, every one skippable,
// then the page the answer points at. It is shown once per browser.
export const WELCOME_KEY = "prepforge.welcome";

export function shouldWelcome({ storage = globalThis.localStorage, location = globalThis.location, navigator = globalThis.navigator } = {}) {
  try {
    if (storage.getItem(WELCOME_KEY)) return false;
  } catch {
    return false;
  }
  // An automated browser (the smokes) starts where it asked to.
  if (navigator?.webdriver) return false;
  // A link that came with work (share, join, reset, billing, OAuth) or a route of
  // its own lands there instead.
  if (location.search) return false;
  return /^#?\/?(dashboard)?$/.test(location.hash || "");
}

const ICONS = {
  analyze: html`<path d="M4 18l5-6 4 3 7-9"/>`,
  build: html`<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6.5c5 0 4 5.5 8 5.5"/>`,
  practice: html`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>`,
};
export const WELCOME_GOALS = [
  { id: "analyze", label: "Analyze a game", engines: ["stockfish"] },
  { id: "build", label: "Build an opening repertoire", engines: ["stockfish"] },
  { id: "practice", label: "Practice against a bot", engines: ["maia"] },
];
export const WELCOME_RATINGS = [800, 1200, 1600, 2000, 2400];
const GAINS = {
  maia: "A bot and coach that play like people at your rating",
  stockfish: "Deeper evaluations and sharper best lines",
};

// The engines worth offering, the goal's first: one already here or one this
// device cannot hold is not a choice.
export function offeredEngines(goal, state = downloadState) {
  const first = WELCOME_GOALS.find((g) => g.id === goal)?.engines || [];
  return [...first, ...["maia", "stockfish"].filter((id) => !first.includes(id))]
    .map((id) => ({ id, state: state(id) }))
    .filter(({ state: s }) => s.phase !== "unsupported" && s.phase !== "ready");
}

// The downloads ticked by default: the goal's own engine, unless the browser is
// on a metered connection, where nothing large is picked for the user.
export function defaultPicks(goal, connection = globalThis.navigator?.connection) {
  if (connection?.saveData || connection?.type === "cellular") return new Set();
  return new Set(WELCOME_GOALS.find((g) => g.id === goal)?.engines || []);
}

export function openWelcome({ hasLichess = () => false, setLichessUsername = () => {}, pinRating = () => {}, go = () => {}, storage = globalThis.localStorage } = {}) {
  // Linked accounts can land after the dialog opens, so the level step is
  // decided again when the first answer is in.
  const stepsNow = () => (hasLichess() ? ["goal", "engines"] : ["goal", "level", "engines"]);
  let steps = stepsNow();
  const answers = { goal: null, lichess: null, rating: null, picks: new Set() };
  let at = 0;
  let lookup = 0;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay welcome-overlay";
  overlay.innerHTML = html`<div class="modal welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" data-testid="welcome"></div>`;
  const dialog = overlay.firstElementChild;
  document.body.appendChild(overlay);
  const release = activateModal(overlay);

  const remember = () => { try { storage.setItem(WELCOME_KEY, "done"); } catch { /* shown again next visit */ } };
  function close() {
    remember();
    document.removeEventListener("keydown", onKey);
    release();
    overlay.remove();
  }
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  }
  document.addEventListener("keydown", onKey);

  function head(title) {
    return html`<header class="welcome-head"><span class="welcome-count">${at + 1} of ${steps.length}</span><button type="button" class="btn ghost sm welcome-skip" data-welcome="skip" data-testid="welcome-skip">Skip</button></header><h2 class="modal-title" id="welcome-title">${title}</h2>`;
  }

  function goalStep() {
    return html`${head("What do you want to do first?")}<div class="modal-body welcome-goals">${WELCOME_GOALS.map((g) => html`<button type="button" class="welcome-goal" data-goal="${g.id}" data-testid="welcome-goal-${g.id}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[g.id]}</svg><span>${g.label}</span><svg class="welcome-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`)}</div>`;
  }

  function levelStep() {
    const found = answers.lichess;
    return html`${head("Your level")}<div class="modal-body"><form class="welcome-find" data-welcome="find"><label class="modal-field"><span>Lichess username</span><span class="welcome-find-row"><input type="text" name="lichess" autocomplete="username" autocapitalize="off" spellcheck="false" value="${found?.username || ""}" data-testid="welcome-lichess" /><button type="submit" class="btn">Find</button></span></label></form><p class="welcome-found" data-testid="welcome-found" aria-live="polite">${found?.maiaRating ? html`<b>${found.username}</b> · ${found.ratingPerf ? `${found.ratingPerf[0].toUpperCase()}${found.ratingPerf.slice(1)} ` : ""}${found.maiaRating}` : found?.error || ""}</p><div class="modal-field"><span id="welcome-rating-label">Or pick a rating</span><div class="seg welcome-ratings" role="group" aria-labelledby="welcome-rating-label">${WELCOME_RATINGS.map((r) => html`<button type="button" class="seg-btn${answers.rating === r ? " is-active" : ""}" data-rating="${r}" aria-pressed="${answers.rating === r}">${r === 2400 ? "2400+" : r}</button>`)}</div></div></div><footer class="modal-footer"><button type="button" class="btn ghost" data-welcome="back">Back</button><button type="button" class="btn primary" data-welcome="next" data-testid="welcome-next">${found?.maiaRating || answers.rating ? "Next" : "Not now"}</button></footer>`;
  }

  function enginesStep() {
    const offered = offeredEngines(answers.goal);
    const total = offered.filter(({ id }) => answers.picks.has(id)).reduce((sum, { state }) => sum + state.bytes, 0);
    const rows = offered.length
      ? offered.map(({ id, state }) => html`<label class="welcome-engine" data-testid="welcome-engine-${id}"><input type="checkbox" value="${id}"${answers.picks.has(id) ? " checked" : ""} /><span class="welcome-engine-text"><b>${ENGINE_NAMES[id]}</b><span>${GAINS[id]}</span></span><span class="welcome-size">${formatMB(state.bytes)}</span></label>`)
      : html`<p class="welcome-found">Both are already in this browser.</p>`;
    const action = total ? html`Download ${formatMB(total)} and start` : "Start";
    return html`${head("Local engines")}<div class="modal-body"><div class="welcome-engines">${rows}</div><p class="welcome-wifi" data-testid="welcome-wifi"${total ? "" : " hidden"}>Best on Wi-Fi. Kept in this browser; remove them any time in Settings.</p></div><footer class="modal-footer"><button type="button" class="btn ghost" data-welcome="back">Back</button><button type="button" class="btn primary" data-welcome="finish" data-testid="welcome-finish">${action}</button></footer>`;
  }

  function paint() {
    const step = steps[at];
    dialog.dataset.step = step;
    dialog.innerHTML = step === "goal" ? goalStep() : step === "level" ? levelStep() : enginesStep();
    (dialog.querySelector(step === "level" ? "input" : ".welcome-goal, input, [data-welcome='finish']") || dialog).focus?.();
  }

  async function find(name) {
    const ticket = ++lookup;
    answers.lichess = { username: name, error: "Looking up…" };
    paint();
    try {
      const profile = await fetchLichessProfile(name);
      if (ticket !== lookup) return;
      answers.lichess = profile.maiaRating ? profile : { username: name, error: "No rated games on this account yet." };
      if (profile.maiaRating) answers.rating = null;
    } catch (error) {
      if (ticket !== lookup) return;
      answers.lichess = { username: name, error: error?.status === 404 ? "No Lichess account by that name." : "Lichess did not answer. Pick a rating instead." };
    }
    paint();
  }

  function saveLevel() {
    if (answers.lichess?.maiaRating) setLichessUsername(answers.lichess.username);
    else if (answers.rating) pinRating(answers.rating);
  }

  function finish() {
    for (const id of answers.picks) {
      void startDownload(id).then((s) => {
        // Maia asked for here is for the coach too: the analysis layer takes it.
        if (id === "maia" && s.phase === "ready" && !maiaAnalysisEnabled()) setPref("maiaAnalysis", true);
      });
    }
    close();
    go(answers.goal);
  }

  dialog.addEventListener("click", (event) => {
    const goal = event.target.closest("[data-goal]");
    if (goal) {
      answers.goal = goal.dataset.goal;
      answers.picks = defaultPicks(answers.goal);
      steps = stepsNow();
      at++;
      paint();
      return;
    }
    const rating = event.target.closest("[data-rating]");
    if (rating) {
      const value = Number(rating.dataset.rating);
      answers.rating = answers.rating === value ? null : value;
      if (answers.rating) answers.lichess = null;
      paint();
      return;
    }
    const act = event.target.closest("[data-welcome]")?.dataset.welcome;
    if (act === "skip") close();
    else if (act === "back") { at = Math.max(0, at - 1); paint(); }
    else if (act === "next") { saveLevel(); at++; paint(); }
    else if (act === "finish") finish();
  });
  dialog.addEventListener("change", (event) => {
    const box = event.target.closest(".welcome-engine input");
    if (!box) return;
    if (box.checked) answers.picks.add(box.value);
    else answers.picks.delete(box.value);
    paint();
    dialog.querySelector(`.welcome-engine input[value="${box.value}"]`)?.focus();
  });
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = String(new FormData(event.target).get("lichess") || "").trim();
    if (name) void find(name);
  });

  paint();
  return { close };
}

// The shell's entry: the welcome with this app's own doors.
export function maybeWelcome({ switchView, setLichessUsername, lichessAccounts, saveSettings }) {
  if (!shouldWelcome()) return null;
  return openWelcome({
    hasLichess: () => !!appState.lichessUsername || (lichessAccounts() || []).length > 0,
    setLichessUsername,
    pinRating(rating) {
      appState.maiaRatingPinned = rating;
      hooks.strengthPainted?.();
      if (appState.signedIn) void saveSettings({ maia_rating: rating }).catch(() => {});
      else setPref("maiaRating", rating);
    },
    go(goal) {
      // Practice is a row on Train Home.
      switchView(goal === "practice" ? "train" : goal);
    },
  });
}
