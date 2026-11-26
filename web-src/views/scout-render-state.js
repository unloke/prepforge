import { html } from "../html.js";

// What a rebuild of a Scout panel would otherwise lose. Every enrichment step
// (Stockfish, Maia, explorer, aggregation) redraws the report from markup, so the
// control a keyboard user was on went back to <body>, and a first-move drill-down
// snapped back to the root list.

// Elements a focused control is located by: stable across a rebuild of the same report.
const ANCHORS = "[data-line-key], [data-scout-tab], [data-first-uci], [id]";
const FOCUSABLE = "button, a[href], [tabindex], input, select, textarea";

function anchorOf(el, root) {
  const anchor = el.closest?.(ANCHORS);
  return anchor && anchor !== root && root.contains?.(anchor) ? anchor : root;
}

function anchorKey(el, root) {
  if (el === root) return "";
  const color = el.closest?.("[data-scout-color]")?.dataset?.scoutColor || el.dataset?.color || "";
  const { lineKey = "", scoutTab = "", firstUci = "" } = el.dataset || {};
  return `${color}|${lineKey}|${scoutTab}|${firstUci}|${el.id || ""}`;
}

function focusables(anchor) {
  return [anchor, ...(anchor.querySelectorAll?.(FOCUSABLE) || [])];
}

// Same kind of control in the same place; a rebuilt row may hold other controls.
const signature = (el) => `${el?.tagName || ""}|${el?.className || ""}`;

/** The focused control inside `root` (if any) and each section's drilled first move. */
export function captureScoutViewState(root, active = globalThis.document?.activeElement) {
  if (!root) return null;
  const drills = [...(root.querySelectorAll?.("[data-dist-root][data-drill-uci]") || [])].map((col) => ({
    color: col.closest?.("[data-scout-color]")?.dataset?.scoutColor, uci: col.dataset.drillUci,
  }));
  let focus = null;
  if (active && active !== root && root.contains?.(active)) {
    const anchor = anchorOf(active, root);
    focus = { key: anchorKey(anchor, root), index: focusables(anchor).indexOf(active), sig: signature(active) };
  }
  // The side panel is one line's detail: its focus only comes back to the same line.
  return { focus, drills, lineKey: root.dataset?.lineKey };
}

/**
 * Puts back what captureScoutViewState saw, after `root` was rebuilt. `redrill(row,
 * sectionEl, color)` redraws one drill-down from its root move row.
 */
export function restoreScoutViewState(root, captured, { redrill = null } = {}) {
  if (!root || !captured) return;
  for (const { color, uci } of captured.drills) {
    const section = [...(root.querySelectorAll?.(".scout-section[data-scout-color]") || [])]
      .find((el) => el.dataset.scoutColor === color);
    const row = [...(section?.querySelectorAll?.("[data-dist-root] [data-first-uci]") || [])]
      .find((el) => el.dataset.firstUci === uci);
    if (row && redrill) redrill(row, section, color);
  }
  const { focus } = captured;
  if (!focus || focus.index < 0 || root.dataset?.lineKey !== captured.lineKey) return;
  const anchor = focus.key
    ? [...(root.querySelectorAll?.(ANCHORS) || [])].find((el) => anchorKey(el, root) === focus.key)
    : root;
  const target = anchor ? focusables(anchor)[focus.index] : null;
  if (target && signature(target) === focus.sig) target.focus?.({ preventScroll: true });
}

// The Stockfish read failed: the plan falls back to game results alone. The
// report says so and offers the read again, like the Maia and explorer notes.
export function scoutPrefilterFailedNoteHtml(failed) {
  if (!failed) return "";
  return html`<p class="scout-ranked-note muted hint" id="scout-prefilter-failed" role="status">Stockfish couldn't rank these lines, so the plan uses game results only. <button type="button" class="btn sm ghost" data-scout-retry-prefilter>Retry</button></p>`;
}
