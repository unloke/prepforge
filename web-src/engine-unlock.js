import { html } from "./html.js";
import { maiaAnalysisEnabled, setPref } from "./core/prefs.js";
import { downloadState, formatMB, startDownload, subscribeDownloads } from "./engine/engine-downloads.js";
import "./engine-unlock.css";

// One compact row wherever a local engine would make a feature better and this
// browser does not have it yet: what it adds here, its size, one tap to fetch it
// with progress, and the feature takes it in place once it lands. A row can be put
// away per place; a download already running still shows its progress there.
// Slots are plain elements carrying data-unlock-place; paintUnlocks fills them.
export const UNLOCK_PLACES = {
  "engine-analyze": { engine: "stockfish", gain: "Deeper evaluations and sharper best lines" },
  "engine-build": { engine: "stockfish", gain: "Stronger evals beside every candidate move" },
  "analyze-coach": { engine: "maia", gain: "What players at your rating would play", enable: true },
  scout: { engine: "maia", gain: "Rank their lines by where a player at their rating goes wrong", enable: true },
  "train-practice": { engine: "maia", gain: "A practice bot that plays like a human at your rating" },
  "build-coverage": { engine: "maia", gain: "Find the replies players at your rating actually choose" },
};
export const ENGINE_NAMES = { stockfish: "Full Stockfish", maia: "Maia 3" };

const DISMISS_KEY = "prepforge.unlock-dismissed";
// Places where this page's user tapped Download: their progress and errors stay
// up there even if the row had been put away before.
const asked = new Set();

function dismissedPlaces(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage.getItem(DISMISS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

export function dismissUnlock(place, storage = globalThis.localStorage) {
  const places = dismissedPlaces(storage);
  places.add(place);
  try { storage.setItem(DISMISS_KEY, JSON.stringify([...places])); } catch { /* this page only */ }
  asked.delete(place);
  paintUnlocks();
}

// What a place shows now: null for nothing, else the row's mode and the engine state.
export function unlockView(place, { state = downloadState, enabled = maiaAnalysisEnabled, dismissed = dismissedPlaces() } = {}) {
  const config = UNLOCK_PLACES[place];
  if (!config) return null;
  const s = state(config.engine);
  const away = dismissed.has(place) && !asked.has(place);
  if (s.phase === "checking" || s.phase === "unsupported") return null;
  if (s.phase === "ready") return config.enable && !enabled() && !away ? { mode: "enable", state: s } : null;
  if (s.phase === "downloading") return away ? null : { mode: "progress", state: s };
  if (s.phase === "error") return away ? null : { mode: "error", state: s };
  return away ? null : { mode: "offer", state: s };
}

function percent(fraction) {
  return fraction == null ? null : Math.round(fraction * 100);
}

export function unlockHtml(place, view, { inline = false } = {}) {
  const { engine, gain } = UNLOCK_PLACES[place];
  const { mode, state } = view;
  const cls = inline ? "unlock is-inline" : "unlock";
  const name = ENGINE_NAMES[engine];
  const size = formatMB(state.bytes);
  const close = html`<button type="button" class="unlock-x" data-unlock-act="dismiss" aria-label="Not now" title="Not now"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>`;
  if (mode === "progress") {
    const pct = percent(state.fraction);
    const line = pct == null ? `Preparing · ${size}` : pct >= 100 ? "Starting…" : `Downloading · ${pct}% of ${size}`;
    return html`<div class="${cls}" data-mode="progress" data-engine="${engine}"><span class="unlock-text"><b>${name}</b><span class="unlock-line" aria-live="polite">${line}</span></span><span class="unlock-bar${pct == null ? " is-busy" : ""}" role="progressbar" aria-label="${name} download" aria-valuemin="0" aria-valuemax="100"${pct == null ? "" : html` aria-valuenow="${pct}"`}><i style="width:${pct == null ? 0 : pct}%"></i></span></div>`;
  }
  if (mode === "error") {
    return html`<div class="${cls}" data-mode="error" data-engine="${engine}"><span class="unlock-text"><b>${name}</b><span class="unlock-line" role="alert">${state.error}</span></span><button type="button" class="btn sm" data-unlock-act="get">Retry</button>${close}</div>`;
  }
  const action = mode === "enable" ? "Turn on" : html`Download <span class="unlock-size">${size}</span>`;
  // What the engine adds is the row's tooltip, not a standing line beside the button.
  return html`<div class="${cls}" data-mode="${mode}" data-engine="${engine}" title="${gain}"><span class="unlock-text"><b>${name}</b></span><button type="button" class="btn sm primary" data-unlock-act="get" data-testid="unlock-get-${place}">${action}</button>${close}</div>`;
}

// Fill every slot under `root`. A slot whose row did not change mode only moves
// its progress, so a download ticking along does not rebuild the row.
export function paintUnlocks(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const dismissed = dismissedPlaces();
  for (const slot of root.querySelectorAll("[data-unlock-place]")) {
    const place = slot.dataset.unlockPlace;
    const view = unlockView(place, { dismissed });
    if (!view) {
      slot.hidden = true;
      if (slot.unlockMarkup) slot.innerHTML = slot.unlockMarkup = "";
      continue;
    }
    slot.hidden = false;
    const row = slot.firstElementChild;
    const pct = percent(view.state.fraction);
    if (view.mode === "progress" && row?.dataset.mode === "progress" && row.dataset.engine === UNLOCK_PLACES[place].engine && pct != null && !row.querySelector(".is-busy")) {
      row.querySelector(".unlock-bar i").style.width = `${pct}%`;
      row.querySelector(".unlock-bar").setAttribute("aria-valuenow", String(pct));
      slot.unlockMarkup = null;
      row.querySelector(".unlock-line").textContent = pct >= 100 ? "Starting…" : `Downloading · ${pct}% of ${formatMB(view.state.bytes)}`;
      continue;
    }
    const markup = String(unlockHtml(place, view, { inline: slot.dataset.unlockStyle === "inline" }));
    if (slot.unlockMarkup !== markup) slot.innerHTML = slot.unlockMarkup = markup;
  }
}

async function unlock(place) {
  const { engine, enable } = UNLOCK_PLACES[place];
  asked.add(place);
  const s = downloadState(engine);
  const result = s.phase === "ready" ? s : await startDownload(engine);
  // An analysis layer takes the model as soon as it is here: the pref change
  // repaints the views that read it (see hooks.prefApplied).
  if (result.phase === "ready" && enable && !maiaAnalysisEnabled()) setPref("maiaAnalysis", true);
  if (result.phase === "ready") asked.delete(place);
  paintUnlocks();
}

let bound = false;
export function bindUnlocks(doc = globalThis.document) {
  if (bound || !doc) return;
  bound = true;
  doc.addEventListener("click", (event) => {
    const act = event.target.closest?.("[data-unlock-act]");
    const slot = act?.closest("[data-unlock-place]");
    if (!slot) return;
    const place = slot.dataset.unlockPlace;
    if (act.dataset.unlockAct === "dismiss") dismissUnlock(place);
    else void unlock(place);
  });
  subscribeDownloads(() => paintUnlocks(doc));
  paintUnlocks(doc);
}
