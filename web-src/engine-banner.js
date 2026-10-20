import { html } from "./html.js";
// Engine-unavailable banner model. Analyze and Build engine actions use this
// instead of failing silently when browser Stockfish cannot run.

export const ENGINE_BANNER_TITLE = "Browser engine unavailable";

export function engineUnavailableBanner({
  available = false,
  isolated = false,
  reason = "",
} = {}) {
  if (available) {
    return {
      visible: false,
      title: "",
      why: "",
      action: "",
      brief: "",
    };
  }
  const why = reason
    ? String(reason)
    : isolated
      ? "The local Stockfish engine could not start in this browser."
      : "This page is not cross-origin isolated (COOP/COEP required), so browser Stockfish cannot run.";
  const action = isolated
    ? "Reload the page, or try Chrome or Edge. Analysis always runs on your device — there is no server fallback."
    : "Open PrepForge in Chrome or Edge (a browser that keeps COOP/COEP isolation). Analysis always runs on your device — there is no server fallback.";
  // The same state cut to something that fits a panel one line wide and still
  // reads as a sentence: Build has no room for the full fix beside the board.
  const brief = isolated ? "Reload, or open in Chrome or Edge" : "Open in Chrome or Edge";
  return {
    visible: true,
    title: ENGINE_BANNER_TITLE,
    why,
    action,
    brief,
  };
}

export function engineBannerHtml(model) {
  if (!model || !model.visible) return "";
  // The short form and the long one are both in the markup. Build shows the
  // short one and puts the long one in a tooltip; Analyze prints the long one
  // and has no use for the tooltip (its CSS keeps the brief out of the flow).
  return (
    html`<div class="engine-banner-title">${model.title}</div><p class="engine-banner-why">${model.why}</p><p class="engine-banner-action" title="${model.action}">${model.action}</p><span class="engine-banner-brief" title="${model.action}">${model.brief}</span>`
  );
}
