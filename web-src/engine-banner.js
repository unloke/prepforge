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
  return {
    visible: true,
    title: ENGINE_BANNER_TITLE,
    why,
    action,
  };
}

export function engineBannerHtml(model) {
  if (!model || !model.visible) return "";
  // The action carries its whole sentence in a tooltip: Build shows it on one
  // line, where the tail ("there is no server fallback") is cut off by the
  // panel's width. Analyze reads it in full and never sees the tooltip.
  return (
    html`<div class="engine-banner-title">${model.title}</div><p class="engine-banner-why">${model.why}</p><p class="engine-banner-action" title="${model.action}">${model.action}</p>`
  );
}
