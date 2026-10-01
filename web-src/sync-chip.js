// Google-Docs style save chip shown under the Repertoire and Train boards.
const SYNC_CHIP_VARIANTS = {
  saved: { cls: "is-saved", text: "✓ Saved" },
  dirty: { cls: "is-dirty", text: "• Unsaved changes" },
  syncing: { cls: "is-syncing", text: "↻ Saving…" },
  error: { cls: "is-error", text: "⚠ Offline — will retry" },
  rejected: { cls: "is-error", text: "⚠ Some attempts couldn't be saved" },
  // R-01/R-04: unconfirmed work is never claimed as Saved. These two states
  // say WHY nothing is moving: waiting for sign-in vs a stale-edit conflict.
  blocked: { cls: "is-error", text: "⚠ Waiting for sign-in — edits kept" },
  conflict: { cls: "is-error", text: "⚠ Changed elsewhere — draft kept" },
};

// On Train the chip tracks graded attempts, not repertoire edits; "Unsaved
// changes" there left users wondering what they had changed (UX walkthrough
// 2026-10-01 P2-7).
const TRAINING_TEXT = {
  saved: "✓ Progress saved",
  dirty: "• Saving progress soon",
  syncing: "↻ Saving progress…",
  blocked: "⚠ Waiting for sign-in — progress kept",
};

export function syncChipVariant(state, scope = "repertoire") {
  const base = SYNC_CHIP_VARIANTS[state] || SYNC_CHIP_VARIANTS.saved;
  if (scope !== "training") return base;
  const key = SYNC_CHIP_VARIANTS[state] ? state : "saved";
  return TRAINING_TEXT[key] ? { ...base, text: TRAINING_TEXT[key] } : base;
}
