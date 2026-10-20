import { html } from "../html.js";

// The full net is 94 MB, so the engine card asks before fetching it. The
// question is one row in the card's own list; the answer button is the same
// action Settings keeps after a "keep lite".
export function engineConsentHtml(choice) {
  return html`<div class="engine-consent" data-testid="engine-full-choice">
    <span>${choice === "ask" ? "Download the full engine?" : "Full engine"}</span>
    <span class="engine-consent-actions">
      <button type="button" class="btn sm primary" data-choice="yes">Download (94 MB)</button>
      ${choice === "ask" ? html`<button type="button" class="btn sm ghost" data-choice="no">Keep lite</button>` : ""}
    </span>
  </div>`;
}
