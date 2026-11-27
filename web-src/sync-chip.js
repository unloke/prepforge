// Google-Docs style save chip shown under the Repertoire and Train boards.
import { buildState, trainState } from "./core/state.js";
import { hooks } from "./core/hooks.js";

const SYNC_CHIP_VARIANTS = {
  saved: { cls: "is-saved", text: "Saved" },
  dirty: { cls: "is-syncing", text: "Saving…" },
  syncing: { cls: "is-syncing", text: "Saving…" },
  error: { cls: "is-error", text: "Offline — will retry" },
  rejected: { cls: "is-error", text: "Some attempts couldn't be saved" },
  // R-01/R-04: unconfirmed work is never claimed as Saved.
  blocked: { cls: "is-error", text: "Waiting for sign-in — edits kept" },
};

// On Train the chip tracks graded attempts, not repertoire edits; "Unsaved
// changes" there left users wondering what they had changed (UX walkthrough
// 2026-10-01 P2-7). The debounce between answers is the usual state, so it
// says nothing: the chip only speaks while a save is on the wire or waiting.
const TRAINING_TEXT = {
  saved: "Progress saved",
  dirty: "",
  syncing: "Saving progress…",
  blocked: "Waiting for sign-in — progress kept",
};

// The training states that have something to say (see TRAINING_TEXT).
export const TRAINING_SYNC_TEXT = Object.keys(TRAINING_TEXT).filter((key) => TRAINING_TEXT[key]);

export function syncChipVariant(state, scope = "repertoire") {
  const base = SYNC_CHIP_VARIANTS[state] || SYNC_CHIP_VARIANTS.saved;
  if (scope !== "training") return base;
  const key = SYNC_CHIP_VARIANTS[state] ? state : "saved";
  return { ...base, text: TRAINING_TEXT[key] ?? base.text };
}

export function renderSyncChip(el, state, scope = "repertoire") {
  const v = syncChipVariant(state, scope);
  el.hidden = false;
  el.className = `build-sync ${v.cls}`;
  el.textContent = v.text;
  el.title = state === "blocked" ? `${v.text} — click to sign in` : v.text;
  // Only the blocked chip acts (it opens sign-in), so only it is a keyboard stop.
  if (state === "blocked") {
    el.setAttribute?.("role", "button");
    el.tabIndex = 0;
  } else {
    el.removeAttribute?.("role");
    el.removeAttribute?.("tabindex");
  }
  if (el.dataset && !el.dataset.authBound && typeof el.addEventListener === "function") {
    el.dataset.authBound = "true";
    const signIn = () => {
      const current = scope === "training" ? trainState.trainSyncState : buildState.buildSyncState;
      if (current === "blocked") hooks.authRequired?.();
    };
    el.addEventListener("click", signIn);
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      signIn();
    });
  }
}
